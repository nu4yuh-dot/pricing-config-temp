import { toPaise as P } from './money';
import { describe, expect, test } from 'vitest';
import { marginFor, checkLaneMargin, DEFAULT_MARGIN_FLOOR, type CostBasis } from './margin';
import type { LaneRates } from './freight';

/** Surya Cargo buy tariff for PNQ→NCR, in the same shape as a sell rate. */
const cost: CostBasis = {
  carrier: 'Surya Cargo',
  rates: { minCharge: 470, tier1: 12, tier2: 11.4, tier3: 10 },
  method: 'CUMULATIVE_SLABS',
  minWeight: 50,
};

const sellRates: LaneRates = { minCharge: 530, tier1: 15, tier2: 14, tier3: 12 };

describe('marginFor', () => {
  test('computes profit and ratio against the buy cost', () => {
    // sell 2680 at 200 kg; buy = 470 + 50x12 + 100x11.4 = 2210
    const margin = marginFor({ sellFreightPaise: P(2680), cost, chargeableWeight: 200 });
    expect(margin?.buy).toBe(2210);
    expect(margin?.profit).toBe(470);
    expect(margin?.ratio).toBeCloseTo(0.1754, 3);
  });

  test('names the carrier, so a margin figure is attributable', () => {
    expect(marginFor({ sellFreightPaise: P(2680), cost, chargeableWeight: 200 })?.carrier).toBe(
      'Surya Cargo',
    );
  });

  test('flags a thin margin without calling it a loss', () => {
    const margin = marginFor({ sellFreightPaise: P(2300), cost, chargeableWeight: 200 });
    expect(margin?.thin).toBe(true);
    expect(margin?.loss).toBe(false);
  });

  test('flags selling below cost as a loss, not merely thin', () => {
    const margin = marginFor({ sellFreightPaise: P(2000), cost, chargeableWeight: 200 });
    expect(margin?.loss).toBe(true);
    expect(margin?.thin).toBe(false);
    expect(margin?.profit).toBeLessThan(0);
  });

  test('honours a custom floor', () => {
    const at = (floor: number) =>
      marginFor({ sellFreightPaise: P(2680), cost, chargeableWeight: 200, floor })?.thin;
    expect(at(0.1)).toBe(false);
    expect(at(0.25)).toBe(true);
  });

  test('the default floor is 8%', () => {
    expect(DEFAULT_MARGIN_FLOOR).toBe(0.08);
  });

  /**
   * Reporting a margin against a cost of zero would flatter every unpriced lane, so
   * no buy rate means no margin rather than a fabricated one.
   */
  test('returns nothing when the lane has no buy rate', () => {
    const noCost: CostBasis = {
      ...cost,
      rates: { minCharge: null, tier1: null, tier2: null, tier3: null },
    };
    expect(marginFor({ sellFreightPaise: P(2680), cost: noCost, chargeableWeight: 200 })).toBeNull();
  });

  test('reports a null ratio rather than dividing by zero', () => {
    const margin = marginFor({ sellFreightPaise: P(0), cost, chargeableWeight: 200 });
    expect(margin?.ratio).toBeNull();
  });
});

describe('checkLaneMargin', () => {
  const check = (rates: LaneRates, floor?: number) =>
    checkLaneMargin({
      lane: 'Surface PNQ→NCR',
      sellRates: rates,
      sellMethod: 'CUMULATIVE_SLABS',
      sellMinWeight: 50,
      cost,
      ...(floor === undefined ? {} : { floor }),
    });

  test('is quiet on a healthy lane', () => {
    expect(check(sellRates)).toEqual([]);
  });

  /**
   * The point of sweeping weights: a decremental structure can be healthy at 200 kg
   * and under water at 1000 kg, because the top tier is the thinnest.
   */
  test('catches a lane that is only unprofitable at heavy weights', () => {
    // tier3 below the buy tier3 of 10, so the loss appears above 300 kg only.
    const findings = check({ minCharge: 530, tier1: 15, tier2: 14, tier3: 6 });
    expect(findings.length).toBeGreaterThan(0);
    const weights = findings.map((f) => f.weight);
    expect(weights).not.toContain(100);
    expect(weights).toContain(1000);
  });

  test('distinguishes a loss from a thin margin in the code it reports', () => {
    const loss = check({ minCharge: 300, tier1: 5, tier2: 5, tier3: 5 });
    expect(loss.some((f) => f.code === 'selling-below-cost')).toBe(true);

    const thin = check(sellRates, 0.5);
    expect(thin.every((f) => f.code === 'margin-below-floor')).toBe(true);
  });

  test('names the lane, the weight and the carrier in the message', () => {
    const findings = check(sellRates, 0.5);
    expect(findings[0]?.message).toMatch(/Surface PNQ→NCR/);
    expect(findings[0]?.message).toMatch(/Surya Cargo/);
    expect(findings[0]?.message).toMatch(/kg/);
  });

  test('quotes the floor it was measured against', () => {
    expect(check(sellRates, 0.5)[0]?.message).toMatch(/50% floor/);
  });

  test('skips weights the lane cannot be sold at', () => {
    const unserved: LaneRates = { minCharge: null, tier1: null, tier2: null, tier3: null };
    expect(check(unserved)).toEqual([]);
  });

  test('can be asked about specific weights only', () => {
    const findings = checkLaneMargin({
      lane: 'x',
      sellRates: { minCharge: 300, tier1: 5, tier2: 5, tier3: 5 },
      sellMethod: 'CUMULATIVE_SLABS',
      sellMinWeight: 50,
      cost,
      weights: [1000],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.weight).toBe(1000);
  });
});
