import { computeFreight, computeFreightPaise, type LaneRates } from './freight';
import { subtract, toPaise, toRupees, type Paise } from './money';
import type { FreightMethod } from '../domain/types';

/**
 * Cost basis and margin.
 *
 * The engine previously knew only what to charge, never what a lane costs. That made
 * three things impossible: seeing margin while editing a rate, flagging a loss-making
 * lane at approval, and reconciling a coloader's bill. All three need the buy side.
 *
 * Buy cost is held in the same shape as sell — a minimum plus per-kg tiers — because
 * that is how coloader tariffs are actually quoted, and it means the same freight
 * function prices both sides.
 */

export interface CostBasis {
  /** Who the buy rate is with, e.g. "Surya Cargo". Appears on margin displays. */
  carrier: string;
  /** Same four-grid shape as sell, so `computeFreight` works on it unchanged. */
  rates: LaneRates;
  /** Cost tariffs are usually simple; cumulative slabs is the safe default. */
  method: FreightMethod;
  minWeight: number;
}

export interface Margin {
  sell: number;
  buy: number;
  profit: number;
  /** As a fraction of sell. Null when sell is zero — a percentage would be nonsense. */
  ratio: number | null;
  /** Below the configured floor. */
  thin: boolean;
  /** Selling under cost. */
  loss: boolean;
  carrier: string;
}

/** Default floor. Below this an approval is flagged rather than blocked. */
export const DEFAULT_MARGIN_FLOOR = 0.08;

/**
 * Margin on one lane at one weight.
 *
 * Compares like with like: both sides are freight only, before fuel, cartage and tax.
 * Mixing a landed sell price against a bare buy rate would flatter every lane.
 */
export function marginFor(input: {
  /** The sell freight in paise, as the engine computed it. */
  sellFreightPaise: Paise;
  cost: CostBasis;
  chargeableWeight: number;
  floor?: number;
}): Margin | null {
  const buyPaise = computeFreightPaise(
    input.cost.method,
    input.chargeableWeight,
    input.cost.minWeight,
    input.cost.rates,
  );
  // No buy rate for the lane means no honest margin — better to say nothing than to
  // report a 100% margin against a cost of zero.
  if (buyPaise === null) return null;

  // Compared as integers, so a margin of exactly zero reads as zero rather than as a
  // profit of 4.5e-14 — which is what decided `loss` before.
  const profitPaise = subtract(input.sellFreightPaise, buyPaise);
  const buy = toRupees(buyPaise);
  const sell = toRupees(input.sellFreightPaise);
  const profit = toRupees(profitPaise);
  const ratio = input.sellFreightPaise === 0 ? null : profitPaise / input.sellFreightPaise;
  const floor = input.floor ?? DEFAULT_MARGIN_FLOOR;

  return {
    sell,
    buy,
    profit,
    ratio,
    thin: ratio !== null && ratio < floor && profitPaise >= 0,
    loss: profitPaise < 0,
    carrier: input.cost.carrier,
  };
}

export interface MarginFinding {
  code: 'margin-below-floor' | 'selling-below-cost';
  severity: 'warning';
  message: string;
  lane: string;
  weight: number;
  margin: Margin;
}

/**
 * Check a lane across several weights.
 *
 * One weight is not enough: a decremental tier structure can be healthy at 200 kg and
 * under water at 1000 kg, because the top tier is where the margin is thinnest.
 */
export function checkLaneMargin(input: {
  lane: string;
  sellRates: LaneRates;
  sellMethod: FreightMethod;
  sellMinWeight: number;
  cost: CostBasis;
  weights?: number[];
  floor?: number;
}): MarginFinding[] {
  const weights = input.weights ?? [50, 100, 300, 500, 1000];
  const findings: MarginFinding[] = [];

  for (const weight of weights) {
    const sell = computeFreightPaise(input.sellMethod, weight, input.sellMinWeight, input.sellRates);
    if (sell === null) continue;

    const margin = marginFor({
      sellFreightPaise: sell,
      cost: input.cost,
      chargeableWeight: weight,
      ...(input.floor === undefined ? {} : { floor: input.floor }),
    });
    if (!margin) continue;

    const pct = margin.ratio === null ? '—' : `${(margin.ratio * 100).toFixed(1)}%`;

    if (margin.loss) {
      findings.push({
        code: 'selling-below-cost',
        severity: 'warning',
        message:
          `${input.lane} at ${weight} kg sells for ₹${margin.sell} against a ` +
          `${margin.carrier} cost of ₹${margin.buy} — a loss of ₹${Math.abs(margin.profit)}.`,
        lane: input.lane,
        weight,
        margin,
      });
    } else if (margin.thin) {
      findings.push({
        code: 'margin-below-floor',
        severity: 'warning',
        message:
          `${input.lane} at ${weight} kg makes ${pct} against the ` +
          `${((input.floor ?? DEFAULT_MARGIN_FLOOR) * 100).toFixed(0)}% floor ` +
          `(sell ₹${margin.sell}, ${margin.carrier} cost ₹${margin.buy}).`,
        lane: input.lane,
        weight,
        margin,
      });
    }
  }

  return findings;
}
