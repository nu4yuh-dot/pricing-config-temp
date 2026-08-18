import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLUEDART_DEFAULT_DATA } from '../src/domain/bluedart';
import { settlementFill } from '../src/pricing/card-config';
import type { RateCard, RateCardData } from '../src/domain/types';

/** Empty lane matrices: this product has no origin x destination grids at all. */
const emptyGrids = () => ({ minCharge: {}, tier1: {}, tier2: {}, tier3: {} });

const base = {
  grids: { air: emptyGrids(), surface: emptyGrids(), rail: emptyGrids() },
  pickupDelivery: {},
  edlMatrix: { kmBands: [], weightBands: [], rates: [], perKmBeyondLastBand: 0, perKmThreshold: 0 },
  transitTimes: { air: {}, surface: {}, rail: {} },
  charges: {
    pickupAir: 0, deliveryAir: 0, pickupSurface: 0, deliverySurface: 0,
    docket: 0, gstAir: 0.18, gstSurface: 0.18,
    minWeightAir: 5, minWeightSurface: 10,
    volumetricDivisorAir: 5000, volumetricDivisorSurface: 27000,
    fuelAir: 0.92, fuelSurface: 0.65, fuelRail: 0,
    railHeavyPackageThreshold: 0, railHeavyPackageMultiplier: 1, nfoMultiplier: 1,
  },
  zones: { surface: {}, air: {} },
  bluedart: BLUEDART_DEFAULT_DATA,
} as unknown as RateCardData;

const card: RateCard = {
  key: 'bluedart',
  name: 'Bluedart — franchise, directional zones',
  freightMethod: 'CUMULATIVE_SLABS',
  product: 'bluedart',
  data: { ...base, ...settlementFill(base) },
};

const out = join(import.meta.dirname, '..', 'data', 'extracted', 'bluedart.json');
writeFileSync(out, `${JSON.stringify(card, null, 2)}\n`);
console.log(`wrote ${out}`);
