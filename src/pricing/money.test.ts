import { describe, expect, test } from 'vitest';
import { round1, round2 } from './weight';
import {
  toPaise,
  toRupees,
  toGrams,
  add,
  subtract,
  perKg,
  addMilli,
  settleMilli,
  rateOf,
  roundTo,
  exactFraction,
  PAISE,
  TENTH_RUPEE,
} from './money';

/**
 * Regression cover for the floating-point artefact the golden suite caught:
 * Model 3 priced Surface at 12 Rs/kg against a volumetric 53.3 kg and produced
 * 639.5999999999999 instead of 639.60.
 */
describe('round2', () => {
  test('removes the binary floating-point artefact from a rate x weight product', () => {
    expect(12 * 53.3).not.toBe(639.6); // the artefact this exists to fix
    expect(round2(12 * 53.3)).toBe(639.6);
  });

  test('leaves an exact paise value untouched', () => {
    expect(round2(4950)).toBe(4950);
    expect(round2(247.5)).toBe(247.5);
    expect(round2(0)).toBe(0);
  });

  test('rounds a half paise up', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.345)).toBe(2.35);
  });

  test('keeps large totals exact', () => {
    expect(round2(29957.800000000003)).toBe(29957.8);
  });
});

describe('round1', () => {
  test('matches the workbook ROUND(x, 1) used for fuel and GST', () => {
    expect(round1(2262.5 * 0.05)).toBe(113.1); // 113.125 -> 113.1
    expect(round1(13109.4 * 0.18)).toBe(2359.7); // 2359.692 -> 2359.7
    expect(round1(3880 * 0.25)).toBe(970);
  });
});

describe('rupees to paise and back', () => {
  test('two decimal places convert exactly', () => {
    expect(toPaise(530)).toBe(53000);
    expect(toPaise(23.5)).toBe(2350);
    expect(toPaise(86.75)).toBe(8675);
    expect(toPaise(0)).toBe(0);
  });

  test('a value binary cannot hold still converts exactly', () => {
    // 0.07 * 100 is 7.000000000000001 and 1.005 * 100 is 100.49999999999999, which is
    // how a float engine loses a paisa. Reading the digits avoids the multiplication.
    expect(toPaise(0.07)).toBe(7);
    expect(toPaise(1.005)).toBe(101);
    expect(toPaise(2.675)).toBe(268);
  });

  test('converting back is only for display, and round-trips', () => {
    expect(toRupees(toPaise(2375.6))).toBe(2375.6);
    expect(toRupees(toPaise(0.01))).toBe(0.01);
  });

  test('a weight becomes whole grams', () => {
    expect(toGrams(53.3)).toBe(53300);
    expect(toGrams(0.5)).toBe(500);
    expect(toGrams(1)).toBe(1000);
    expect(toGrams(0.001)).toBe(1);
  });
});

describe('exactFraction', () => {
  test('reads a rate as an exact fraction of a power of ten', () => {
    expect(exactFraction(0.05)).toEqual({ numerator: 5, denominator: 100 });
    expect(exactFraction(0.18)).toEqual({ numerator: 18, denominator: 100 });
    expect(exactFraction(0.0033)).toEqual({ numerator: 33, denominator: 10000 });
    expect(exactFraction(0.35)).toEqual({ numerator: 35, denominator: 100 });
    expect(exactFraction(1)).toEqual({ numerator: 1, denominator: 1 });
  });
});

describe('addition of amounts', () => {
  test('a sum of parts always equals the total, which is the whole point', () => {
    const parts = [toPaise(530), toPaise(400), toPaise(800), toPaise(432.5), toPaise(100)];
    expect(add(...parts)).toBe(226250);
    expect(toRupees(add(...parts))).toBe(2262.5);
  });

  test('a hundred thirds add up to exactly what they add up to', () => {
    // The float version of this drifts: 0.01 added a hundred times is 1.0000000000000007.
    const penny = toPaise(0.01);
    let total = toPaise(0);
    for (let i = 0; i < 100; i++) total = add(total, penny);
    expect(total).toBe(100);
    expect(toRupees(total)).toBe(1);
  });

  test('subtraction is exact too', () => {
    expect(subtract(toPaise(600), toPaise(60))).toBe(54000);
  });
});

describe('a rate per kg against a weight', () => {
  test('the artefact that started all this is gone by construction', () => {
    // 12 x 53.3 in floats is 639.5999999999999.
    const freight = settleMilli(perKg(toPaise(12), toGrams(53.3)));
    expect(freight).toBe(63960);
    expect(toRupees(freight)).toBe(639.6);
  });

  test('slabs are summed before rounding, not rounded one at a time', () => {
    // Three slabs each landing on exactly half a paise: 1 paise/kg over 0.5 kg.
    // Rounded one at a time each would go up to a full paise and the freight would be 3.
    // Summed first it is 1.5 paise, which settles to 2 — one rounding, where the workbook
    // does one.
    const half = perKg(toPaise(0.01), toGrams(0.5));
    expect(half).toBe(500); // half a paise, in thousandths
    expect(settleMilli(addMilli(half, half, half))).toBe(2);
    expect(settleMilli(half) * 3).toBe(3); // what rounding each would have given
  });

  test('a fractional weight against a fractional rate stays exact', () => {
    expect(toRupees(settleMilli(perKg(toPaise(23.5), toGrams(0.55))))).toBe(12.93); // 12.925 -> 12.93
  });
});

describe('a percentage of an amount', () => {
  test('fuel and GST round to a tenth of a rupee, as the workbooks do', () => {
    // The fixture case: 5% GST on a taxable value of 2,262.50 is 113.125, and every
    // signed card was agreed on 113.10.
    expect(toRupees(rateOf(toPaise(2262.5), 0.05, TENTH_RUPEE))).toBe(113.1);
    expect(toRupees(rateOf(toPaise(13109.4), 0.18, TENTH_RUPEE))).toBe(2359.7);
    expect(toRupees(rateOf(toPaise(3880), 0.25, TENTH_RUPEE))).toBe(970);
  });

  test('the same figures agree with the float rule they replace', () => {
    // Belt and braces: the integer path must land where round1 landed, on the values the
    // workbooks produced, or the fixtures would be the thing that noticed.
    for (const [amount, rate] of [
      [2262.5, 0.05],
      [13109.4, 0.18],
      [3880, 0.25],
      [1730, 0.25],
      [29957.8, 0.18],
    ] as const) {
      expect(toRupees(rateOf(toPaise(amount), rate, TENTH_RUPEE))).toBe(round1(amount * rate));
    }
  });

  test('to the paisa when nothing coarser is asked for', () => {
    expect(toRupees(rateOf(toPaise(2262.5), 0.05, PAISE))).toBe(113.13);
    expect(toRupees(rateOf(toPaise(100), 0.0033, PAISE))).toBe(0.33);
  });

  test('a half rounds away from zero, matching Excel rather than the bankers', () => {
    // 5 paise exactly, at a tenth-of-a-rupee granularity, goes up.
    expect(toRupees(rateOf(toPaise(1), 0.05, PAISE))).toBe(0.05);
    expect(roundTo(toPaise(0.05), TENTH_RUPEE)).toBe(10);
    expect(roundTo(toPaise(0.04), TENTH_RUPEE)).toBe(0);
  });

  test('a percentage of nothing is nothing', () => {
    expect(rateOf(toPaise(0), 0.18, TENTH_RUPEE)).toBe(0);
  });
});

describe('the guards', () => {
  test('a rate or amount that is not a number is refused rather than propagated', () => {
    expect(() => toPaise(Number.NaN)).toThrow(/not an amount/);
    expect(() => toGrams(Number.POSITIVE_INFINITY)).toThrow(/not a weight/);
  });

  test('an absurd product is refused rather than silently made up', () => {
    expect(() => perKg(toPaise(1e12), 1e6)).toThrow(/exactly/);
  });
});

describe('float noise arriving from outside', () => {
  /**
   * An NFO rate is a stored rate times a multiplier, and a surface weight can arrive from
   * a volumetric division. Both produce values like 0.30000000000000004, whose seventeen
   * digits are representation noise rather than a price. Reading them literally overflowed
   * exact integer range and threw — which is a worse failure than the drift this module
   * exists to remove.
   */
  test('a noisy amount converts to what was meant, rather than throwing', () => {
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(toPaise(0.07 * 3)).toBe(21);
    expect(toPaise(23.5 * 2)).toBe(4700);
  });

  test('a noisy weight converts to whole grams', () => {
    expect(toGrams(53.30000000000001)).toBe(53300);
    expect(toGrams(0.1 + 0.2)).toBe(300);
  });

  test('a long but deliberate decimal is taken to six places', () => {
    expect(toPaise(12345.678901234567)).toBe(1234568);
  });

  test('an amount far below a paisa is nothing, not an error', () => {
    expect(toPaise(1e-8)).toBe(0);
  });

  test('a genuinely absurd magnitude is still refused rather than made up', () => {
    expect(() => toPaise(1e15)).toThrow(/exactly/);
  });
});
