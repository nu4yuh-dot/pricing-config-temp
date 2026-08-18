import { describe, expect, test } from 'vitest';
import { railChargeableWeight } from './weight';

const SURFACE = { minWeight: 50, volumetricDivisor: 4500 };

/**
 * The railway parcel norm: a single package at or above 100 kg is billed at twice
 * its weight. Confirmed against the workbooks' own output (see golden fixtures
 * `rail-heavy-package` and `rail-heavy-package-below-threshold`).
 */
describe('railChargeableWeight', () => {
  test('doubles the weight of a single package at or above the threshold', () => {
    const result = railChargeableWeight(
      { actualWeight: 150 },
      SURFACE,
      { singlePackage: true, threshold: 100, multiplier: 2 },
    );
    expect(result).toBe(300);
  });

  test('does not double a single package below the threshold', () => {
    const result = railChargeableWeight(
      { actualWeight: 99 },
      SURFACE,
      { singlePackage: true, threshold: 100, multiplier: 2 },
    );
    expect(result).toBe(99);
  });

  test('does not double when the shipment is not a single package', () => {
    const result = railChargeableWeight(
      { actualWeight: 150 },
      SURFACE,
      { singlePackage: false, threshold: 100, multiplier: 2 },
    );
    expect(result).toBe(150);
  });

  test('doubling bypasses the mode minimum and volumetric weight', () => {
    // 100 kg doubled is 200, even though volumetric here would be 400 kg.
    const result = railChargeableWeight(
      { actualWeight: 100, length: 100, breadth: 100, height: 100, pieces: 2 },
      { minWeight: 500, volumetricDivisor: 4500 },
      { singlePackage: true, threshold: 100, multiplier: 2 },
    );
    expect(result).toBe(200);
  });

  test('falls back to the normal rule below the threshold, honouring the minimum', () => {
    const result = railChargeableWeight(
      { actualWeight: 10 },
      SURFACE,
      { singlePackage: true, threshold: 100, multiplier: 2 },
    );
    expect(result).toBe(50);
  });
});
