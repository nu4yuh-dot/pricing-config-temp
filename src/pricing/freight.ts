import { type FreightMethod, TIER2_FROM, TIER3_FROM } from '../domain/types';
import {
  addMilli,
  perKg,
  settleMilli,
  toGrams,
  toPaise,
  toRupees,
  ZERO_MILLI,
  type MilliPaise,
  type Paise,
} from './money';

/** The four rates a single origin-destination lane carries, for one mode. All in rupees. */
export interface LaneRates {
  minCharge: number | null;
  tier1: number | null;
  tier2: number | null;
  tier3: number | null;
}

/**
 * The single per-kg rate that Models 2 and 3 select from total chargeable weight.
 * Model 1 does not use this -- it blends all three tiers.
 */
export function applicableTierRate(chargeableWeight: number, rates: LaneRates): number | null {
  if (chargeableWeight <= TIER2_FROM) return rates.tier1;
  if (chargeableWeight <= TIER3_FROM) return rates.tier2;
  return rates.tier3;
}

const orZero = (rate: number | null): number => rate ?? 0;

/**
 * The weight bands, in grams.
 *
 * Band arithmetic happens in whole grams rather than in fractional kilograms, and that is
 * not fussiness: `100.1 - 100` in binary floating point is 0.09999999999999432, so a
 * shipment a hundred grams into tier 2 was being charged for 99.99999 grams of it. The
 * error is far below a paisa on one lane and it is still an error, and integers do not
 * have it.
 */
const TIER2_FROM_G = toGrams(TIER2_FROM);
const TIER3_FROM_G = toGrams(TIER3_FROM);

/** Weight falling inside the tier-1 band, which runs from the mode minimum to 100 kg. */
function tier1Grams(chargeableGrams: number, minGrams: number): number {
  const above = Math.max(chargeableGrams - minGrams, 0);
  return Math.min(above, Math.max(TIER2_FROM_G - minGrams, 0));
}

/**
 * Base freight for a lane, in paise, excluding fuel, pickup, delivery, ODA, docket and GST.
 *
 * Every slab product is held at a thousandth of a paise and the whole expression is
 * rounded once at the end, which is where the source workbook rounds it. Rounding each
 * slab first would round three times and drift upward on any lane whose slabs land on a
 * half paise.
 *
 * Returns `null` when the lane is not served by the mode -- the `'-'` of the source
 * matrices.
 */
export function computeFreightPaise(
  method: FreightMethod,
  chargeableWeight: number,
  minWeight: number,
  rates: LaneRates,
): Paise | null {
  if (rates.minCharge === null) return null;

  const minCharge = toPaise(rates.minCharge);
  // A minimum charge is an amount, so it joins the working scale rather than being added
  // after the rounding: the workbook adds it inside the expression it rounds.
  const minChargeMilli = (minCharge * 1000) as MilliPaise;
  const grams = toGrams(chargeableWeight);
  const minGrams = toGrams(minWeight);

  switch (method) {
    /** Model 1: every slab contributes the weight that falls inside it. */
    case 'CUMULATIVE_SLABS': {
      const inTier2 = Math.max(Math.min(grams, TIER3_FROM_G) - TIER2_FROM_G, 0);
      const inTier3 = Math.max(grams - TIER3_FROM_G, 0);
      return settleMilli(
        addMilli(
          minChargeMilli,
          perKg(toPaise(orZero(rates.tier1)), tier1Grams(grams, minGrams)),
          perKg(toPaise(orZero(rates.tier2)), inTier2),
          perKg(toPaise(orZero(rates.tier3)), inTier3),
        ),
      );
    }

    /** Model 2: one rate, applied to the weight above the mode minimum. */
    case 'MIN_PLUS_EXCESS': {
      const rate = toPaise(orZero(applicableTierRate(chargeableWeight, rates)));
      const excess = Math.max(grams - minGrams, 0);
      return settleMilli(addMilli(minChargeMilli, perKg(rate, excess)));
    }

    /** Model 3: one rate against the full weight, with the minimum as a floor. */
    case 'MAX_MIN_OR_FULL': {
      const rate = toPaise(orZero(applicableTierRate(chargeableWeight, rates)));
      const full = perKg(rate, grams);
      return settleMilli(Math.max(minChargeMilli, full) as MilliPaise);
    }
  }
}

/**
 * The same freight in rupees, for the places that only display it.
 *
 * Kept so the lane editor's live preview and the monotonicity validators do not have to
 * think in paise. Nothing that reaches a customer's money goes through here — the quote
 * path uses `computeFreightPaise` and stays integral end to end.
 */
export function computeFreight(
  method: FreightMethod,
  chargeableWeight: number,
  minWeight: number,
  rates: LaneRates,
): number | null {
  const paise = computeFreightPaise(method, chargeableWeight, minWeight, rates);
  return paise === null ? null : toRupees(paise);
}

export { ZERO_MILLI };
