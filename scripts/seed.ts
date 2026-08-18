/**
 * Seed Mongo from the extracted workbook JSON.
 *
 * Idempotent and re-runnable: it asserts the invariants proved during analysis
 * before writing anything, so a reshaped or corrupted workbook fails loudly rather
 * than importing something subtly different.
 *
 *   npx tsx scripts/seed.ts [--reset] [--admin-password <password>]
 *
 * `--reset` drops the rate card, version, change request and audit collections
 * first. Users and pincodes are preserved unless they are missing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import { db, COLLECTIONS, ensureIndexes } from '../src/data/mongo';
import { assertOwnDatabase, describeTarget } from '../src/data/guard';
import { FREIGHT_METHODS, type RateCard, type Pincode } from '../src/domain/types';
import { AIR_ZONES, SURFACE_ZONES } from '../src/domain/zones';
import { BLUEDART_ZONES } from '../src/domain/bluedart';
import { createUser, listUsers } from '../src/auth/session';

const root = join(import.meta.dirname, '..');
const extracted = join(root, 'data', 'extracted');
const CARD_KEYS = ['model-1', 'model-2', 'model-3'] as const;
/** Bluedart is a different product: no lane matrices, so it is validated differently. */
const PRODUCT_CARDS = ['bluedart', 'ups'] as const;

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(extracted, name), 'utf8')) as T;
}

/** Route a non-DNS card to the check that understands it. */
function assertProductCard(card: RateCard): void {
  const source = card.source ?? card.product ?? 'dns';
  if (source === 'bluedart') return assertBluedartCard(card);
  if (source === 'ups') return assertUpsCard(card);
  throw new Error(`${card.key}: no shape check for a '${source}' card`);
}

/**
 * The UPS card's own shape check.
 *
 * No lane grids and no services. What it must have is a rate grid whose columns cover
 * every zone its destinations are mapped to — a destination pointing at a column that
 * does not exist is a shipment that cannot be priced, and it should fail here rather
 * than at a booking desk.
 */
function assertUpsCard(card: RateCard): void {
  const data = card.data.ups;
  if (!data) throw new Error(`${card.key}: has no ups block`);

  const columns = new Set(data.zoneKeys);
  for (const [code, zone] of Object.entries(data.zones)) {
    if (!columns.has(zone)) {
      throw new Error(`${card.key}: ${code} is zoned '${zone}', which the rate grid has no column for`);
    }
  }
  for (const range of data.postalZones) {
    if (!columns.has(range.zone)) {
      throw new Error(
        `${card.key}: ${range.country} ${range.from}-${range.to} is zoned '${range.zone}', ` +
          `which the rate grid has no column for`,
      );
    }
  }

  for (const zone of columns) {
    if (!(data.rates.envelope[zone]! > 0)) {
      throw new Error(`${card.key}: zone ${zone} has no envelope rate`);
    }
  }
  if (data.rates.package.length === 0 || data.rates.bulk.length === 0) {
    throw new Error(`${card.key}: the package steps or the per-kg bands are missing`);
  }
  for (const params of [data.params]) {
    if (!(params.volumetricDivisor > 0)) throw new Error(`${card.key}: volumetric divisor is not positive`);
    if (!(params.minChargeableWeight > 0)) throw new Error(`${card.key}: chargeable minimum is not positive`);
  }
}

/**
 * The Bluedart card's own shape check.
 *
 * It has no lane grids to validate. What it must have is a rate for every zone on every
 * service, an ODA matrix whose rows line up with its distance bands, and the charges the
 * services depend on — anything missing there is a wrong price, not a missing display.
 */
function assertBluedartCard(card: RateCard): void {
  const data = card.data.bluedart;
  if (!data) throw new Error(`${card.key}: has no bluedart block`);

  for (const zone of BLUEDART_ZONES) {
    const rates = data.zones[zone];
    if (!rates) throw new Error(`${card.key}: no rates for zone ${zone}`);
    if (!(rates.docs > 0) || !(rates.duts > 0)) {
      throw new Error(`${card.key}: ${zone} is missing a per-500g rate`);
    }
    for (const service of ['apex', 'surface'] as const) {
      const slab = rates[service];
      for (const band of ['firstBlock', 'to25', 'to50', 'to100', 'above100'] as const) {
        if (!(slab[band] > 0)) {
          throw new Error(`${card.key}: ${zone} ${service} ${band} is not a positive rate`);
        }
      }
    }
  }

  if (data.oda.rates.length !== data.oda.kmBands.length) {
    throw new Error(
      `${card.key}: the ODA matrix has ${data.oda.rates.length} rows for ` +
        `${data.oda.kmBands.length} distance bands`,
    );
  }
  for (const [index, row] of data.oda.rates.entries()) {
    if (row.length !== data.oda.weightBands.length) {
      throw new Error(
        `${card.key}: ODA row ${index} has ${row.length} rates for ` +
          `${data.oda.weightBands.length} weight bands`,
      );
    }
  }
  if (!(data.charges.gstRate > 0) || !data.charges.sac) {
    throw new Error(`${card.key}: the Bluedart charges are missing a GST rate or SAC code`);
  }
}

/** Fail loudly rather than seeding data whose shape has drifted. */
function assertCard(card: RateCard): void {
  if (!FREIGHT_METHODS.includes(card.freightMethod)) {
    throw new Error(`${card.key}: unknown freight method ${card.freightMethod}`);
  }

  const expected = { air: AIR_ZONES, surface: SURFACE_ZONES, rail: SURFACE_ZONES } as const;
  for (const [mode, zones] of Object.entries(expected)) {
    const grids = card.data.grids[mode as keyof typeof expected];
    for (const gridName of ['minCharge', 'tier1', 'tier2', 'tier3'] as const) {
      const grid = grids[gridName];
      const origins = Object.keys(grid);
      if (origins.length !== zones.length) {
        throw new Error(
          `${card.key}: grids.${mode}.${gridName} has ${origins.length} origins, expected ${zones.length}`,
        );
      }
      for (const origin of zones) {
        const row = grid[origin];
        if (!row) throw new Error(`${card.key}: grids.${mode}.${gridName} is missing ${origin}`);
        for (const dest of zones) {
          if (!(dest in row)) {
            throw new Error(
              `${card.key}: grids.${mode}.${gridName}.${origin} is missing ${dest}`,
            );
          }
        }
      }
    }
  }

  if (Object.keys(card.data.pickupDelivery).length !== SURFACE_ZONES.length) {
    throw new Error(`${card.key}: pickupDelivery does not cover all ${SURFACE_ZONES.length} zones`);
  }
  if (card.data.edlMatrix.rates.length !== card.data.edlMatrix.kmBands.length) {
    throw new Error(`${card.key}: EDL matrix rows do not match its km bands`);
  }
  for (const row of card.data.edlMatrix.rates) {
    if (row.length !== card.data.edlMatrix.weightBands.length) {
      throw new Error(`${card.key}: an EDL matrix row does not match its weight bands`);
    }
  }
  for (const value of Object.values(card.data.charges)) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`${card.key}: a charge parameter is not a number`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const adminPassword = args[args.indexOf('--admin-password') + 1];

  // Before anything is written, prove we are pointed at this project's database.
  // The Mongo instance may host other projects.
  const guard = await assertOwnDatabase(reset ? 'reset' : 'seed');
  console.log(describeTarget(guard));

  const database = await db();
  await ensureIndexes();

  const dnsCards = CARD_KEYS.map((key) => load<RateCard>(`${key}.json`));
  dnsCards.forEach(assertCard);
  const productCards = PRODUCT_CARDS.map((key) => load<RateCard>(`${key}.json`));
  // Each non-DNS product has its own shape and so its own check. Running Bluedart's
  // against the UPS card would reject a perfectly good tariff for lacking zones it was
  // never going to have.
  productCards.forEach(assertProductCard);
  const cards = [...dnsCards, ...productCards];
  console.log(`validated ${cards.length} rate cards (${productCards.length} non-DNS product)`);

  if (reset) {
    for (const name of [
      COLLECTIONS.rateCards,
      COLLECTIONS.rateCardVersions,
      COLLECTIONS.changeRequests,
      COLLECTIONS.auditLog,
    ]) {
      await database.collection(name).deleteMany({});
    }
    console.log('cleared rate cards, versions, change requests and audit log');
  }

  const seededBy = { id: 'system', email: 'system@dnslogistic.com', name: 'Import' };
  const now = new Date();

  for (const card of cards) {
    const existing = await database.collection(COLLECTIONS.rateCards).findOne({ key: card.key });
    if (existing) {
      console.log(`${card.key}: already present, leaving it alone`);
      continue;
    }

    const cardId = new ObjectId();
    const liveId = new ObjectId();
    const draftId = new ObjectId();

    // Version 1 is live; the draft starts as an identical copy so the team has
    // somewhere to work without touching live pricing.
    await database.collection(COLLECTIONS.rateCardVersions).insertMany([
      {
        _id: liveId,
        rateCardId: cardId,
        version: 1,
        state: 'live',
        data: card.data,
        createdBy: seededBy,
        createdAt: now,
        approvedBy: seededBy,
        approvedAt: now,
      },
      {
        _id: draftId,
        rateCardId: cardId,
        version: 2,
        state: 'draft',
        data: card.data,
        createdBy: seededBy,
        createdAt: now,
      },
    ]);

    await database.collection(COLLECTIONS.rateCards).insertOne({
      _id: cardId,
      key: card.key,
      name: card.name,
      freightMethod: card.freightMethod,
      // `source` is the current field; `product` was its name before the redesign needed
      // that word. Reads normalise either way, so new rows are written canonically.
      source: card.source ?? card.product ?? 'dns',
      liveVersionId: liveId,
      draftVersionId: draftId,
    });

    console.log(
      `${card.key}: seeded (${card.source ?? card.product ?? 'dns'} · ${card.freightMethod})`,
    );
  }

  const pincodeCount = await database.collection(COLLECTIONS.pincodes).countDocuments();
  if (pincodeCount === 0) {
    const pincodes = load<Pincode[]>('pincodes.json');
    // Batched so a 19k-document insert does not build one enormous command.
    const size = 5000;
    for (let i = 0; i < pincodes.length; i += size) {
      await database.collection(COLLECTIONS.pincodes).insertMany(pincodes.slice(i, i + size));
    }
    console.log(`pincodes: seeded ${pincodes.length}`);
  } else {
    console.log(`pincodes: ${pincodeCount} already present, leaving them alone`);
  }

  if ((await listUsers()).length === 0) {
    if (!adminPassword) {
      console.log(
        '\nNo users exist yet. Re-run with --admin-password <password> to create the first admin.',
      );
    } else {
      const admin = await createUser({
        email: 'admin@dnslogistic.com',
        name: 'Admin',
        password: adminPassword,
        role: 'admin',
      });
      console.log(`created first admin: ${admin.email}`);
    }
  }

  console.log('\nseed complete');
  process.exit(0);
}

main().catch((error) => {
  console.error('\nseed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
