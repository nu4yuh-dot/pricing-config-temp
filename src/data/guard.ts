import { db, COLLECTIONS } from './mongo';

/**
 * Refuse to write to a database that is not this project's.
 *
 * The Mongo instance this runs against may host other projects. A mistyped
 * `MONGODB_DB` would otherwise point a seed or a reset at someone else's data, and
 * the failure would be silent — indexes created, documents inserted, in the wrong
 * place. Every script that writes calls this first.
 *
 * Two independent checks, because either alone can be fooled:
 *
 *  1. The database name must be recognisably ours.
 *  2. If the database already has collections, they must all be ours. This is the
 *     decisive one: it catches a name that passes check 1 by coincidence, and it
 *     catches pointing at a populated foreign database.
 */

/** Collections this project owns. Anything else in the target database is a red flag. */
const OWNED = new Set<string>(Object.values(COLLECTIONS));

/** A name is ours if it is exactly this, or this with an environment suffix. */
const NAME_PATTERN = /^dns_pricing(_[a-z0-9-]+)?$/;

export interface GuardResult {
  database: string;
  collections: string[];
  empty: boolean;
}

export async function assertOwnDatabase(intent: string): Promise<GuardResult> {
  const database = await db();
  const name = database.databaseName;

  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Refusing to ${intent}: "${name}" is not this project's database.\n` +
        `MONGODB_DB must be "dns_pricing" (optionally with an environment suffix, ` +
        `e.g. dns_pricing_staging). Check the environment before retrying.`,
    );
  }

  const collections = (await database.listCollections().toArray()).map((entry) => entry.name);
  const foreign = collections.filter((entry) => !OWNED.has(entry));

  if (foreign.length > 0) {
    throw new Error(
      `Refusing to ${intent}: database "${name}" contains collections this project ` +
        `does not own — ${foreign.join(', ')}.\n` +
        `That almost certainly means MONGODB_DB is pointing at another project. ` +
        `Nothing has been written.`,
    );
  }

  return { database: name, collections, empty: collections.length === 0 };
}

/** Print the target so it is impossible to miss in a log before anything is written. */
export function describeTarget(result: GuardResult): string {
  return (
    `target database: ${result.database} ` +
    `(${result.empty ? 'empty' : `${result.collections.length} existing collections, all ours`})`
  );
}
