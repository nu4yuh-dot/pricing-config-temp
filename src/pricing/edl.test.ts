import { describe, expect, test } from 'vitest';
import { odaSurcharge } from './edl';
import type { EdlMatrix } from '../domain/types';

/** The EDL Matrix as it stands in the source workbooks. */
const EDL: EdlMatrix = {
  kmBands: [20, 51, 101, 151, 201, 251, 301, 401],
  weightBands: [0, 101, 251, 501, 1001],
  rates: [
    [550, 990, 1100, 1375, 1650],
    [825, 1210, 1375, 1650, 1925],
    [1100, 1650, 1925, 2200, 2750],
    [1375, 1925, 2200, 2475, 3300],
    [1650, 2200, 2750, 3300, 3960],
    [1925, 2500, 3150, 3800, 4560],
    [2475, 3100, 3950, 4800, 5760],
    [3025, 3700, 4750, 5800, 6960],
  ],
  perKmBeyondLastBand: 14,
  perKmThreshold: 500,
};

describe('odaSurcharge', () => {
  test('is zero for a destination inside the service town', () => {
    expect(odaSurcharge(0, 200, EDL)).toBe(0);
  });

  test('is zero for a negative distance', () => {
    expect(odaSurcharge(-5, 200, EDL)).toBe(0);
  });

  test('is zero below the lowest km band', () => {
    // The workbook's approximate MATCH finds nothing below 20 km and yields 0.
    expect(odaSurcharge(19, 200, EDL)).toBe(0);
  });

  test('picks the largest km band at or below the distance', () => {
    // 55 km falls in the 51 km band; 100 kg falls in the 0-100 weight band.
    expect(odaSurcharge(55, 100, EDL)).toBe(825);
  });

  test('picks the largest weight band at or below the chargeable weight', () => {
    expect(odaSurcharge(55, 200, EDL)).toBe(1210);
    expect(odaSurcharge(55, 300, EDL)).toBe(1375);
  });

  test('uses the exact rate when distance sits on a band boundary', () => {
    expect(odaSurcharge(20, 50, EDL)).toBe(550);
    expect(odaSurcharge(101, 101, EDL)).toBe(1650);
  });

  test('charges per km beyond the per-km threshold, ignoring weight', () => {
    expect(odaSurcharge(530, 100, EDL)).toBe(7420);
    expect(odaSurcharge(530, 600, EDL)).toBe(7420);
  });

  test('still uses the banded rate at exactly the per-km threshold', () => {
    // 500 km is not beyond 500, so it uses the 401 km band.
    expect(odaSurcharge(500, 100, EDL)).toBe(3025);
  });
});
