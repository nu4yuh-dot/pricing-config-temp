import { BILLABLE_MODES, DEFAULT_CHARGES } from '../domain/tax';
import { chargesFrom, isOn } from '../pricing/card-config';
import { SURFACE_ZONES } from '../domain/zones';
import type {
  ChargeRow,
  FlagField,
  FuelBaseRow,
  ModeTaxRow,
  NumberField,
  EssZoneRow,
} from '../components/console/TaxChargesEditor';
import type { RateCardData } from '../domain/types';

/**
 * Building the tax, fuel-base and charge-menu fields for the editor.
 *
 * Shared so a base card and a customer contract present the same fields in the same order
 * against the same binds. The only thing that differs is what the two data sets mean: on a
 * card it is draft against live, on a contract it is the customer's effective data against
 * the standard card. Both are "what it is now" against "what it would otherwise be", which
 * is exactly what the editor shows.
 */

const TRANSPORT: Record<string, string> = {
  surface: 'Road / GTA',
  air: 'Domestic air cargo',
  rail: 'Rail parcel',
  nfo: 'Next-flight-out',
  ftl: 'Full truck load',
  courier: 'Courier / express',
};

const MODE_LABELS: Record<string, string> = {
  surface: 'Surface',
  air: 'Air',
  rail: 'Rail',
  nfo: 'NFO / JIT',
  ftl: 'FTL',
  courier: 'Courier',
};

const BASIS_LABELS: Record<string, string> = {
  'per-shipment': 'flat, per shipment',
  'per-awb': 'flat, per AWB',
  'per-kg': 'per kg of chargeable weight',
  'by-pincode': 'from the pincode distance',
  'per-destination': 'per destination zone',
};

const FUEL_BASE_ROWS: { key: string; label: string; note: string }[] = [
  { key: 'freight', label: 'Freight', note: 'The workbooks always charged fuel on freight.' },
  { key: 'pickup', label: 'Pickup', note: 'Pickup cartage at the origin.' },
  { key: 'delivery', label: 'Delivery', note: 'Delivery cartage at the destination.' },
  { key: 'oda', label: 'ODA / EDL', note: 'The out-of-area surcharge at either end.' },
  {
    key: 'charges',
    label: 'Other charges',
    note: 'Yes makes this “fuel on total charges” — how A Raymond’s contract is written.',
  },
];

const flagField = (bind: string, current: unknown, baseline: unknown): FlagField => ({
  bind,
  value: isOn(current),
  liveValue: isOn(baseline),
});

const textField = (
  bind: string,
  unit: NumberField['unit'],
  current: unknown,
  baseline: unknown,
): NumberField => {
  const show = (value: unknown): string => {
    if (value === undefined || value === null || value === '') return '';
    if (unit === 'percent') return String(Number((Number(value) * 100).toFixed(4)));
    return String(value);
  };
  return { bind, unit, value: show(current), liveValue: show(baseline) };
};

const taxAt = (data: RateCardData, mode: string) => data.modeTax?.[mode] ?? {};

const fuelAt = (data: RateCardData, key: string) =>
  (data.fuelBase as Record<string, unknown> | undefined)?.[key];

const storedCharge = (data: RateCardData, id: string) => {
  const catalog = data.chargeCatalog;
  if (!catalog || Array.isArray(catalog)) return {};
  return catalog[id] ?? {};
};

export function modeTaxRows(current: RateCardData, baseline: RateCardData): ModeTaxRow[] {
  return BILLABLE_MODES.map((mode) => ({
    mode,
    label: MODE_LABELS[mode] ?? mode,
    transport: TRANSPORT[mode] ?? '',
    sac: textField(`modeTax.${mode}.sac`, 'text', taxAt(current, mode).sac, taxAt(baseline, mode).sac),
    gstRate: textField(
      `modeTax.${mode}.gstRate`,
      'percent',
      taxAt(current, mode).gstRate,
      taxAt(baseline, mode).gstRate,
    ),
    rcm: flagField(`modeTax.${mode}.rcm`, taxAt(current, mode).rcm, taxAt(baseline, mode).rcm),
    itc: flagField(`modeTax.${mode}.itc`, taxAt(current, mode).itc, taxAt(baseline, mode).itc),
  }));
}

export function fuelBaseRows(current: RateCardData, baseline: RateCardData): FuelBaseRow[] {
  return FUEL_BASE_ROWS.map((row) => ({
    label: row.label,
    note: row.note,
    field: flagField(`fuelBase.${row.key}`, fuelAt(current, row.key), fuelAt(baseline, row.key)),
  }));
}

export function chargeRows(current: RateCardData, baseline: RateCardData): ChargeRow[] {
  // Resolved definitions, so the basis shown is the one that will actually price —
  // including the ones a stored entry inherits rather than states.
  const resolved = new Map(chargesFrom(current).map((charge) => [charge.id, charge]));

  // The standard six, plus anything this card or contract has added of its own. Without
  // the second part a custom charge would price but have nowhere to be edited, which is
  // worse than not offering it at all.
  const known = [
    ...DEFAULT_CHARGES,
    ...chargesFrom(current)
      .filter((charge) => !DEFAULT_CHARGES.some((entry) => entry.id === charge.id))
      .map((charge) => ({ ...charge })),
  ];

  return known.map((known) => {
    const definition = resolved.get(known.id) ?? known;
    const stored = storedCharge(current, known.id);
    const base = storedCharge(baseline, known.id);
    return {
      id: known.id,
      name: textField(`chargeCatalog.${known.id}.name`, 'text', stored.name, base.name),
      basisLabel: BASIS_LABELS[definition.basis] ?? definition.basis,
      amount: textField(`chargeCatalog.${known.id}.amount`, 'currency', stored.amount, base.amount),
      // ODA comes from the distance calculation and ESS from its per-zone amounts, so
      // neither takes a flat figure here.
      amountEditable: definition.basis !== 'by-pincode' && definition.basis !== 'per-destination',
      gstApplies: flagField(
        `chargeCatalog.${known.id}.gstApplies`,
        stored.gstApplies,
        base.gstApplies,
      ),
      fuelApplies: flagField(
        `chargeCatalog.${known.id}.fuelApplies`,
        stored.fuelApplies,
        base.fuelApplies,
      ),
      active: flagField(`chargeCatalog.${known.id}.active`, stored.active, base.active),
      bookableOneOff: flagField(
        `chargeCatalog.${known.id}.bookableOneOff`,
        stored.bookableOneOff,
        base.bookableOneOff,
      ),
      /**
       * The same rule `isBookableOneOff` enforces, applied to the control rather than to the
       * value. A per-destination charge holds a figure per zone and a by-pincode charge is
       * read off the distance table, so neither has one number an operator could be asked
       * for at a booking. Offering the toggle and then ignoring it deeper in would be worse
       * than not offering it.
       */
      oneOffPossible: definition.basis !== 'per-destination' && definition.basis !== 'by-pincode',
      modes: (definition.modes ?? []).join(', '),
    };
  });
}

/**
 * The express surcharge, zone by zone.
 *
 * A Raymond has nine of these — Bangalore-Mysore ₹3,000, Hosur ₹2,000 and so on — and they
 * are negotiated per customer rather than set on the standard card, which is why they are
 * editable here rather than only on the card's own tab.
 */
export function essZoneRows(current: RateCardData, baseline: RateCardData): EssZoneRow[] {
  const amountAt = (data: RateCardData, zone: string) => {
    const stored = storedCharge(data, 'ess');
    return stored.byDestination?.[zone];
  };
  return SURFACE_ZONES.map((zone) => ({
    zone,
    field: textField(
      `chargeCatalog.ess.byDestination.${zone}`,
      'currency',
      amountAt(current, zone),
      amountAt(baseline, zone),
    ),
  }));
}
