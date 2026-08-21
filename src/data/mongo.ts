import { MongoClient, type Db } from 'mongodb';

/**
 * How long a service-call nonce is remembered.
 *
 * Lives here rather than with the auth code because it is the TTL on an index below, and
 * the auth module already imports this one. It must exceed the clock skew the verifier
 * allows: forget a nonce sooner than a request may legitimately arrive, and replays
 * quietly become possible again.
 */
export const NONCE_TTL_SECONDS = 900;

/**
 * A single pooled client, cached across hot reloads in development so that each
 * edit does not open another pool.
 */

const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const dbName = process.env.MONGODB_DB ?? 'dns_pricing';

declare global {
  // eslint-disable-next-line no-var
  var __dnsPricingMongo: { client: MongoClient; promise: Promise<MongoClient> } | undefined;
}

function client(): Promise<MongoClient> {
  if (!global.__dnsPricingMongo) {
    const instance = new MongoClient(uri, { retryWrites: true });
    global.__dnsPricingMongo = { client: instance, promise: instance.connect() };
  }
  return global.__dnsPricingMongo.promise;
}

export async function db(): Promise<Db> {
  return (await client()).db(dbName);
}

export const COLLECTIONS = {
  users: 'users',
  rateCards: 'rateCards',
  rateCardVersions: 'rateCardVersions',
  changeRequests: 'changeRequests',
  pincodes: 'pincodes',
  auditLog: 'auditLog',
  customers: 'customers',
  contractProposals: 'contractProposals',
  bookingExceptions: 'bookingExceptions',
  rateTemplates: 'rateTemplates',
  products: 'products',
  offers: 'offers',
  ledger: 'ledger',
  invoices: 'invoices',
  settlementProfiles: 'settlementProfiles',
  shipments: 'shipments',
  quotes: 'quotes',
  serviceNonces: 'serviceNonces',
  corePushes: 'corePushes',
  customerProfileChanges: 'customerProfileChanges',
  contractRequests: 'contractRequests',
  carriers: 'carriers',
  services: 'services',
  invoiceSeries: 'invoiceSeries',
  receipts: 'receipts',
  billingPeriods: 'billingPeriods',
  reconciliation: 'reconciliation',
} as const;

/**
 * Indexes the application relies on. Called by the seed script and safe to re-run:
 * createIndex is idempotent for an unchanged definition.
 */
export async function ensureIndexes(): Promise<void> {
  const database = await db();

  await database.collection(COLLECTIONS.users).createIndex({ email: 1 }, { unique: true });
  await database.collection(COLLECTIONS.rateCards).createIndex({ key: 1 }, { unique: true });
  await database
    .collection(COLLECTIONS.rateCardVersions)
    .createIndex({ rateCardId: 1, version: -1 });
  await database.collection(COLLECTIONS.rateCardVersions).createIndex({ rateCardId: 1, state: 1 });
  await database.collection(COLLECTIONS.changeRequests).createIndex({ status: 1, submittedAt: -1 });
  await database.collection(COLLECTIONS.changeRequests).createIndex({ rateCardId: 1 });
  // The pincode lookup is on the hot path of every quote.
  await database.collection(COLLECTIONS.pincodes).createIndex({ pincode: 1 }, { unique: true });
  await database.collection(COLLECTIONS.pincodes).createIndex({ state: 1 });
  await database.collection(COLLECTIONS.pincodes).createIndex({ 'surface.zone': 1 });
  await database.collection(COLLECTIONS.auditLog).createIndex({ at: -1 });

  // The booking site looks customers up by code on every quote.
  await database.collection(COLLECTIONS.customers).createIndex({ code: 1 }, { unique: true });
  await database.collection(COLLECTIONS.contractProposals).createIndex({ status: 1, submittedAt: -1 });
  await database.collection(COLLECTIONS.contractProposals).createIndex({ customerCode: 1 });
  await database
    .collection(COLLECTIONS.bookingExceptions)
    .createIndex({ reference: 1 }, { unique: true });
  await database.collection(COLLECTIONS.bookingExceptions).createIndex({ status: 1, requestedAt: -1 });
  await database.collection(COLLECTIONS.rateTemplates).createIndex({ key: 1 }, { unique: true });
  await database.collection(COLLECTIONS.products).createIndex({ key: 1 }, { unique: true });
  await database.collection(COLLECTIONS.offers).createIndex({ key: 1 }, { unique: true });
  // Read on the quote path: only offers live right now, never the whole history.
  await database.collection(COLLECTIONS.offers).createIndex({ enabled: 1, startsAt: 1, endsAt: 1 });

  // Money. Every balance is a replay of one customer's entries, oldest first.
  await database.collection(COLLECTIONS.ledger).createIndex({ customerCode: 1, at: 1 });
  await database.collection(COLLECTIONS.ledger).createIndex({ id: 1 }, { unique: true });
  await database.collection(COLLECTIONS.ledger).createIndex({ reference: 1 });
  // Deterministic invoice numbers, so raising a period twice collides rather than duplicates.
  // One AWB, one shipment: a retry from the core must not become a second billable line.
  await database.collection(COLLECTIONS.shipments).createIndex({ awb: 1 }, { unique: true });
  await database
    .collection(COLLECTIONS.shipments)
    .createIndex({ customerCode: 1, status: 1, bookedAt: 1 });

  // Looked up by identifier when a charge is questioned, which is the whole point of
  // keeping them. Unique because a collision would attribute one customer's price to
  // another, and that is not an error anybody would notice in time.
  await database.collection(COLLECTIONS.quotes).createIndex({ quoteId: 1 }, { unique: true });
  // "What did we quote this customer, and when" — the shape a dispute arrives in.
  await database.collection(COLLECTIONS.quotes).createIndex({ 'request.customerCode': 1, createdAt: -1 });

  // Replay protection. Uniqueness is what makes a nonce one-use, and it has to be the
  // database's job: two copies of a captured request hitting two instances would both
  // pass a read-then-write. Expiry is set from the auth module's constant so the window
  // a nonce is remembered for can never end up shorter than the clock skew allowed —
  // which would quietly reopen replays.
  await database
    .collection(COLLECTIONS.serviceNonces)
    .createIndex({ keyId: 1, nonce: 1 }, { unique: true });
  await database
    .collection(COLLECTIONS.serviceNonces)
    .createIndex({ at: 1 }, { expireAfterSeconds: NONCE_TTL_SECONDS });

  // Drained oldest-first, so the core sees changes in the order they were approved.
  await database.collection(COLLECTIONS.corePushes).createIndex({ state: 1, queuedAt: 1 });
  await database.collection(COLLECTIONS.corePushes).createIndex({ customerCode: 1, queuedAt: -1 });

  await database
    .collection(COLLECTIONS.customerProfileChanges)
    .createIndex({ status: 1, submittedAt: 1 });
  await database
    .collection(COLLECTIONS.customerProfileChanges)
    .createIndex({ customerCode: 1, status: 1 });

  await database.collection(COLLECTIONS.contractRequests).createIndex({ status: 1, raisedAt: 1 });
  await database
    .collection(COLLECTIONS.contractRequests)
    .createIndex({ reference: 1 }, { unique: true });
  await database.collection(COLLECTIONS.contractRequests).createIndex({ customerCode: 1, raisedAt: -1 });

  await database.collection(COLLECTIONS.carriers).createIndex({ carrierId: 1 }, { unique: true });
  await database.collection(COLLECTIONS.services).createIndex({ key: 1 }, { unique: true });

  // One series document per prefix and financial year. Unique, because two would mean two
  // counters handing out the same numbers.
  await database
    .collection(COLLECTIONS.invoiceSeries)
    .createIndex({ prefix: 1, financialYear: 1 }, { unique: true });

  // One customer, one mode, one period, one invoice. Enforced by the database rather than
  // by the check that precedes it: two bill runs racing would both pass a read.
  await database.collection(COLLECTIONS.invoices).createIndex({ naturalKey: 1 }, { unique: true, sparse: true });
  await database.collection(COLLECTIONS.invoices).createIndex({ number: 1 }, { unique: true, sparse: true });
  await database.collection(COLLECTIONS.receipts).createIndex({ reference: 1 }, { unique: true });
  await database.collection(COLLECTIONS.receipts).createIndex({ customerCode: 1, receivedAt: -1 });
  await database
    .collection(COLLECTIONS.billingPeriods)
    .createIndex({ customerCode: 1, from: 1 }, { unique: true });
  await database
    .collection(COLLECTIONS.reconciliation)
    .createIndex({ customerCode: 1, periodId: 1 }, { unique: true });
  await database.collection(COLLECTIONS.invoices).createIndex({ number: 1 }, { unique: true });
  await database.collection(COLLECTIONS.invoices).createIndex({ customerCode: 1, raisedAt: -1 });
}
