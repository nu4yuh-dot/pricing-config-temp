import type { RateCardData, StoredMode } from '../domain/types';
import { AIR_ZONES, SURFACE_ZONES } from '../domain/zones';
import { gridBindPath } from '../domain/lane-rules';
import type { LaneRateValues, RateKey } from '../components/console/LaneEditor';

/**
 * Flatten a card's four stacked matrices into one lane-keyed record.
 *
 * The console thinks in lanes — "PNQ to NCR on surface" — where the spreadsheet
 * thinks in cells. This is the translation, and it is the only place that knows
 * both shapes.
 */

const STORED_MODES: StoredMode[] = ['air', 'surface', 'rail'];

export function laneKeyOf(mode: StoredMode, origin: string, destination: string): string {
  return `${mode}:${origin}>${destination}`;
}

/** `grids.surface.minCharge.PNQ.NCR` — the same bind path the diff and review use. */
export function bindPathFor(
  mode: StoredMode,
  rate: RateKey,
  origin: string,
  destination: string,
): string {
  return gridBindPath(mode, rate, origin, destination);
}

export function laneRecord(data: RateCardData): Record<string, LaneRateValues> {
  const lanes: Record<string, LaneRateValues> = {};

  for (const mode of STORED_MODES) {
    const zones = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
    const grids = data.grids[mode];
    for (const origin of zones) {
      for (const destination of zones) {
        lanes[laneKeyOf(mode, origin, destination)] = {
          minCharge: grids.minCharge[origin]?.[destination] ?? null,
          tier1: grids.tier1[origin]?.[destination] ?? null,
          tier2: grids.tier2[origin]?.[destination] ?? null,
          tier3: grids.tier3[origin]?.[destination] ?? null,
        };
      }
    }
  }

  return lanes;
}

/** The charge parameters the lane editor needs to show a live quote. */
export function previewParams(data: RateCardData) {
  return {
    fuelAir: data.charges.fuelAir,
    fuelSurface: data.charges.fuelSurface,
    fuelRail: data.charges.fuelRail,
    gstAir: data.charges.gstAir,
    gstSurface: data.charges.gstSurface,
    docket: data.charges.docket,
    nfoMultiplier: data.charges.nfoMultiplier,
  };
}

export interface LaneSummary {
  mode: StoredMode;
  origin: string;
  destination: string;
  key: string;
  rates: LaneRateValues;
  served: boolean;
  /** True when this lane differs from the comparison basis. */
  changed: boolean;
}

/** Lanes for one mode, with a flag for which differ from a baseline. */
export function lanesForMode(
  data: RateCardData,
  baseline: RateCardData,
  mode: StoredMode,
): LaneSummary[] {
  const zones = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
  const current = data.grids[mode];
  const before = baseline.grids[mode];
  const summaries: LaneSummary[] = [];

  for (const origin of zones) {
    for (const destination of zones) {
      const rates: LaneRateValues = {
        minCharge: current.minCharge[origin]?.[destination] ?? null,
        tier1: current.tier1[origin]?.[destination] ?? null,
        tier2: current.tier2[origin]?.[destination] ?? null,
        tier3: current.tier3[origin]?.[destination] ?? null,
      };
      const changed = (['minCharge', 'tier1', 'tier2', 'tier3'] as RateKey[]).some(
        (rate) => (before[rate][origin]?.[destination] ?? null) !== rates[rate],
      );

      summaries.push({
        mode,
        origin,
        destination,
        key: laneKeyOf(mode, origin, destination),
        rates,
        served: rates.minCharge !== null,
        changed,
      });
    }
  }

  return summaries;
}
