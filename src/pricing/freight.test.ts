import { describe, expect, test } from 'vitest';
import { computeFreight, applicableTierRate } from './freight';
import type { LaneRates } from './freight';

/**
 * Surface PNQ->NCR, as it stands in each source workbook. The three models hold
 * different tier numbers on the same lane, which is why each gets its own set.
 * Every expected value below is what the workbook itself computed -- see
 * src/pricing/__fixtures__/golden.json.
 */
const M1_SURFACE: LaneRates = { minCharge: 530, tier1: 15, tier2: 14, tier3: 12 };
const M2_SURFACE: LaneRates = { minCharge: 530, tier1: 15, tier2: 14, tier3: 13 };
const M3_SURFACE: LaneRates = { minCharge: 530, tier1: 12, tier2: 12, tier3: 12 };
const SURFACE_MIN_WEIGHT = 50;

describe('applicableTierRate', () => {
  test('uses tier 1 up to and including 100 kg', () => {
    expect(applicableTierRate(50, M1_SURFACE)).toBe(15);
    expect(applicableTierRate(100, M1_SURFACE)).toBe(15);
  });

  test('uses tier 2 above 100 kg up to and including 300 kg', () => {
    expect(applicableTierRate(101, M1_SURFACE)).toBe(14);
    expect(applicableTierRate(300, M1_SURFACE)).toBe(14);
  });

  test('uses tier 3 above 300 kg', () => {
    expect(applicableTierRate(301, M1_SURFACE)).toBe(12);
    expect(applicableTierRate(1000, M1_SURFACE)).toBe(12);
  });
});

describe('computeFreight — CUMULATIVE_SLABS (Model 1)', () => {
  const freight = (weight: number) =>
    computeFreight('CUMULATIVE_SLABS', weight, SURFACE_MIN_WEIGHT, M1_SURFACE);

  test('bills only the minimum charge at or below the minimum weight', () => {
    expect(freight(50)).toBe(530);
  });

  test('adds tier 1 for weight between the minimum and 100 kg', () => {
    expect(freight(51)).toBe(545); // 530 + 15 x 1
    expect(freight(99)).toBe(1265); // 530 + 15 x 49
    expect(freight(100)).toBe(1280); // 530 + 15 x 50
  });

  test('adds tier 2 only for the portion above 100 kg', () => {
    expect(freight(101)).toBe(1294); // 530 + 15x50 + 14x1
    expect(freight(200)).toBe(2680); // 530 + 750 + 14x100
    expect(freight(300)).toBe(4080); // 530 + 750 + 14x200
  });

  test('adds tier 3 only for the portion above 300 kg', () => {
    expect(freight(301)).toBe(4092); // 4080 + 12x1
    expect(freight(500)).toBe(6480); // 4080 + 12x200
    expect(freight(1000)).toBe(12480); // 4080 + 12x700
  });
});

describe('computeFreight — MIN_PLUS_EXCESS (Model 2)', () => {
  const freight = (weight: number) =>
    computeFreight('MIN_PLUS_EXCESS', weight, SURFACE_MIN_WEIGHT, M2_SURFACE);

  test('bills only the minimum charge at the minimum weight', () => {
    expect(freight(50)).toBe(530);
  });

  test('applies the single applicable rate to the weight above the minimum', () => {
    expect(freight(51)).toBe(545); // 530 + 15 x (51-50)
    expect(freight(100)).toBe(1280); // 530 + 15 x 50
    expect(freight(200)).toBe(2630); // 530 + 14 x 150
    expect(freight(300)).toBe(4030); // 530 + 14 x 250
    expect(freight(1000)).toBe(12880); // 530 + 13 x 950
  });

  test('switching tier can make a heavier shipment cheaper', () => {
    // Structural to this method: at 301 kg the whole excess reprices at tier 3.
    // Confirmed against the workbook, not an implementation artefact.
    expect(freight(300)).toBe(4030);
    expect(freight(301)).toBe(3793); // 530 + 13 x 251
  });
});

describe('computeFreight — MAX_MIN_OR_FULL (Model 3)', () => {
  const freight = (weight: number) =>
    computeFreight('MAX_MIN_OR_FULL', weight, SURFACE_MIN_WEIGHT, M3_SURFACE);

  test('bills the rate against the full weight when that beats the minimum', () => {
    expect(freight(50)).toBe(600); // max(530, 12 x 50)
    expect(freight(51)).toBe(612); // max(530, 12 x 51)
    expect(freight(200)).toBe(2400); // max(530, 12 x 200)
    expect(freight(1000)).toBe(12000);
  });

  test('bills the minimum charge when the rate against full weight is lower', () => {
    // Air PNQ->NCR in Model 3: minimum 1890 beats 63 x 26 = 1638.
    const air: LaneRates = { minCharge: 1890, tier1: 63, tier2: 46, tier3: 33 };
    expect(computeFreight('MAX_MIN_OR_FULL', 26, 25, air)).toBe(1890);
  });

  test('applies the tier rate to the full weight, not just the excess', () => {
    const air: LaneRates = { minCharge: 1890, tier1: 63, tier2: 46, tier3: 33 };
    expect(computeFreight('MAX_MIN_OR_FULL', 100, 25, air)).toBe(6300); // 63 x 100
    expect(computeFreight('MAX_MIN_OR_FULL', 101, 25, air)).toBe(4646); // 46 x 101
  });
});

describe('computeFreight — unavailable lanes', () => {
  test('returns null when the lane has no minimum charge', () => {
    const unavailable: LaneRates = { minCharge: null, tier1: null, tier2: null, tier3: null };
    expect(computeFreight('CUMULATIVE_SLABS', 200, 25, unavailable)).toBeNull();
    expect(computeFreight('MIN_PLUS_EXCESS', 200, 25, unavailable)).toBeNull();
    expect(computeFreight('MAX_MIN_OR_FULL', 200, 25, unavailable)).toBeNull();
  });

  test('treats a missing tier rate as zero rather than failing', () => {
    // The workbook's ISNUMBER guard contributes nothing for a non-numeric rate.
    const partial: LaneRates = { minCharge: 530, tier1: null, tier2: null, tier3: null };
    expect(computeFreight('CUMULATIVE_SLABS', 200, 50, partial)).toBe(530);
  });
});
