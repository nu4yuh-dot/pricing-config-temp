import { SignJWT } from 'jose';
import { MongoClient, type Db } from 'mongodb';
import { sessionHolder } from './next-stubs';
import type { Role } from '../../auth/roles';

/**
 * Signing in, and looking in the database afterwards.
 *
 * The token is minted with the same secret and the same claims `createSession` uses, so
 * `currentUser` verifies a real session rather than trusting a stub. That matters here more
 * than in the browser tests: several of these assertions are about an action *refusing* a
 * role, and a faked session would prove nothing about the capability check.
 */

const SECRET = () => process.env.SESSION_SECRET ?? 'actions-secret-at-least-32-characters';

/** Distinct ids so a self-approval test can be somebody else. */
export const PEOPLE = {
  admin: { id: '000000000000000000000a11', email: 'admin.probe@dnslogistic.com', name: 'ACTPROBE Admin' },
  admin2: { id: '000000000000000000000a12', email: 'admin2.probe@dnslogistic.com', name: 'ACTPROBE Second Admin' },
  configurator: { id: '000000000000000000000a13', email: 'conf.probe@dnslogistic.com', name: 'ACTPROBE Configurator' },
  viewer: { id: '000000000000000000000a14', email: 'view.probe@dnslogistic.com', name: 'ACTPROBE Viewer' },
} as const;

export async function signInAs(who: keyof typeof PEOPLE, role: Role): Promise<void> {
  const person = PEOPLE[who];
  sessionHolder.token = await new SignJWT({ email: person.email, name: person.name, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(person.id)
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(new TextEncoder().encode(SECRET()));
}

export function signOutCompletely(): void {
  sessionHolder.token = null;
}

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

/**
 * The marker every fixture this suite creates carries.
 *
 * Distinct from the browser suite's `E2EPROBE` so the two can run against one database
 * without deleting each other's fixtures mid-run.
 */
export const MARK = 'ACTPROBE';

/**
 * Remove everything a run created.
 *
 * Keyed on the marker rather than on ids collected during the run, because a test that
 * fails half way never reaches its own teardown — and a leftover fixture makes the *next*
 * run fail for a different and more confusing reason. That is not hypothetical: a
 * verification script here used to leave a test rate live, and the following run then
 * reported a mismatch that had nothing to do with the change being tested.
 */
export async function cleanup(): Promise<void> {
  const d = await db();
  const named = { name: new RegExp(MARK) };
  await Promise.all([
    d.collection('offers').deleteMany(named),
    d.collection('products').deleteMany(named),
    d.collection('rateTemplates').deleteMany(named),
    d.collection('settlementProfiles').deleteMany(named),
    d.collection('carriers').deleteMany(named),
    d.collection('services').deleteMany(named),
    d.collection('customers').deleteMany({ code: new RegExp(MARK) }),
    d.collection('users').deleteMany({ email: new RegExp('probe@dnslogistic', 'i') }),
    d.collection('ledger').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('invoices').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('billingPeriods').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('shipments').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('quotes').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('receipts').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('reconciliation').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('notes').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('contractProposals').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('contractRequests').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('customerProfileChanges').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('corePushes').deleteMany({ customerCode: new RegExp(MARK) }),
    d.collection('bookingExceptions').deleteMany({ customerCode: new RegExp(MARK) }),
    /**
     * Two filters, because one of them cannot reach everything.
     *
     * Keying on `actor.email` misses a row whose `actor` is null — and an earlier version of
     * these specs wrote exactly that, by calling `registerCustomer` with the wrong argument
     * shape. Those rows survived every cleanup, and a page that renders `entry.actor.name`
     * without a guard then answered 500 for the whole audit log. Matching on the fixture's
     * own marker in `detail` catches them whatever the actor turned out to be.
     */
    d.collection('auditLog').deleteMany({ 'actor.email': new RegExp('probe@dnslogistic', 'i') }),
    d.collection('auditLog').deleteMany({ 'detail.code': new RegExp(MARK) }),
    d.collection('auditLog').deleteMany({ 'detail.customer': new RegExp(MARK) }),
  ]);
}

/** A `FormData` from a plain object, since most of these actions take one. */
export function form(fields: Record<string, string | number | boolean | undefined>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.append(key, String(value));
  }
  return data;
}

/**
 * Loose on purpose: the two result shapes in use are not one type.
 *
 * `attempt()` answers `Outcome<T>` — a union of `{ ok: true } & T` and `{ error }`. The
 * money actions answer `{ ok: boolean; message?: string }`. A helper that took the real
 * union could not also accept the second, and narrowing at every call site would put more
 * ceremony in the tests than assertion.
 */
export type AnyOutcome = { ok?: boolean; error?: string; message?: string };

/**
 * Two result shapes are in use, and a check for one silently passes the other.
 *
 * Most actions go through `attempt()` and answer `{ ok: true }` or `{ error }`. The money
 * actions predate it and answer `{ ok: false, message }`, because they drive
 * `useActionState` and the form renders `message` directly. A helper that only looked for
 * `error` would read every refused recharge as a success — so this treats
 * `ok === false` as a refusal too, and says which field carried the reason.
 */
export function expectOk(outcome: AnyOutcome, what: string): void {
  if (outcome?.error) throw new Error(`${what} was refused: ${outcome.error}`);
  if (outcome?.ok === false) throw new Error(`${what} was refused: ${outcome.message ?? '(no message)'}`);
}

/**
 * One number out of a response, or a failure that says which one was missing.
 *
 * `noUncheckedIndexedAccess` types these lookups as possibly undefined, and it is right to:
 * a renamed field would otherwise make `expect(undefined).toBeCloseTo(undefined)` pass and
 * report the price as verified. Reading through here turns that into a named failure.
 */
export function figure(source: Record<string, number | undefined>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`the response has no numeric \`${key}\` (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** The reason an action gave for refusing, whichever field it used. */
export function reasonFrom(outcome: AnyOutcome): string {
  return outcome?.error ?? outcome?.message ?? '';
}

/**
 * Snapshot one rate card's versions, and put them back exactly.
 *
 * A spec that edits a card's draft leaves that edit behind: `cleanup` keys on a fixture
 * marker, and a cell written into an existing card carries no marker. The charge library is
 * read from what every card's draft declares, so one leftover charge shows up on a screen
 * for good — which is how a probe charge came to sit in the real library.
 */
export type CardSnapshot = { cardId: unknown; versions: { id: unknown; data: unknown }[] };

export async function snapshotCard(key: string): Promise<CardSnapshot> {
  const d = await db();
  const card = await d.collection('rateCards').findOne({ key });
  if (!card) throw new Error(`${key} is not seeded — run: npm run seed`);
  const rows = await d
    .collection('rateCardVersions')
    .find({ rateCardId: card._id })
    .project({ _id: 1, data: 1 })
    .toArray();
  return {
    cardId: card._id,
    versions: rows.map((r) => ({ id: r._id, data: (r as { data: unknown }).data })),
  };
}

export async function restoreCard(snapshot: CardSnapshot | null): Promise<void> {
  if (!snapshot) return;
  const versions = (await db()).collection('rateCardVersions');
  for (const version of snapshot.versions) {
    await versions.updateOne({ _id: version.id as never }, { $set: { data: version.data } });
  }
}
