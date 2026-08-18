/** Rounds to one decimal place, matching the source workbook's `ROUND(x, 1)`. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Rounds a currency amount to paise.
 *
 * Binary floating point cannot represent most decimal rates exactly, so a product
 * like `12 x 53.3` evaluates to 639.5999999999999. Excel hides this by rounding to
 * 15 significant digits for display; we round money explicitly instead, so no
 * quote, API response or stored total ever carries the artefact.
 */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface Dimensions {
  actualWeight: number;
  length?: number;
  breadth?: number;
  height?: number;
  pieces?: number;
}

export interface WeightRules {
  minWeight: number;
  volumetricDivisor: number;
}

/**
 * Volumetric weight in kg: L x B x H x pieces / divisor, per the source workbook
 * (air /5000, surface and rail /4500). Zero unless all three dimensions are given.
 */
export function volumetricWeight(dims: Dimensions, rules: WeightRules): number {
  const { length = 0, breadth = 0, height = 0, pieces = 1 } = dims;
  if (length <= 0 || breadth <= 0 || height <= 0) return 0;
  return round1((length * breadth * height * Math.max(pieces, 1)) / rules.volumetricDivisor);
}

/** The greater of actual weight, volumetric weight, and the mode's minimum. */
export function chargeableWeight(dims: Dimensions, rules: WeightRules): number {
  return Math.max(dims.actualWeight, volumetricWeight(dims, rules), rules.minWeight);
}

export interface RailHeavyPackageRule {
  singlePackage: boolean;
  threshold: number;
  multiplier: number;
}

/**
 * Rail chargeable weight. The railway parcel norm bills a single package at or
 * above the threshold at a multiple of its weight, and that supersedes both the
 * volumetric rule and the mode minimum.
 */
export function railChargeableWeight(
  dims: Dimensions,
  rules: WeightRules,
  heavy: RailHeavyPackageRule,
): number {
  if (heavy.singlePackage && dims.actualWeight >= heavy.threshold) {
    return heavy.multiplier * dims.actualWeight;
  }
  return chargeableWeight(dims, rules);
}
