import { toPaise, toRupees, ZERO } from './money';
import { settle, type ResolvedCharge,
  chargeInRupees,
  type QuotedCharge,
} from './settlement';
import { chargesFrom, fuelBaseFrom, taxOverridesFrom } from './card-config';
import type { ModeTaxProfile } from '../domain/tax';
import type { Pincode, RateCardData } from '../domain/types';
import type { BillingContext } from './quote';

/**
 * Full-truck-load pricing.
 *
 * FTL is deliberately not routed through `quote()`. Partload pricing is built on
 * chargeable weight and per-kg tiers, and a truck has neither: it is hired whole, so the
 * price is one figure per vehicle per lane — which is exactly how the contracts on file
 * state it (A Raymond: Pune→Bangalore ₹33,000, Pune→Chennai ₹38,000).
 *
 * Forcing that into the four-grid shape would mean inventing a chargeable weight for a
 * truck. Everything *after* freight is shared, because none of it depends on how freight
 * was arrived at: the same fuel base, the same charge menu, and FTL's own tax treatment of
 * 12% with input tax credit.
 */

export interface VehicleType {
  /** Stable code, used as the key in the rate data and on the sheet. */
  code: string;
  label: string;
  /** Rated payload. Shown so a booking desk can pick the right truck. */
  capacityKg: number;
}

/**
 * The vehicles hired, smallest to largest.
 *
 * Ordered by capacity because the sheet lists them in this order, and a rate card where a
 * bigger truck costs less is a data-entry error worth being able to see at a glance.
 */
export const VEHICLE_TYPES: VehicleType[] = [
  { code: 'TATA_ACE', label: 'Tata Ace · 7 ft', capacityKg: 750 },
  { code: '8FT', label: 'Pickup · 8 ft', capacityKg: 1500 },
  { code: '14FT', label: 'LCV closed body · 14 ft', capacityKg: 3500 },
  { code: '17FT', label: 'Truck · 17 ft', capacityKg: 5000 },
  { code: '19FT', label: 'Truck · 19 ft', capacityKg: 7000 },
  // A 32 ft single-axle is longer than a 22 ft truck but rated for less, which is why the
  // list is ordered by payload rather than by length.
  { code: '32FT_SXL', label: 'Container · 32 ft single-axle', capacityKg: 9000 },
  { code: '22FT', label: 'Truck · 22 ft', capacityKg: 10000 },
  { code: '32FT_MXL', label: 'Container · 32 ft multi-axle', capacityKg: 15000 },
  { code: '40FT', label: 'Trailer · 40 ft', capacityKg: 25000 },
];

export function vehicleByCode(code: string): VehicleType | undefined {
  return VEHICLE_TYPES.find((vehicle) => vehicle.code === code);
}

/**
 * FTL rates: vehicle code, then origin zone, then destination zone.
 *
 * `null` means the same as everywhere else in this system — that vehicle is not offered on
 * that lane. It is not zero, and it is not "ask".
 */
export interface FtlRates {
  rates: Record<string, Record<string, Record<string, number | null>>>;
}

export interface FtlQuoteInput {
  vehicle: string;
}

export interface FtlEndpoints {
  origin: Pincode | null;
  destination: Pincode | null;
}

export interface FtlBreakdown {
  originZone: string;
  destinationZone: string;
  vehicle: VehicleType;
  freight: number;
  pickup: number;
  delivery: number;
  fuel: number;
  fuelBaseDescription: string;
  charges: QuotedCharge[];
  chargesTotal: number;
  subTotal: number;
  tax: ModeTaxProfile;
  gst: number;
  gstNote?: string;
  total: number;
}

export type FtlUnavailableReason =
  | 'unknown-origin-pincode'
  | 'unknown-destination-pincode'
  | 'unknown-vehicle'
  | 'ftl-not-offered'
  | 'vehicle-not-rated-on-lane';

export type FtlQuoteResult =
  | { available: true; breakdown: FtlBreakdown; warnings: string[] }
  | { available: false; reason: FtlUnavailableReason; message: string };

export function quoteFtl(
  input: FtlQuoteInput,
  endpoints: FtlEndpoints,
  data: RateCardData,
  billing?: BillingContext,
): FtlQuoteResult {
  const { origin, destination } = endpoints;
  if (!origin) {
    return {
      available: false,
      reason: 'unknown-origin-pincode',
      message: 'The origin pincode is not in the pincode master.',
    };
  }
  if (!destination) {
    return {
      available: false,
      reason: 'unknown-destination-pincode',
      message: 'The destination pincode is not in the pincode master.',
    };
  }

  const vehicle = vehicleByCode(input.vehicle);
  if (!vehicle) {
    return {
      available: false,
      reason: 'unknown-vehicle',
      message: `${input.vehicle} is not a vehicle this system rates.`,
    };
  }

  const ftl = data.ftl;
  if (!ftl) {
    return {
      available: false,
      reason: 'ftl-not-offered',
      message: 'This rate card does not offer FTL.',
    };
  }

  // FTL runs over the surface cluster network: a truck goes where a truck can go.
  const originZone = origin.surface.zone;
  const destinationZone = destination.surface.zone;
  const rate = ftl.rates[vehicle.code]?.[originZone]?.[destinationZone] ?? null;

  if (rate === null) {
    return {
      available: false,
      reason: 'vehicle-not-rated-on-lane',
      message: `${vehicle.label} is not rated for ${originZone} to ${destinationZone}.`,
    };
  }

  // A truck is hired whole, so the rate is the freight — an amount, converted exactly.
  const freight = toPaise(rate);
  const sameZone = originZone === destinationZone;
  const pickup = sameZone ? ZERO : toPaise(data.pickupDelivery[originZone]?.pickupSurface ?? 0);
  const delivery = sameZone
    ? ZERO
    : toPaise(data.pickupDelivery[destinationZone]?.deliverySurface ?? 0);

  const settlement = settle({
    freight,
    mode: 'ftl',
    pickup,
    delivery,
    // A hired truck goes to the door. There is no out-of-area surcharge to add.
    oda: ZERO,
    destinationZone,
    // No chargeable weight exists, so a per-kg charge cannot apply to an FTL job.
    chargeableWeight: 0,
    fuelRate: data.charges.fuelFtl ?? 0,
    fuelBase: fuelBaseFrom(data),
    charges: chargesFrom(data),
    taxOverrides: taxOverridesFrom('ftl', data, taxOverridesFallbackRate(data)),
    ...(billing === undefined ? {} : { gstApplicable: billing.gstApplicable }),
    ...(billing?.billingType === 'RCM' ? { forceRcm: true } : {}),
  });

  const warnings: string[] = [];
  if (!origin.surface.serviceable) {
    warnings.push(`Origin pincode ${origin.pincode} is marked not serviceable by road.`);
  }
  if (!destination.surface.serviceable) {
    warnings.push(`Destination pincode ${destination.pincode} is marked not serviceable by road.`);
  }

  return {
    available: true,
    warnings,
    breakdown: {
      originZone,
      destinationZone,
      vehicle,
      // The boundary, as in `quote`: paise above, rupees from here on.
      freight: toRupees(freight),
      pickup: toRupees(pickup),
      delivery: toRupees(delivery),
      fuel: toRupees(settlement.fuel),
      fuelBaseDescription: settlement.fuelBaseDescription,
      charges: settlement.charges.map(chargeInRupees),
      chargesTotal: toRupees(settlement.chargesTotal),
      subTotal: toRupees(settlement.taxableValue),
      tax: settlement.tax,
      gst: toRupees(settlement.gst),
      ...(settlement.gstNote === undefined ? {} : { gstNote: settlement.gstNote }),
      total: toRupees(settlement.total),
    },
  };
}

/**
 * The rate to fall back on when a card states no FTL tax treatment.
 *
 * Unlike surface and air, the workbooks carry no FTL rate at all, so there is nothing to
 * inherit — the statutory 12% stands until a card says otherwise.
 */
function taxOverridesFallbackRate(data: RateCardData): number {
  return data.modeTax?.['ftl']?.gstRate ?? 0.12;
}
