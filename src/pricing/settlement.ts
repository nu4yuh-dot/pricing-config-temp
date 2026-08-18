import {
  add,
  rateOf,
  toRupees,
  subtract,
  toPaise,
  ZERO,
  TENTH_RUPEE,
  type Paise,
} from './money';
import {
  chargeAmountPaise,
  chargeAppliesToMode,
  describeFuelBase,
  taxProfileFor,
  type BillableMode,
  type ChargeDefinition,
  type FuelBase,
  type ModeTaxProfile,
} from '../domain/tax';
import type { Mode } from '../domain/types';

/**
 * Turning freight into an invoiceable amount.
 *
 * Split out from `quote()` because it is the part that varies most by customer and
 * has the most law in it: which mode is taxed how, what the fuel percentage rides on,
 * and which ancillary charges are in the taxable value.
 *
 * Order matters and is stated once, here:
 *
 *   1. charges are resolved (each by its own basis)
 *   2. fuel is charged on the configured base, which may include those charges
 *   3. the taxable value is freight + fuel + cartage + GST-applicable charges
 *   4. GST is applied at the **mode's** rate, or suppressed with a reason
 *   5. charges outside GST are added after tax
 */

export interface ResolvedCharge {
  id: string;
  name: string;
  basis: string;
  /** The charge itself, in paise. */
  amount: Paise;
  /** Fuel levied on this charge, when the charge is in the fuel base. */
  fuel: Paise;
  gstApplies: boolean;
}

/**
 * A charge as the API and the screens show it: rupees, converted once on the way out.
 *
 * Held apart from `ResolvedCharge` rather than reusing it, because the two differ only in
 * their unit and that is exactly the confusion worth making a type out of.
 */
export interface QuotedCharge {
  id: string;
  name: string;
  basis: string;
  amount: number;
  fuel: number;
  gstApplies: boolean;
}

export function chargeInRupees(charge: ResolvedCharge): QuotedCharge {
  return { ...charge, amount: toRupees(charge.amount), fuel: toRupees(charge.fuel) };
}

export interface SettlementInput {
  /** Every amount here is paise. Rupees are converted before this is called. */
  freight: Paise;
  /** Any billable mode, not only the four freight modes — FTL settles through here too. */
  mode: Mode | BillableMode;
  pickup: Paise;
  delivery: Paise;
  /** ODA total for both legs. Fed in because it comes from pincode distance. */
  oda: Paise;
  destinationZone: string;
  chargeableWeight: number;
  fuelRate: number;
  fuelBase: FuelBase;
  charges: ChargeDefinition[];
  taxOverrides?: Partial<Record<BillableMode, Partial<ModeTaxProfile>>>;
  /**
   * Customer-level suppression, layered *on top of* the mode's own treatment. A
   * customer outside GST pays none regardless of mode.
   */
  gstApplicable?: boolean;
  /** Force reverse charge even where the mode is forward. */
  forceRcm?: boolean;
}

export interface Settlement {
  freight: Paise;
  fuel: Paise;
  /** What the fuel percentage was actually charged on. */
  fuelBaseAmount: Paise;
  fuelBaseDescription: string;
  pickup: Paise;
  delivery: Paise;
  /**
   * ODA billed outside the charge list. Zero when the catalog carries a `by-pincode`
   * charge, which then reports it instead — so `oda + chargesTotal` never double-counts.
   */
  oda: Paise;
  charges: ResolvedCharge[];
  chargesTotal: Paise;
  /** Charges excluded from GST, added after tax. */
  chargesOutsideTax: Paise;
  taxableValue: Paise;
  tax: ModeTaxProfile;
  gst: Paise;
  /** Present only when GST was not charged, saying why. */
  gstNote?: string;
  total: Paise;
}

export function settle(input: SettlementInput): Settlement {
  const tax = taxProfileFor(input.mode, input.taxOverrides);

  /** Internal shape: carries `fuelApplies`, which the caller does not need. */
  interface WorkingCharge extends ResolvedCharge {
    fuelApplies: boolean;
  }

  // 1 — resolve every active charge that applies to this mode.
  const resolved: WorkingCharge[] = input.charges
    .filter((charge) => charge.active && chargeAppliesToMode(charge, input.mode))
    .map((charge) => ({
      id: charge.id,
      name: charge.name,
      basis: charge.basis,
      amount: chargeAmountPaise(charge, {
        destinationZone: input.destinationZone,
        odaPaise: input.oda,
        chargeableWeight: input.chargeableWeight,
      }),
      fuel: ZERO,
      gstApplies: charge.gstApplies,
      fuelApplies: charge.fuelApplies,
    }))
    // A zero charge is noise on a quote.
    .filter((charge) => charge.amount !== 0);

  // ODA can be expressed two ways: as `input.oda`, or as a `by-pincode` charge that
  // reads the same figure off the distance calculation. It must be billed once, so a
  // catalog entry takes over the billing and the direct line goes to zero.
  const odaAsCharge = resolved.some((charge) => charge.basis === 'by-pincode');
  const odaDirect = odaAsCharge ? ZERO : input.oda;

  // 2 — fuel, on exactly the components the contract says. The `oda` flag governs the
  // ODA wherever it is billed from, so the charges base must not pick it up again.
  const fuelParts: Paise[] = [];
  if (input.fuelBase.freight) fuelParts.push(input.freight);
  if (input.fuelBase.pickup) fuelParts.push(input.pickup);
  if (input.fuelBase.delivery) fuelParts.push(input.delivery);
  if (input.fuelBase.oda) fuelParts.push(input.oda);
  if (input.fuelBase.charges) {
    // "Fuel on total" — every charge rides along, bar the ODA counted just above.
    for (const charge of resolved) {
      if (charge.basis !== 'by-pincode') fuelParts.push(charge.amount);
    }
  }
  const fuelBaseAmount = add(...fuelParts);

  // A tenth of a rupee, because that is what the workbooks' ROUND(x, 1) produces and what
  // the signed cards were agreed on. Exact integer arithmetic, not a rounded float.
  const fuel = rateOf(fuelBaseAmount, input.fuelRate, TENTH_RUPEE);

  // A charge may also carry fuel individually, when the whole-charges base is off.
  // Both at once would charge fuel twice on the same rupee.
  if (!input.fuelBase.charges) {
    for (const charge of resolved) {
      if (charge.fuelApplies) charge.fuel = rateOf(charge.amount, input.fuelRate, TENTH_RUPEE);
    }
  }

  const chargesTotal = add(...resolved.map((charge) => add(charge.amount, charge.fuel)));

  // 3 — the taxable value excludes charges the contract puts outside GST.
  const chargesInTax = add(
    ...resolved.filter((charge) => charge.gstApplies).map((charge) => add(charge.amount, charge.fuel)),
  );
  // Exact by construction now: the two halves of chargesTotal are integers, so what is
  // outside tax is what is left, not what is left after a rounding.
  const chargesOutsideTax = subtract(chargesTotal, chargesInTax);

  const taxableValue = add(input.freight, fuel, input.pickup, input.delivery, odaDirect, chargesInTax);

  // 4 — GST at the mode's rate, suppressed only with a stated reason.
  let gst = rateOf(taxableValue, tax.gstRate, TENTH_RUPEE);
  let gstNote: string | undefined;

  if (input.gstApplicable === false) {
    gst = ZERO;
    gstNote = 'GST not applicable for this customer.';
  } else if (input.forceRcm || tax.rcm) {
    gst = ZERO;
    gstNote =
      `GST ${(tax.gstRate * 100).toFixed(0)}% under reverse charge (SAC ${tax.sac}) — ` +
      `payable by the consignee, not billed here.`;
  }

  return {
    freight: input.freight,
    fuel,
    fuelBaseAmount,
    fuelBaseDescription: describeFuelBase(input.fuelBase),
    pickup: input.pickup,
    delivery: input.delivery,
    oda: odaDirect,
    charges: resolved.map(({ id, name, basis, amount, fuel: f, gstApplies }) => ({
      id,
      name,
      basis,
      amount,
      fuel: f,
      gstApplies,
    })),
    chargesTotal,
    chargesOutsideTax,
    taxableValue,
    tax,
    gst,
    ...(gstNote === undefined ? {} : { gstNote }),
    // A sum of integers, so the total is the parts. Nothing to reconcile.
    total: add(taxableValue, gst, chargesOutsideTax),
  };
}
