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
  notes: 'notes',
} as const;

/**
 * Indexes the application relies on. Called by the seed script and safe to re-run:
 * createIndex is idempotent for an unchanged definition.
 */
/**
 * Creates one index, and reports rather than aborts when it cannot.
 *
 * A conflicting specification — the same name asked for with different options — throws,
 * and a single throw partway through this function used to leave every index below it
 * uncreated. On a database with any history that is the normal case, not the exceptional
 * one, and silently ending up without a unique constraint on an invoice series is worse
 * than the noise of saying so.
 */
async function index(
  database: Db,
  collection: string,
  keys: Record<string, 1 | -1>,
  options: Record<string, unknown> = {},
): Promise<void> {
  try {
    await database.collection(collection).createIndex(keys as never, options as never);
  } catch (error) {
    const code = (error as { code?: number }).code;
    // 85 IndexOptionsConflict, 86 IndexKeySpecsConflict: an index with this name already
    // exists with different options. The existing one is left alone — changing it is a
    // migration somebody should decide on, not a side effect of a deploy.
    if (code === 85 || code === 86) {
      console.warn(
        `index ${collection}.${Object.keys(keys).join('_')} already exists with different options; left as it is`,
      );
      return;
    }
    throw error;
  }
}

export async function ensureIndexes(): Promise<void> {
  const database = await db();

  await index(database, COLLECTIONS.users, { email: 1 }, { unique: true });
  await index(database, COLLECTIONS.rateCards, { key: 1 }, { unique: true });
  await index(database, COLLECTIONS.rateCardVersions, { rateCardId: 1, version: -1 });
  await index(database, COLLECTIONS.rateCardVersions, { rateCardId: 1, state: 1 });
  await index(database, COLLECTIONS.changeRequests, { status: 1, submittedAt: -1 });
  await index(database, COLLECTIONS.changeRequests, { rateCardId: 1 });
  // The pincode lookup is on the hot path of every quote.
  await index(database, COLLECTIONS.pincodes, { pincode: 1 }, { unique: true });
  await index(database, COLLECTIONS.pincodes, { state: 1 });
  await index(database, COLLECTIONS.pincodes, { 'surface.zone': 1 });
  await index(database, COLLECTIONS.auditLog, { at: -1 });

  // The booking site looks customers up by code on every quote.
  await index(database, COLLECTIONS.customers, { code: 1 }, { unique: true });
  await index(database, COLLECTIONS.contractProposals, { status: 1, submittedAt: -1 });
  await index(database, COLLECTIONS.contractProposals, { customerCode: 1 });
  await index(database, COLLECTIONS.bookingExceptions, { reference: 1 }, { unique: true });
  await index(database, COLLECTIONS.bookingExceptions, { status: 1, requestedAt: -1 });
  await index(database, COLLECTIONS.rateTemplates, { key: 1 }, { unique: true });
  await index(database, COLLECTIONS.products, { key: 1 }, { unique: true });
  await index(database, COLLECTIONS.offers, { key: 1 }, { unique: true });
  // Read on the quote path: only offers live right now, never the whole history.
  await index(database, COLLECTIONS.offers, { enabled: 1, startsAt: 1, endsAt: 1 });

  // Money. Every balance is a replay of one customer's entries, oldest first.
  await index(database, COLLECTIONS.ledger, { customerCode: 1, at: 1 });
  await index(database, COLLECTIONS.ledger, { id: 1 }, { unique: true });
  await index(database, COLLECTIONS.ledger, { reference: 1 });
  // Deterministic invoice numbers, so raising a period twice collides rather than duplicates.
  // One AWB, one shipment: a retry from the core must not become a second billable line.
  await index(database, COLLECTIONS.shipments, { awb: 1 }, { unique: true });
  await index(database, COLLECTIONS.shipments, { customerCode: 1, status: 1, bookedAt: 1 });

  // Looked up by identifier when a charge is questioned, which is the whole point of
  // keeping them. Unique because a collision would attribute one customer's price to
  // another, and that is not an error anybody would notice in time.
  await index(database, COLLECTIONS.quotes, { quoteId: 1 }, { unique: true });
  // "What did we quote this customer, and when" — the shape a dispute arrives in.
  await index(database, COLLECTIONS.quotes, { 'request.customerCode': 1, createdAt: -1 });

  // Replay protection. Uniqueness is what makes a nonce one-use, and it has to be the
  // database's job: two copies of a captured request hitting two instances would both
  // pass a read-then-write. Expiry is set from the auth module's constant so the window
  // a nonce is remembered for can never end up shorter than the clock skew allowed —
  // which would quietly reopen replays.
  await index(database, COLLECTIONS.serviceNonces, { keyId: 1, nonce: 1 }, { unique: true });
  await index(database, COLLECTIONS.serviceNonces, { at: 1 }, { expireAfterSeconds: NONCE_TTL_SECONDS });

  // Drained oldest-first, so the core sees changes in the order they were approved.
  await index(database, COLLECTIONS.corePushes, { state: 1, queuedAt: 1 });
  await index(database, COLLECTIONS.corePushes, { customerCode: 1, queuedAt: -1 });

  await index(database, COLLECTIONS.customerProfileChanges, { status: 1, submittedAt: 1 });
  await index(database, COLLECTIONS.customerProfileChanges, { customerCode: 1, status: 1 });

  await index(database, COLLECTIONS.contractRequests, { status: 1, raisedAt: 1 });
  await index(database, COLLECTIONS.contractRequests, { reference: 1 }, { unique: true });
  await index(database, COLLECTIONS.contractRequests, { customerCode: 1, raisedAt: -1 });

  await index(database, COLLECTIONS.carriers, { carrierId: 1 }, { unique: true });
  await index(database, COLLECTIONS.services, { key: 1 }, { unique: true });

  // One series document per prefix and financial year. Unique, because two would mean two
  // counters handing out the same numbers.
  await index(database, COLLECTIONS.invoiceSeries, { prefix: 1, financialYear: 1 }, { unique: true });

  // One customer, one mode, one period, one invoice. Enforced by the database rather than
  // by the check that precedes it: two bill runs racing would both pass a read.
  // Sparse, because invoices raised before the natural key existed do not carry one and
  // a plain unique index would treat every one of them as a duplicate of the others.
  await index(database, COLLECTIONS.invoices, { naturalKey: 1 }, { unique: true, sparse: true });
  // NOT sparse: every invoice has a number, and this index already exists in production
  // without the flag. Asking for a sparse one is a different index specification, which
  // Mongo refuses under the same name — and that refusal aborted the whole run, leaving
  // every index below it uncreated.
  await index(database, COLLECTIONS.invoices, { number: 1 }, { unique: true });
  await index(database, COLLECTIONS.receipts, { reference: 1 }, { unique: true });
  await index(database, COLLECTIONS.receipts, { customerCode: 1, receivedAt: -1 });
  await index(database, COLLECTIONS.billingPeriods, { customerCode: 1, from: 1 }, { unique: true });
  await index(database, COLLECTIONS.reconciliation, { customerCode: 1, periodId: 1 }, { unique: true });
  await index(database, COLLECTIONS.notes, { number: 1 }, { unique: true });
  await index(database, COLLECTIONS.notes, { against: 1 });
  await index(database, COLLECTIONS.notes, { customerCode: 1, issuedAt: -1 });
  await index(database, COLLECTIONS.invoices, { number: 1 }, { unique: true });
  await index(database, COLLECTIONS.invoices, { customerCode: 1, raisedAt: -1 });
}
