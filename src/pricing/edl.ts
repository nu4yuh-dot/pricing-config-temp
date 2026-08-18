import {
  perKg,
  settleMilli,
  toGrams,
  toPaise,
  toRupees,
  ZERO,
  type Paise,
} from './money';
import type { EdlMatrix } from '../domain/types';

/**
 * Index of the largest band value at or below `value`, or -1 if `value` sits
 * below every band. This reproduces the source workbook's `MATCH(value, range, 1)`,
 * which requires an ascending range and returns an error below the first entry --
 * an error the workbook swallows with IFERROR, yielding 0.
 */
function approximateBandIndex(value: number, bands: readonly number[]): number {
  let index = -1;
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    if (band === undefined || band > value) break;
    index = i;
  }
  return index;
}

/**
 * ODA / EDL surcharge in Rs per shipment for one leg (origin or destination).
 *
 * Distances beyond `perKmThreshold` are charged per kilometre and ignore weight
 * entirely; everything else is a two-dimensional band lookup on distance and
 * chargeable weight. A distance of zero or less means the address is inside the
 * service town, so there is no surcharge.
 */
export function odaSurcharge(
  edlKm: number,
  chargeableWeight: number,
  matrix: EdlMatrix,
): number {
  return toRupees(odaSurchargePaise(edlKm, chargeableWeight, matrix));
}

/**
 * The same surcharge in paise.
 *
 * The per-kilometre branch is a rate against a distance — the one multiplication in this
 * file — so it goes through exact integer arithmetic rather than a float product. A
 * distance is not money, so it borrows the weight scale: thousandths, which is finer than
 * any distance is recorded to.
 */
export function odaSurchargePaise(
  edlKm: number,
  chargeableWeight: number,
  matrix: EdlMatrix,
): Paise {
  if (edlKm <= 0) return ZERO;
  if (edlKm > matrix.perKmThreshold) {
    return settleMilli(perKg(toPaise(matrix.perKmBeyondLastBand), toGrams(edlKm)));
  }

  const kmIndex = approximateBandIndex(edlKm, matrix.kmBands);
  if (kmIndex < 0) return ZERO;

  const weightIndex = approximateBandIndex(chargeableWeight, matrix.weightBands);
  if (weightIndex < 0) return ZERO;

  return toPaise(matrix.rates[kmIndex]?.[weightIndex] ?? 0);
}
