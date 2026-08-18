import {
  addMicro,
  maxMicro,
  microPerKg,
  microRateOf,
  microToRupees,
  toGrams,
  toMicro,
  ZERO_MICRO,
  type Micro,
} from './money';
import { resolveZone, selectRate, type UpsCardData, type UpsProduct } from '../domain/ups';

/**
 * Pricing the UPS / MOVIN international export card.
 *
 * Separate from `quote()` for the same reason Bluedart is: almost nothing is shared. There
 * is no lane, no ODA matrix, no pickup and delivery, no per-mode tax profile. There is a
 * destination country, a product, a weight, and an order of operations the agreement and
 * its calculator state exactly:
 *
 *   freight = rate × (1 + margin)
 *   surge   = published ₹/kg × (1 − discount) × chargeable weight
 *   fuel    = (freight + surge) × 46.75%
 *   accessorials, each MAX(minimum, per-kg × weight) × (1 − waiver)
 *   sub-total = freight + surge + fuel + accessorials
 *   total     = sub-total + GST
 *
 * Fuel rides on freight and surge but **not** on the accessorials, which is the one part
 * of the order somebody would otherwise get wrong.
 *
 * Amounts are integer millionths of a rupee, like Bluedart. The contract quotes rates to
 * three decimals (₹733.383) and multiplies them by a margin and a percentage, so paise is
 * too coarse to hold the intermediate and a float is the thing this engine no longer uses.
 */

export interface UpsQuoteInput {
  product: UpsProduct;
  /** ISO-ish destination code as the card writes it. */
  countryCode: string;
  /** Required only where the card splits a country by postal code. */
  postalCode?: string | number;
  actualWeight: number;
  length?: number;
  breadth?: number;
  height?: number;
  /** Accessorial ids to apply on top of any that apply by default. */
  accessorials?: readonly string[];
}

export interface UpsChargeLine {
  id: string;
  name: string;
  /** Before the negotiated waiver. */
  gross: number;
  waiver: number;
  /** What is actually billed. */
  amount: number;
}

export interface UpsBreakdown {
  origin: string;
  countryCode: string;
  destination: string;
  zone: string;
  surgeRegion: string;
  product: UpsProduct;
  volumetricWeight: number;
  chargeableWeight: number;
  /** The weight step the rate was read at, or the per-kg band it fell into. */
  rateBasis: string;
  /** The contracted rate before margin. */
  contractRate: number;
  freight: number;
  surgePerKg: number;
  surge: number;
  fuelRate: number;
  fuel: number;
  accessorials: UpsChargeLine[];
  accessorialsTotal: number;
  subTotal: number;
  gstRate: number;
  gst: number;
  total: number;
  /** Sub-total divided by chargeable weight, as the calculator reports it. */
  effectivePerKg: number;
}

export type UpsUnavailableReason =
  | 'unknown-country'
  | 'not-served'
  | 'postal-code-required'
  | 'above-product-limit'
  | 'zone-not-priced';

export type UpsQuoteResult =
  | { available: true; breakdown: UpsBreakdown; warnings: string[] }
  | { available: false; reason: UpsUnavailableReason; message: string };

const MESSAGES: Record<UpsUnavailableReason, string> = {
  'unknown-country': 'That destination is not on the zone chart.',
  'not-served': 'The card carries no zone for that destination.',
  'postal-code-required':
    'This country is zoned by postal code, so a postal code is needed to price it.',
  'above-product-limit': 'Too heavy for this product. A Document is priced to 5 kg.',
  'zone-not-priced': 'The rate grid has no column for that zone.',
};

/** Volumetric weight in kg, to two decimals, as the calculator computes it. */
export function upsVolumetricWeight(
  input: Pick<UpsQuoteInput, 'length' | 'breadth' | 'height'>,
  divisor: number,
): number {
  const { length = 0, breadth = 0, height = 0 } = input;
  if (length <= 0 || breadth <= 0 || height <= 0 || divisor <= 0) return 0;
  return Math.round(((length * breadth * height) / divisor) * 100) / 100;
}

export function quoteUps(input: UpsQuoteInput, data: UpsCardData): UpsQuoteResult {
  const params = data.params;

  const where = resolveZone(data, input.countryCode, input.postalCode);
  if (!where.ok) return { available: false, reason: where.reason, message: MESSAGES[where.reason] };

  const volumetric = upsVolumetricWeight(input, params.volumetricDivisor);
  const chargeable = Math.max(input.actualWeight, volumetric, params.minChargeableWeight);

  const selected = selectRate(data, input.product, where.zone, chargeable);
  if (selected.kind === 'none') {
    return { available: false, reason: selected.reason, message: MESSAGES[selected.reason] };
  }

  const grams = toGrams(chargeable);

  // 1 — freight. A per-kg band multiplies by the weight; a weight step does not.
  const base =
    selected.kind === 'per-kg'
      ? microPerKg(toMicro(selected.rate), grams)
      : toMicro(selected.rate);
  const freight = addMicro(base, microRateOf(base, params.margin));

  // 2 — surge, per kilogram of chargeable weight, by region rather than by rate zone.
  const publishedSurge = data.surge[where.surgeRegion] ?? 0;
  const surgePerKg = toMicro(publishedSurge);
  const netSurgePerKg = (surgePerKg - microRateOf(surgePerKg, params.surgeDiscount)) as Micro;
  const surge = microPerKg(netSurgePerKg, grams);

  // 3 — fuel, on freight and surge together and on nothing else.
  const fuel = microRateOf(addMicro(freight, surge), params.fuelRate);

  // 4 — accessorials. Each is the greater of its minimum and its per-kg rate against the
  // chargeable weight, less whatever this customer negotiated away.
  const asked = new Set(input.accessorials ?? []);
  const lines: UpsChargeLine[] = [];
  let accessorialsTotal: Micro = ZERO_MICRO;

  for (const charge of data.accessorials) {
    if (!charge.appliesByDefault && !asked.has(charge.id)) continue;
    const gross = maxMicro(toMicro(charge.minimum), microPerKg(toMicro(charge.perKg), grams));
    const amount = (gross - microRateOf(gross, charge.waiver)) as Micro;
    lines.push({
      id: charge.id,
      name: charge.name,
      gross: microToRupees(gross),
      waiver: charge.waiver,
      amount: microToRupees(amount),
    });
    accessorialsTotal = addMicro(accessorialsTotal, amount);
  }

  const subTotal = addMicro(freight, surge, fuel, accessorialsTotal);
  const gst = microRateOf(subTotal, params.gstRate);
  const total = addMicro(subTotal, gst);

  const warnings: string[] = [];
  if (volumetric > input.actualWeight) {
    warnings.push(
      `Billed on volumetric weight ${volumetric} kg rather than the actual ${input.actualWeight} kg.`,
    );
  }
  if (chargeable > input.actualWeight && volumetric <= input.actualWeight) {
    warnings.push(
      `Billed at the ${params.minChargeableWeight} kg minimum rather than the actual ${input.actualWeight} kg.`,
    );
  }
  if (where.viaPostalRange) {
    warnings.push(
      `${input.countryCode} is zoned by postal code; ${input.postalCode} falls in ` +
        `${where.viaPostalRange.from}–${where.viaPostalRange.to}, which is ${where.zone}.`,
    );
  }

  return {
    available: true,
    warnings,
    breakdown: {
      origin: params.origin,
      countryCode: input.countryCode.trim().toUpperCase(),
      destination:
        data.destinationNames[input.countryCode.trim().toUpperCase()] ??
        input.countryCode.trim().toUpperCase(),
      zone: where.zone,
      surgeRegion: where.surgeRegion,
      product: input.product,
      volumetricWeight: volumetric,
      chargeableWeight: chargeable,
      rateBasis:
        selected.kind === 'per-kg'
          ? `${selected.band} (per kg)`
          : selected.step === null
            ? 'flat'
            : `${selected.step} kg step`,
      contractRate: selected.rate,
      // The boundary: everything above is integer micro-rupees, everything below is
      // rupees for the screen and the API.
      freight: microToRupees(freight),
      surgePerKg: microToRupees(netSurgePerKg),
      surge: microToRupees(surge),
      fuelRate: params.fuelRate,
      fuel: microToRupees(fuel),
      accessorials: lines,
      accessorialsTotal: microToRupees(accessorialsTotal),
      subTotal: microToRupees(subTotal),
      gstRate: params.gstRate,
      gst: microToRupees(gst),
      total: microToRupees(total),
      effectivePerKg: Math.round((microToRupees(subTotal) / chargeable) * 100) / 100,
    },
  };
}
