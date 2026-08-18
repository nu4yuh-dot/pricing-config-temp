import { describe, expect, test } from 'vitest';
import { chargeableWeight } from './weight';

const AIR = { minWeight: 25, volumetricDivisor: 5000 };
const SURFACE = { minWeight: 50, volumetricDivisor: 4500 };

describe('chargeableWeight', () => {
  test('bills the mode minimum when actual weight is below it', () => {
    expect(chargeableWeight({ actualWeight: 10 }, SURFACE)).toBe(50);
  });

  test('bills actual weight when it exceeds the minimum', () => {
    expect(chargeableWeight({ actualWeight: 200 }, SURFACE)).toBe(200);
  });

  test('bills volumetric weight when it exceeds actual weight', () => {
    // 2 pieces of 100x100x100 cm on air: 1,000,000 x 2 / 5000 = 400 kg
    const result = chargeableWeight(
      { actualWeight: 10, length: 100, breadth: 100, height: 100, pieces: 2 },
      AIR,
    );
    expect(result).toBe(400);
  });

  test('ignores dimensions when any one of them is zero', () => {
    const result = chargeableWeight(
      { actualWeight: 200, length: 100, breadth: 0, height: 100, pieces: 1 },
      SURFACE,
    );
    expect(result).toBe(200);
  });

  test('treats a missing piece count as one piece', () => {
    // 80x60x50 = 240,000 / 4500 = 53.3 kg, above the 50 kg surface minimum
    const result = chargeableWeight(
      { actualWeight: 10, length: 80, breadth: 60, height: 50 },
      SURFACE,
    );
    expect(result).toBe(53.3);
  });

  test('rounds volumetric weight to one decimal place', () => {
    // 80x60x50 x 1 / 4500 = 53.333... -> 53.3
    const result = chargeableWeight(
      { actualWeight: 0, length: 80, breadth: 60, height: 50 },
      SURFACE,
    );
    expect(result).toBe(53.3);
  });
});
