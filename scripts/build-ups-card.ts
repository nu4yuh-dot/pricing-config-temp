import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settlementFill } from '../src/pricing/card-config';
import type { UpsCardData } from '../src/domain/ups';
import type { RateCard, RateCardData } from '../src/domain/types';

/**
 * Wrap the extracted UPS tariff in a rate card, so it seeds and versions like any other.
 *
 * The card carries empty lane matrices for the same reason the Bluedart one does: this
 * product has no origin × destination grids at all. Everything it needs lives under
 * `data.ups`, and the DNS-shaped fields exist only so a card is a card.
 *
 *   python3 scripts/extract_ups.py && npx tsx scripts/build-ups-card.ts
 */

const root = join(import.meta.dirname, '..');
const ups = JSON.parse(
  readFileSync(join(root, 'data', 'extracted', 'ups-data.json'), 'utf8'),
) as UpsCardData;

const emptyGrids = () => ({ minCharge: {}, tier1: {}, tier2: {}, tier3: {} });

const base = {
  grids: { air: emptyGrids(), surface: emptyGrids(), rail: emptyGrids() },
  pickupDelivery: {},
  edlMatrix: { kmBands: [], weightBands: [], rates: [], perKmBeyondLastBand: 0, perKmThreshold: 0 },
  transitTimes: { air: {}, surface: {}, rail: {} },
  charges: {
    pickupAir: 0, deliveryAir: 0, pickupSurface: 0, deliverySurface: 0,
    docket: 0,
    // The card's own GST, restated here so anything reading the DNS-shaped fields sees
    // the same 18% the UPS settlement applies.
    gstAir: ups.params.gstRate, gstSurface: ups.params.gstRate,
    minWeightAir: ups.params.minChargeableWeight,
    minWeightSurface: ups.params.minChargeableWeight,
    volumetricDivisorAir: ups.params.volumetricDivisor,
    volumetricDivisorSurface: ups.params.volumetricDivisor,
    fuelAir: ups.params.fuelRate, fuelSurface: ups.params.fuelRate, fuelRail: 0,
    railHeavyPackageThreshold: 0, railHeavyPackageMultiplier: 1, nfoMultiplier: 1,
  },
  zones: { surface: {}, air: {} },
  ups,
} as unknown as RateCardData;

const card: RateCard = {
  key: 'ups',
  name: 'UPS / MOVIN — international export, ex-Mumbai',
  // Nothing here uses a DNS freight method; the UPS engine prices its own way. Declared
  // because the type requires one, and cumulative slabs is the least surprising default.
  freightMethod: 'CUMULATIVE_SLABS',
  source: 'ups',
  data: { ...base, ...settlementFill(base) },
};

const out = join(root, 'data', 'extracted', 'ups.json');
writeFileSync(out, `${JSON.stringify(card, null, 2)}\n`);

console.log(`wrote ${out}`);
console.log(`  ${Object.keys(ups.zones).length} destinations, ${ups.postalZones.length} postal ranges`);
console.log(`  ${ups.rates.package.length} package steps, ${ups.rates.bulk.length} bulk bands`);
console.log(`  ${ups.accessorials.length} accessorials`);
