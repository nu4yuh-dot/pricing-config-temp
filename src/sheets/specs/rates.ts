import { AIR_ZONES, SURFACE_ZONES } from '../../domain/zones';
import type { SheetSpec, Block } from '../types';

/**
 * The three rate sheets. Each stacks four origin x destination matrices down one
 * sheet at the same coordinates the source workbooks use, with the HOW TO READ
 * panel to the right.
 *
 * Corrections applied here, per design spec §2.4:
 *  - Slab labels say 100-300 and 300+, matching the matrices. The source headers
 *    claimed 100-500 and 500+ (defect 1).
 *  - The surface panel says 21 clusters, which is how many there are (defect 2).
 */

const CORNER = 'From\\To';

interface RateSheetShape {
  id: string;
  name: string;
  columns: number;
  title: string;
  zones: readonly string[];
  /** Anchor row of each of the four section titles. */
  anchors: [number, number, number, number];
  gridTitles: [string, string, string, string];
  panelAt: string;
  panelTitle: string;
  panelLines: string[];
  minWeightLabel: string;
}

function rateSheet(shape: RateSheetShape): SheetSpec {
  const bindBase = `grids.${shape.id}`;
  const gridNames = ['minCharge', 'tier1', 'tier2', 'tier3'] as const;
  const shortNames = ['min charge', 'per-kg tier 1', 'per-kg tier 2', 'per-kg tier 3'] as const;

  const blocks: Block[] = [{ type: 'title', at: 'A1', text: shape.title }];

  gridNames.forEach((gridName, index) => {
    blocks.push({
      type: 'matrix',
      at: `A${shape.anchors[index]}`,
      title: shape.gridTitles[index] as string,
      shortName: shortNames[index],
      rowKeys: shape.zones,
      colKeys: shape.zones,
      bind: `${bindBase}.${gridName}`,
      corner: CORNER,
      format: gridName === 'minCharge' ? 'currency' : 'rate',
    });
  });

  blocks.push({
    type: 'notePanel',
    at: shape.panelAt,
    title: shape.panelTitle,
    lines: shape.panelLines,
  });

  return { id: shape.id, name: shape.name, columns: shape.columns, blocks };
}

export const airRatesSpec = rateSheet({
  id: 'air',
  name: 'Air Rates',
  columns: 20,
  title:
    'AIR EXPRESS — decremental per-kg, lane-wise fixed fee. Freight is ex-fuel; ' +
    'fuel surcharge, pickup/delivery, docket, ODA and GST are added on top.',
  zones: AIR_ZONES,
  anchors: [3, 18, 33, 48],
  gridTitles: [
    'MINIMUM / FIXED FEE (Rs) — lane-wise, covering weight up to 25 kg',
    'PER KG 25–100 kg (Rs/kg)',
    'PER KG 100–300 kg (Rs/kg) — decremental',
    'PER KG 300+ kg (Rs/kg) — decremental',
  ],
  panelAt: 'O3',
  panelTitle: 'HOW TO READ — AIR',
  panelLines: [
    '12 airport hubs. Find the ORIGIN hub (row) and DESTINATION hub (column) in each matrix.',
    'Freight = FIXED/MIN (≤25 kg) + the per-kg tiers, applied by this card’s pricing method.',
    '“-” means no air on that lane — use Surface.',
    'Fuel 45%, pickup + delivery, docket, ODA/EDL and GST are added in the Calculator.',
    'NFO / JIT is this card doubled, and is computed rather than stored.',
  ],
  minWeightLabel: '25 kg',
});

export const surfaceRatesSpec = rateSheet({
  id: 'surface',
  name: 'Surface Rates',
  columns: 29,
  title:
    'SURFACE PARTLOAD (PTL) — fixed min-weight charge + per-kg tiers (decremental). ' +
    'PARTLOAD ONLY (≤1000 kg); FTL and over 1000 kg are quoted separately.',
  zones: SURFACE_ZONES,
  anchors: [3, 27, 51, 75],
  gridTitles: [
    'MINIMUM CHARGE (Rs) — covering weight up to 50 kg',
    'RATE 50–100 kg (Rs/kg)',
    'RATE 100–300 kg (Rs/kg)',
    'RATE 300+ kg (Rs/kg)',
  ],
  panelAt: 'X3',
  panelTitle: 'HOW TO READ — SURFACE',
  panelLines: [
    '21 industrial clusters. Find the ORIGIN zone (row) and DESTINATION zone (column).',
    'Freight = FIXED/MIN (≤50 kg) + the per-kg tiers, applied by this card’s pricing method.',
    'Same-zone (intra) lanes are a low local rate with NO separate pickup or delivery.',
    'Add fuel 25%, pickup + delivery, docket, ODA/EDL and GST in the Calculator.',
  ],
  minWeightLabel: '50 kg',
});

export const railRatesSpec = rateSheet({
  id: 'rail',
  name: 'Rail Rates',
  columns: 29,
  title:
    'RAIL — fixed + tier matrices, railhead to railhead. No fuel surcharge; ' +
    'viable only on lanes over roughly 800 km (“-” = use Surface).',
  zones: SURFACE_ZONES,
  anchors: [3, 27, 51, 75],
  gridTitles: [
    'FIXED / MINIMUM CHARGE (Rs) — covering weight up to 50 kg',
    'PER KG 50–100 kg (Rs/kg)',
    'PER KG 100–300 kg (Rs/kg)',
    'PER KG 300+ kg (Rs/kg)',
  ],
  panelAt: 'X3',
  panelTitle: 'HOW TO READ — RAIL',
  panelLines: [
    'Railhead to railhead. Only lanes over roughly 800 km (“-” = use Surface).',
    'Freight = FIXED/MIN (≤50 kg) + the per-kg tiers, applied by this card’s pricing method.',
    'NO fuel surcharge on rail. Any single package of 100 kg or more is charged at 2× its weight.',
    'Add pickup + delivery, docket and GST. Transit days are in “ETA Rail”.',
  ],
  minWeightLabel: '50 kg',
});
