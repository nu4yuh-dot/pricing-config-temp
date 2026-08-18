/**
 * Create the indexes the application relies on, and nothing else.
 *
 * `seed.ts` also does this, but it does other things too — validating cards, loading
 * pincodes, creating a first admin. After a release that adds collections, the only thing
 * needed is the indexes, and a script that does only that is a script that is safe to run
 * against a live database without reading its arguments twice.
 *
 *   railway run npx tsx scripts/ensure-indexes.ts
 */
import { ensureIndexes, db } from '../src/data/mongo';

async function main() {
  const database = await db();
  console.log(`database: ${database.databaseName}`);
  await ensureIndexes();
  console.log('indexes ensured');
  process.exit(0);
}

void main();
