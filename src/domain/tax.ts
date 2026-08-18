import {
  perKg,
  settleMilli,
  toGrams,
  toPaise,
  type Paise,
} from '../pricing/money';
import type { Mode } from './types';

/**
 * Tax and ancillary-charge configuration.
 *
 * Three ideas from the pricing-engine mockup that the engine could not previously
 * express, each of which changes a real quoted number:
 *
 *  1. GST is a property of the **transport mode**, not the customer. A road (GTA) leg
 *     is 5% under reverse charge whatever the customer's own billing preference is.
 *  2. The fuel surcharge is a percentage — but *of what* is negotiated. A Raymond's
 *     contract is 35% **on total charges**, not on freight.
 *  3. Ancillary charges are a catalog, not one docket field. Each declares its own
 *     basis, and whether GST and fuel apply to it.
 */

/** Modes that can be taxed. Wider than the freight modes: courier and FTL bill too. */
export const BILLABLE_MODES = ['surface', 'air', 'rail', 'nfo', 'ftl', 'courier'] as const;
export type BillableMode = (typeof BILLABLE_MODES)[number];

export interface ModeTaxProfile {
  /** Services Accounting Code, which appears on the invoice. */
  sac: string;
  /** Fraction, not percent: 0.05 is 5%. */
  gstRate: number;
  /**
   * Reverse charge. When true the consignee accounts for the GST, so the quote shows
   * zero — but the rate is still recorded, because the invoice must state it.
   */
  rcm: boolean;
  /** Whether input tax credit is available. Affects the customer's real cost. */
  itc: boolean;
  note: string;
}

/**
 * Default Indian transport GST treatment.
 *
 * These are the rates the business operates on today; they are configurable per card
 * because they do change, and a wrong rate is a wrong invoice.
 */
export const DEFAULT_MODE_TAX: Record<BillableMode, ModeTaxProfile> = {
  surface: {
    sac: '9965',
    gstRate: 0.05,
    rcm: true,
    itc: false,
    note: 'GTA by road · 5% under reverse charge, carrier claims no ITC',
  },
  air: {
    sac: '9968',
    gstRate: 0.18,
    rcm: false,
    itc: true,
    note: 'Domestic air cargo · 18% forward charge',
  },
  nfo: {
    sac: '9968',
    gstRate: 0.18,
    rcm: false,
    itc: true,
    note: 'Next-flight-out · taxed as air cargo',
  },
  rail: {
    sac: '9965',
    gstRate: 0.05,
    rcm: false,
    itc: false,
    note: 'Rail transport of goods · 5%',
  },
  ftl: {
    sac: '9965',
    gstRate: 0.12,
    rcm: false,
    itc: true,
    note: 'Full-truck GTA · 12% forward with ITC',
  },
  courier: {
    sac: '9968',
    gstRate: 0.18,
    rcm: false,
    itc: true,
    note: 'Courier / express · 18%',
  },
};

export function taxProfileFor(
  mode: Mode | BillableMode,
  overrides?: Partial<Record<BillableMode, Partial<ModeTaxProfile>>>,
): ModeTaxProfile {
  const key = (BILLABLE_MODES as readonly string[]).includes(mode)
    ? (mode as BillableMode)
    : 'surface';
  const base = DEFAULT_MODE_TAX[key];
  const patch = overrides?.[key];
  return patch ? { ...base, ...patch } : base;
}

/**
 * Which components the fuel percentage is charged on.
 *
 * `freight` is effectively always true; the rest are negotiated. `charges` covers the
 * "fuel on total" case — A Raymond's 35% rides on everything.
 */
export interface FuelBase {
  freight: boolean;
  pickup: boolean;
  delivery: boolean;
  oda: boolean;
  charges: boolean;
}

export const DEFAULT_FUEL_BASE: FuelBase = {
  freight: true,
  pickup: false,
  delivery: false,
  oda: false,
  charges: false,
};

/** Fuel on everything — the shape A Raymond's contract takes. */
export const FUEL_ON_TOTAL: FuelBase = {
  freight: true,
  pickup: true,
  delivery: true,
  oda: true,
  charges: true,
};

export function describeFuelBase(base: FuelBase): string {
  const parts: string[] = [];
  if (base.freight) parts.push('freight');
  if (base.pickup) parts.push('pickup');
  if (base.delivery) parts.push('delivery');
  if (base.oda) parts.push('ODA');
  if (base.charges) parts.push('other charges');
  return parts.length === 0 ? 'nothing' : parts.join(' + ');
}

/**
 * How a charge is counted.
 *
 * `per-destination` is what makes A Raymond's ESS surcharges expressible: the amount
 * depends on where the shipment is going, not on the shipment itself.
 */
export const CHARGE_BASES = [
  'per-shipment',
  'per-awb',
  'per-kg',
  'by-pincode',
  'per-destination',
] as const;
export type ChargeBasis = (typeof CHARGE_BASES)[number];

export interface ChargeDefinition {
  id: string;
  name: string;
  basis: ChargeBasis;
  /** Ignored for `by-pincode` (ODA comes from distance) and `per-destination`. */
  amount: number;
  /** Whether this charge enters the taxable value. */
  gstApplies: boolean;
  /** Whether the fuel percentage is also charged on this charge. */
  fuelApplies: boolean;
  active: boolean;
  /** For `per-destination`: amount by destination zone code. */
  byDestination?: Record<string, number>;
  /** Restrict a charge to certain modes. Absent means every mode. */
  modes?: BillableMode[];
}

export const DEFAULT_CHARGES: ChargeDefinition[] = [
  {
    id: 'docket',
    name: 'Docket / DACC',
    basis: 'per-shipment',
    amount: 100,
    gstApplies: true,
    fuelApplies: false,
    active: true,
  },
  {
    id: 'awb',
    name: 'AWB charge',
    basis: 'per-awb',
    amount: 35,
    gstApplies: true,
    fuelApplies: false,
    active: false,
    modes: ['air', 'nfo', 'courier'],
  },
  {
    id: 'handling',
    name: 'Handling',
    basis: 'per-shipment',
    amount: 60,
    gstApplies: true,
    fuelApplies: true,
    active: false,
  },
  {
    id: 'green-tax',
    name: 'Green tax / permit',
    basis: 'per-shipment',
    amount: 40,
    gstApplies: true,
    fuelApplies: false,
    active: false,
  },
  {
    id: 'oda',
    name: 'ODA / EDL surcharge',
    basis: 'by-pincode',
    amount: 0,
    gstApplies: true,
    fuelApplies: false,
    active: false,
  },
  {
    id: 'ess',
    name: 'ESS · express surcharge',
    basis: 'per-destination',
    amount: 0,
    gstApplies: true,
    fuelApplies: false,
    active: false,
    byDestination: {},
  },
];

/** The amount a charge contributes for one shipment, before any fuel on it. */
export function chargeAmount(
  charge: ChargeDefinition,
  context: { destinationZone: string; odaAmount: number; chargeableWeight: number },
): number {
  switch (charge.basis) {
    case 'by-pincode':
      // ODA is computed from distance, so the catalog carries no amount for it.
      return context.odaAmount;
    case 'per-destination':
      return charge.byDestination?.[context.destinationZone] ?? 0;
    case 'per-kg':
      return charge.amount * context.chargeableWeight;
    case 'per-shipment':
    case 'per-awb':
      return charge.amount;
  }
}

/**
 * The same charge, in paise.
 *
 * A per-kg charge is a rate against a weight, so it goes through the same exact
 * multiplication the freight does rather than a float product corrected afterwards. The
 * others are amounts as stored, which convert exactly.
 */
export function chargeAmountPaise(
  charge: ChargeDefinition,
  context: { destinationZone: string; odaPaise: Paise; chargeableWeight: number },
): Paise {
  switch (charge.basis) {
    case 'by-pincode':
      return context.odaPaise;
    case 'per-destination':
      return toPaise(charge.byDestination?.[context.destinationZone] ?? 0);
    case 'per-kg':
      return settleMilli(perKg(toPaise(charge.amount), toGrams(context.chargeableWeight)));
    case 'per-shipment':
    case 'per-awb':
      return toPaise(charge.amount);
  }
}

export function chargeAppliesToMode(charge: ChargeDefinition, mode: Mode | BillableMode): boolean {
  if (!charge.modes) return true;
  return charge.modes.includes(mode as BillableMode);
}
