import { MongoClient, type Db } from 'mongodb';

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
  await database.collection(COLLECTIONS.invoices).createIndex({ number: 1 }, { unique: true });
  await database.collection(COLLECTIONS.invoices).createIndex({ customerCode: 1, raisedAt: -1 });
}
