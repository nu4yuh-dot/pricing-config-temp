import { db, COLLECTIONS } from '../src/data/mongo';
import { assertOwnDatabase, describeTarget } from '../src/data/guard';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pincode } from '../src/domain/types';

/**
 * Push the Bluedart resolution onto the pincodes already in the database.
 *
 * `scripts/seed.ts` leaves an existing pincode master alone, which is right — it is 19,494
 * documents and re-importing them on every seed would be slow and pointless. But that means
 * a pincode seeded before the franchise card existed has no directional zone, and the
 * Bluedart product cannot quote it.
 *
 * This writes only the `bluedart` block and the three corrected area names. Nothing else on
 * a pincode is touched, so the DNS zone, ODA and rail resolutions are left exactly as they
 * are. Safe to re-run.
 *
 *   npx tsx scripts/migrate-bluedart.ts
 */

const SOURCE = join(import.meta.dirname, '..', 'data', 'extracted', 'pincodes.json');

async function main(): Promise<void> {
  console.log(describeTarget(await assertOwnDatabase('merge Bluedart zones into the pincodes')));

  const source: Pincode[] = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const withZone = source.filter((pincode) => pincode.bluedart !== undefined);
  console.log(`${source.length} pincodes in the extract, ${withZone.length} carry a Bluedart zone`);

  if (withZone.length === 0) {
    console.log('Nothing to migrate. Run: python3 scripts/extract_bluedart.py');
    return;
  }

  const collection = (await db()).collection<Pincode>(COLLECTIONS.pincodes);
  const before = await collection.countDocuments({ bluedart: { $exists: true } });

  // One bulk write rather than 19,494 round trips.
  const operations = withZone.map((pincode) => ({
    updateOne: {
      filter: { pincode: pincode.pincode },
      update: { $set: { bluedart: pincode.bluedart, area: pincode.area } },
    },
  }));

  const BATCH = 2000;
  let matched = 0;
  let modified = 0;
  for (let index = 0; index < operations.length; index += BATCH) {
    const result = await collection.bulkWrite(operations.slice(index, index + BATCH), {
      ordered: false,
    });
    matched += result.matchedCount;
    modified += result.modifiedCount;
    process.stdout.write(`  ${Math.min(index + BATCH, operations.length)}/${operations.length}\r`);
  }

  const after = await collection.countDocuments({ bluedart: { $exists: true } });
  console.log(`\nmatched ${matched}, modified ${modified}`);
  console.log(`pincodes with a Bluedart zone: ${before} → ${after}`);

  if (matched !== withZone.length) {
    console.error(
      `WARNING: ${withZone.length - matched} pincode(s) in the extract are not in the database.`,
    );
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
