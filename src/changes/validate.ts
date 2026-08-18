import type { FreightMethod, RateCardData, StoredMode } from '../domain/types';
import { TIER2_FROM, TIER3_FROM } from '../domain/types';
import { AIR_ZONES, SURFACE_ZONES } from '../domain/zones';
import { computeFreight, type LaneRates } from '../pricing/freight';
import { editableCellIndex, type Change } from './diff';
import type { BindPath } from '../sheets/types';

/**
 * Validation never blocks a submission. It annotates, so that a reviewer looking at
 * a thousand changed cells knows which handful deserve a second look.
 */
export interface Finding {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  bind?: BindPath;
  sheet?: string;
  cellRef?: string;
}

export interface ValidationOptions {
  /** Flag any change moving a value by more than this percentage. */
  movementThresholdPct: number;
  /** Flag a lane whose reverse direction differs by more than this percentage. */
  asymmetryThresholdPct: number;
  /**
   * Flag weights where crossing a tier boundary makes a shipment cheaper.
   * Structural to Models 2 and 3; switch off if that is a deliberate volume
   * incentive rather than a mistake.
   */
  checkMonotonicPricing: boolean;
}

export const DEFAULT_VALIDATION_OPTIONS: ValidationOptions = {
  movementThresholdPct: 10,
  asymmetryThresholdPct: 100,
  checkMonotonicPricing: true,
};

const MODE_ZONES: Record<StoredMode, readonly string[]> = {
  air: AIR_ZONES,
  surface: SURFACE_ZONES,
  rail: SURFACE_ZONES,
};

const MODE_LABELS: Record<StoredMode, string> = {
  air: 'Air',
  surface: 'Surface',
  rail: 'Rail',
};

function lane(data: RateCardData, mode: StoredMode, origin: string, dest: string): LaneRates {
  const grids = data.grids[mode];
  return {
    minCharge: grids.minCharge[origin]?.[dest] ?? null,
    tier1: grids.tier1[origin]?.[dest] ?? null,
    tier2: grids.tier2[origin]?.[dest] ?? null,
    tier3: grids.tier3[origin]?.[dest] ?? null,
  };
}

function minWeightFor(data: RateCardData, mode: StoredMode): number {
  return mode === 'air' ? data.charges.minWeightAir : data.charges.minWeightSurface;
}

function locate(
  index: Map<BindPath, { sheet: string; cellRef: string }>,
  bind: BindPath,
): { sheet?: string; cellRef?: string } {
  const cell = index.get(bind);
  return cell ? { sheet: cell.sheet, cellRef: cell.cellRef } : {};
}

/**
 * Checks that depend only on the card's own contents, not on what changed. Run
 * these while the team edits, so a mistake surfaces before it is submitted.
 */
export function validateCard(
  data: RateCardData,
  method: FreightMethod,
  options: ValidationOptions = DEFAULT_VALIDATION_OPTIONS,
): Finding[] {
  const findings: Finding[] = [];
  const index = editableCellIndex(data);

  for (const mode of ['air', 'surface', 'rail'] as StoredMode[]) {
    const zones = MODE_ZONES[mode];
    const modeLabel = MODE_LABELS[mode];
    const minWeight = minWeightFor(data, mode);

    for (const origin of zones) {
      for (const dest of zones) {
        const rates = lane(data, mode, origin, dest);
        const laneName = `${origin}→${dest}`;
        if (rates.minCharge === null) continue;

        // Every rate sheet header promises rates that step down by weight.
        const tiers = [
          ['tier1', rates.tier1],
          ['tier2', rates.tier2],
          ['tier3', rates.tier3],
        ] as const;
        for (let i = 1; i < tiers.length; i++) {
          const [name, current] = tiers[i] as readonly [string, number | null];
          const [previousName, previous] = tiers[i - 1] as readonly [string, number | null];
          if (current === null || previous === null) continue;
          if (current > previous) {
            const bind = `grids.${mode}.${name}.${origin}.${dest}`;
            findings.push({
              code: 'tiers-not-decremental',
              severity: 'warning',
              message:
                `${modeLabel} ${laneName}: ${name} (${current}/kg) is higher than ` +
                `${previousName} (${previous}/kg). Rates are meant to step down by weight.`,
              bind,
              ...locate(index, bind),
            });
          }
        }

        // Zero or negative would quote a free or paid-to-ship consignment.
        for (const [name, value] of [['minCharge', rates.minCharge], ...tiers] as const) {
          if (value !== null && value <= 0) {
            const bind = `grids.${mode}.${name}.${origin}.${dest}`;
            findings.push({
              code: 'non-positive-rate',
              severity: 'warning',
              message: `${modeLabel} ${laneName}: ${name} is ${value}, which cannot be charged.`,
              bind,
              ...locate(index, bind),
            });
          }
        }

        if (options.checkMonotonicPricing) {
          for (const boundary of [TIER2_FROM, TIER3_FROM]) {
            const below = computeFreight(method, boundary, minWeight, rates);
            const above = computeFreight(method, boundary + 1, minWeight, rates);
            if (below === null || above === null || above >= below) continue;
            const bind = `grids.${mode}.${boundary === TIER2_FROM ? 'tier2' : 'tier3'}.${origin}.${dest}`;
            findings.push({
              code: 'price-falls-as-weight-rises',
              severity: 'warning',
              message:
                `${modeLabel} ${laneName}: ${boundary + 1} kg is cheaper than ${boundary} kg ` +
                `(Rs ${above} against Rs ${below}). A customer shipping ${boundary} kg pays ` +
                `Rs ${Math.round((below - above) * 100) / 100} more than one shipping a kilo extra.`,
              bind,
              ...locate(index, bind),
            });
          }
        }

        // Near-symmetry holds throughout the source data, so a large divergence is
        // usually a typo rather than a deliberate directional rate.
        if (origin < dest) {
          const reverse = lane(data, mode, dest, origin);
          if (reverse.minCharge !== null && reverse.minCharge > 0) {
            const divergence =
              (Math.abs(rates.minCharge - reverse.minCharge) / reverse.minCharge) * 100;
            if (divergence > options.asymmetryThresholdPct) {
              const bind = `grids.${mode}.minCharge.${origin}.${dest}`;
              findings.push({
                code: 'asymmetric-lane',
                severity: 'info',
                message:
                  `${modeLabel} ${laneName} minimum charge is Rs ${rates.minCharge} but ` +
                  `${dest}→${origin} is Rs ${reverse.minCharge} — ` +
                  `${divergence.toFixed(0)}% apart.`,
                bind,
                ...locate(index, bind),
              });
            }
          }
        }
      }
    }
  }

  return findings;
}

/** Paths whose edits reprice everything at once, so they warrant extra scrutiny. */
const GLOBAL_PREFIXES = ['charges.', 'edlMatrix.'];

/** Checks that depend on what moved, shown alongside the diff in the review queue. */
export function validateChanges(
  changes: Change[],
  options: ValidationOptions = DEFAULT_VALIDATION_OPTIONS,
): Finding[] {
  const findings: Finding[] = [];

  for (const change of changes) {
    const where = { bind: change.bind, sheet: change.sheet, cellRef: change.cellRef };

    if (change.pctChange !== null && Math.abs(change.pctChange) > options.movementThresholdPct) {
      findings.push({
        code: 'large-movement',
        severity: 'warning',
        message:
          `${change.label}: ${change.oldValue} → ${change.newValue}, ` +
          `a change of ${change.pctChange.toFixed(1)}%.`,
        ...where,
      });
    }

    const isMinCharge = change.bind.includes('.minCharge.');
    if (isMinCharge && change.oldValue !== null && change.newValue === null) {
      findings.push({
        code: 'lane-withdrawn',
        severity: 'warning',
        message: `${change.label}: this lane will no longer be quoted for this mode.`,
        ...where,
      });
    }
    if (isMinCharge && change.oldValue === null && change.newValue !== null) {
      findings.push({
        code: 'lane-opened',
        severity: 'info',
        message: `${change.label}: this lane will start being quoted for this mode.`,
        ...where,
      });
    }

    if (GLOBAL_PREFIXES.some((prefix) => change.bind.startsWith(prefix))) {
      findings.push({
        code: 'global-parameter',
        severity: 'warning',
        message:
          `${change.label} applies to every lane on this card. ` +
          `Changing it reprices all quotes at once.`,
        ...where,
      });
    }
  }

  return findings;
}
