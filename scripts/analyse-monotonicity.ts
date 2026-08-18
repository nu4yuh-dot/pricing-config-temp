/**
 * Scan every lane in every model for weights where shipping MORE costs LESS.
 *
 * A decremental tier structure applied as a single rate (Models 2 and 3) reprices
 * the whole shipment when it crosses a tier boundary, so the total can fall as
 * weight rises. Model 1's progressive slabs cannot do this. This script measures
 * how far the effect reaches.
 *
 * Run: npx tsx scripts/analyse-monotonicity.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeFreight } from '../src/pricing/freight';
import type { RateCard, StoredMode } from '../src/domain/types';
import { SURFACE_ZONES, AIR_ZONES } from '../src/domain/zones';

const root = join(import.meta.dirname, '..');
const load = (key: string): RateCard =>
  JSON.parse(readFileSync(join(root, 'data', 'extracted', `${key}.json`), 'utf8'));

const MODES: StoredMode[] = ['air', 'surface', 'rail'];

interface Cliff {
  mode: string;
  lane: string;
  atWeight: number;
  before: number;
  after: number;
  drop: number;
}

for (const key of ['model-1', 'model-2', 'model-3']) {
  const card = load(key);
  const minWeights = {
    air: card.data.charges.minWeightAir,
    surface: card.data.charges.minWeightSurface,
    rail: card.data.charges.minWeightSurface,
  };

  const cliffs: Cliff[] = [];
  let lanesChecked = 0;

  for (const mode of MODES) {
    const zones = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
    for (const origin of zones) {
      for (const dest of zones) {
        const rates = {
          minCharge: card.data.grids[mode].minCharge[origin]?.[dest] ?? null,
          tier1: card.data.grids[mode].tier1[origin]?.[dest] ?? null,
          tier2: card.data.grids[mode].tier2[origin]?.[dest] ?? null,
          tier3: card.data.grids[mode].tier3[origin]?.[dest] ?? null,
        };
        if (rates.minCharge === null) continue;
        lanesChecked++;

        // Only the tier boundaries can produce a fall, so check across each.
        for (const boundary of [100, 300]) {
          const before = computeFreight(card.freightMethod, boundary, minWeights[mode], rates);
          const after = computeFreight(card.freightMethod, boundary + 1, minWeights[mode], rates);
          if (before !== null && after !== null && after < before) {
            cliffs.push({
              mode,
              lane: `${origin}->${dest}`,
              atWeight: boundary,
              before,
              after,
              drop: before - after,
            });
          }
        }
      }
    }
  }

  const worst = [...cliffs].sort((a, b) => b.drop - a.drop).slice(0, 3);
  const pct = ((cliffs.length / (lanesChecked * 2)) * 100).toFixed(0);

  console.log(`\n${key} (${card.freightMethod})`);
  console.log(`  lanes checked: ${lanesChecked}  ·  boundary crossings: ${lanesChecked * 2}`);
  console.log(`  crossings where 1 kg more costs less: ${cliffs.length} (${pct}%)`);
  if (worst.length > 0) {
    console.log('  worst cases:');
    for (const c of worst) {
      console.log(
        `    ${c.mode} ${c.lane} at ${c.atWeight}kg: ` +
          `Rs ${c.before} -> Rs ${c.after} at ${c.atWeight + 1}kg (Rs ${c.drop} cheaper)`,
      );
    }
  }
}
