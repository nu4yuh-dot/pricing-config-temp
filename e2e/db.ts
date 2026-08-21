import { MongoClient, type Db } from 'mongodb';

/**
 * The database, for asserting what a screen actually did.
 *
 * A functional test that only reads the page back proves the page re-rendered, not that
 * anything was stored — and "the toast said saved" is exactly the evidence that has been
 * wrong here before. These tests click the real control and then look in the collection.
 */
let client: MongoClient | null = null;

export async function db(): Promise<Db> {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017');
    await client.connect();
  }
  return client.db(process.env.MONGODB_DB ?? 'dns_pricing');
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = null;
}

/** Remove anything a run created, by the marker every fixture name carries. */
export const MARK = 'E2EPROBE';

export async function cleanup(): Promise<void> {
  const d = await db();
  await Promise.all([
    d.collection('offers').deleteMany({ name: new RegExp(MARK) }),
    d.collection('carriers').deleteMany({ name: new RegExp(MARK) }),
    d.collection('services').deleteMany({ name: new RegExp(MARK) }),
    d.collection('rateTemplates').deleteMany({ name: new RegExp(MARK) }),
    d.collection('settlementProfiles').deleteMany({ name: new RegExp(MARK) }),
    d.collection('users').deleteMany({ email: new RegExp(MARK, 'i') }),
    d.collection('products').deleteMany({ name: new RegExp(MARK) }),
  ]);
}
