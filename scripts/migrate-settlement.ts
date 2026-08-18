import { db, COLLECTIONS } from '../src/data/mongo';
import { assertOwnDatabase, describeTarget } from '../src/data/guard';
import { settlementFill } from '../src/pricing/card-config';
import type { RateCardData } from '../src/domain/types';

/**
 * Give already-seeded card versions their settlement configuration.
 *
 * `scripts/apply-settlement-defaults.ts` fills the extracted JSON, which covers a fresh
 * seed. Versions already in the database predate the Tax & Charges tab, and without these
 * blocks that tab has nothing to show — so this fills them in place.
 *
 * The values written reproduce what each version already does: the workbook fuel base,
 * the version's own GST rate at forward charge, and the docket as the only active charge.
 * No quoted number moves. Gaps are filled at any depth and a value that is already set is
 * never overwritten, so running it twice is harmless and an edited configuration is safe.
 *
 *   npx tsx scripts/migrate-settlement.ts
 */

interface VersionDoc {
  _id: unknown;
  rateCardId?: unknown;
  version?: number;
  state?: string;
  data: RateCardData;
}

async function main(): Promise<void> {
  console.log(describeTarget(await assertOwnDatabase('migrate settlement configuration')));

  const versions = (await db()).collection<VersionDoc>(COLLECTIONS.rateCardVersions);
  const all = await versions.find({}).toArray();
  console.log(`${all.length} card version(s) in the database`);

  let updated = 0;

  for (const doc of all) {
    const fill = settlementFill(doc.data);
    if (Object.keys(fill).length === 0) continue;

    const set: Record<string, unknown> = {};
    for (const [block, value] of Object.entries(fill)) set[`data.${block}`] = value;

    await versions.updateOne({ _id: doc._id as never }, { $set: set });
    updated += 1;
    console.log(
      `  v${doc.version ?? '?'} (${doc.state ?? 'unknown'}): added ${Object.keys(set)
        .map((key) => key.replace('data.', ''))
        .join(', ')}`,
    );
  }

  console.log(updated === 0 ? 'nothing to do' : `updated ${updated} version(s)`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
