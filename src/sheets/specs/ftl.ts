import type { Block, SheetSpec } from '../types';
import { SURFACE_ZONES } from '../../domain/zones';
import { VEHICLE_TYPES } from '../../pricing/ftl';

/**
 * The `FTL Rates` tab.
 *
 * One origin × destination matrix per vehicle, stacked down the sheet the way the source
 * workbooks stack their four rate matrices — because that is how the team already reads a
 * rate sheet.
 *
 * There are no weight tiers here. A truck is hired whole, so the cell *is* the price:
 * A Raymond's Pune→Bangalore 32 ft is ₹33,000 and that is the whole freight. An empty cell
 * means that vehicle is not offered on that lane, which is what a dash means everywhere
 * else in these workbooks.
 */

/** Rows per matrix: a title, a header row, and one row per origin. */
const MATRIX_HEIGHT = SURFACE_ZONES.length + 3;

const blocks: Block[] = [
  {
    type: 'title',
    at: 'A1',
    text: `FTL — FULL TRUCK LOAD · ${VEHICLE_TYPES.length} vehicles · Rs per trip, per lane`,
  },
  {
    type: 'note',
    at: 'A2',
    text:
      'The cell is the price of the trip. No weight tiers, no minimum charge and no chargeable ' +
      'weight — a truck is hired whole. An empty cell means that vehicle is not offered on that lane.',
  },
];

VEHICLE_TYPES.forEach((vehicle, index) => {
  blocks.push({
    type: 'matrix',
    at: `A${4 + index * MATRIX_HEIGHT}`,
    title: `${vehicle.label.toUpperCase()} — up to ${vehicle.capacityKg.toLocaleString('en-IN')} kg`,
    rowKeys: SURFACE_ZONES,
    colKeys: SURFACE_ZONES,
    bind: `ftl.rates.${vehicle.code}`,
    format: 'currency',
    corner: 'From\\To',
    shortName: vehicle.code,
  });
});

export const ftlSpec: SheetSpec = {
  id: 'ftl-rates',
  name: 'FTL Rates',
  columns: SURFACE_ZONES.length + 1,
  blocks,
};
