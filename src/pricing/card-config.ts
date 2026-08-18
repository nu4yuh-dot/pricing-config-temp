import {
  CHARGE_BASES,
  DEFAULT_CHARGES,
  DEFAULT_FUEL_BASE,
  DEFAULT_MODE_TAX,
  type BillableMode,
  type ChargeBasis,
  type ChargeDefinition,
  type FuelBase,
  type ModeTaxProfile,
} from '../domain/tax';
import { BILLABLE_MODES } from '../domain/tax';
import type { Flag, Mode, RateCardData, StoredCharge, StoredModeTax } from '../domain/types';
import { SURFACE_ZONES } from '../domain/zones';
import { VEHICLE_TYPES } from './ftl';

/**
 * Reading the settlement configuration off a stored rate card.
 *
 * The configuration has to live in cells. Everything in this system is edited, diffed
 * and approved as a spreadsheet cell, so a tax rate or a fuel-base switch that lived
 * outside that machinery could go live without anyone reviewing it. Cells hold text and
 * numbers, so the flags are stored as the words a person types — "Yes" and "No" — and
 * read back here.
 *
 * Booleans are accepted as well, because the booking API and the tests pass those.
 */

/**
 * Whether a stored flag is on.
 *
 * Anything unrecognised is off. A surcharge switching itself on because someone typed
 * "maybe" would be worse than one that stays off and gets noticed.
 */
export function isOn(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  const word = value.trim().toLowerCase();
  return word === 'yes' || word === 'y' || word === 'true';
}

/**
 * The fuel base the source workbooks use: freight plus both cartage legs and both ODA
 * legs, but not the docket.
 */
export const WORKBOOK_FUEL_BASE: FuelBase = {
  ...DEFAULT_FUEL_BASE,
  pickup: true,
  delivery: true,
  oda: true,
};

/**
 * What the fuel percentage is charged on.
 *
 * A card that declares a base is taken at its word, including the components it leaves
 * out — a half-filled declaration means those components are off, not that the workbook
 * default quietly returns for them.
 */
export function fuelBaseFrom(data: RateCardData): FuelBase {
  const declared = data.fuelBase;
  if (!declared) return WORKBOOK_FUEL_BASE;
  return {
    freight: isOn(declared.freight),
    pickup: isOn(declared.pickup),
    delivery: isOn(declared.delivery),
    oda: isOn(declared.oda),
    charges: isOn(declared.charges),
  };
}

function basisFrom(raw: unknown): ChargeBasis {
  const value = typeof raw === 'string' ? raw.trim() : '';
  // An unknown basis prices as a flat per-shipment charge rather than failing the
  // quote: a charge that appears at the wrong basis is visible, a failed quote is not.
  return (CHARGE_BASES as readonly string[]).includes(value)
    ? (value as ChargeBasis)
    : 'per-shipment';
}

/** `air, nfo` in a cell; `['air','nfo']` from the API. */
function modesFrom(raw: unknown): BillableMode[] | undefined {
  const names = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string' && raw.trim() !== ''
      ? raw.split(',')
      : null;
  if (!names) return undefined;
  const modes = names
    .map((name) => name.trim().toLowerCase())
    .filter((name): name is BillableMode =>
      (BILLABLE_MODES as readonly string[]).includes(name),
    );
  return modes.length === 0 ? undefined : modes;
}

const KNOWN_CHARGES = new Map(DEFAULT_CHARGES.map((charge) => [charge.id, charge]));

/**
 * One stored entry, read against the known definition for its id.
 *
 * A stored entry carries only what differs. The basis and mode restriction of a known
 * charge — ODA by pincode, ESS per destination, AWB on air only — are structural: making
 * someone retype them correctly into a cell for the quote to come out right would be a
 * defect waiting to happen.
 */
function definitionFrom(id: string, stored: StoredCharge): ChargeDefinition {
  const known = KNOWN_CHARGES.get(id);
  const modes = modesFrom(stored.modes) ?? known?.modes;
  const byDestination = stored.byDestination ?? known?.byDestination;
  return {
    id,
    name: stored.name ?? known?.name ?? id,
    basis: stored.basis === undefined ? (known?.basis ?? 'per-shipment') : basisFrom(stored.basis),
    amount: stored.amount === undefined ? (known?.amount ?? 0) : Number(stored.amount),
    gstApplies: stored.gstApplies === undefined ? (known?.gstApplies ?? false) : isOn(stored.gstApplies),
    fuelApplies:
      stored.fuelApplies === undefined ? (known?.fuelApplies ?? false) : isOn(stored.fuelApplies),
    active: stored.active === undefined ? (known?.active ?? false) : isOn(stored.active),
    ...(byDestination === undefined ? {} : { byDestination }),
    ...(modes === undefined ? {} : { modes }),
  };
}

/**
 * The ancillary charges to quote.
 *
 * A card with no catalog is quoted with its single docket field, which is all the source
 * workbooks carry. An *empty* catalog is honoured as empty — that is how a contract
 * removes the docket — so the fallback applies only when there is no catalog at all.
 */
export function chargesFrom(data: RateCardData): ChargeDefinition[] {
  const catalog = data.chargeCatalog;
  if (!catalog) {
    return [
      {
        id: 'docket',
        name: 'Docket / DACC',
        basis: 'per-shipment',
        amount: data.charges.docket,
        gstApplies: true,
        fuelApplies: false,
        active: true,
      },
    ];
  }
  if (Array.isArray(catalog)) {
    return catalog.map((entry) => definitionFrom(String(entry.id ?? ''), entry));
  }
  return Object.entries(catalog).map(([id, entry]) => definitionFrom(id, entry));
}

/**
 * The tax treatment to settle with.
 *
 * The workbooks state a rate but say nothing about reverse charge, so a card with no
 * tax block is settled at its own rate under forward charge — the behaviour the golden
 * fixtures were verified against. The statutory defaults (road at 5% under reverse
 * charge, for one) apply only once a card asks for them.
 */
export function taxOverridesFrom(
  mode: Mode | BillableMode,
  data: RateCardData,
  workbookRate: number,
): Partial<Record<BillableMode, Partial<ModeTaxProfile>>> {
  const declared = data.modeTax?.[mode] ?? {};
  const patch: Partial<ModeTaxProfile> = {
    gstRate: declared.gstRate ?? workbookRate,
    rcm: isOn(declared.rcm),
  };
  if (declared.sac !== undefined) patch.sac = declared.sac;
  if (declared.itc !== undefined) patch.itc = isOn(declared.itc);
  return { [mode as BillableMode]: patch };
}

const flag = (value: boolean): Flag => (value ? 'Yes' : 'No');

export interface SettlementDefaults {
  modeTax: Record<string, StoredModeTax>;
  fuelBase: Record<'freight' | 'pickup' | 'delivery' | 'oda' | 'charges', Flag>;
  chargeCatalog: Record<string, StoredCharge>;
  /**
   * An FTL rate cell for every vehicle on every lane, all null.
   *
   * Null rather than zero, and present rather than absent: null is how this system says
   * "not offered on this lane" everywhere else, and the cell has to exist for the FTL tab
   * to show it and for an edit to be reviewable.
   */
  ftl: { rates: Record<string, Record<string, Record<string, number | null>>> };
  /**
   * Charge parameters no workbook carries: the FTL fuel rate, and rail's own weight rules.
   * The rail values are seeded from surface, which is what rail already used — so seeding
   * them changes no quote, it only makes the rule visible and separately editable.
   */
  charges: {
    fuelFtl: number;
    minWeightRail: number;
    volumetricDivisorRail: number;
  };
}

/**
 * The settlement configuration written onto a card at seed time.
 *
 * Deliberately equal to how a card with no configuration already behaves: the workbook
 * fuel base, the workbook GST rate at forward charge, and the docket as the one active
 * charge. Seeding it changes no quoted number — it puts the values on a tab where they
 * can be seen, edited and approved instead of being implicit in the code.
 */
export function settlementDefaults(data: RateCardData): SettlementDefaults {
  const workbookRate = (mode: string): number | undefined => {
    if (mode === 'air' || mode === 'nfo') return data.charges.gstAir;
    if (mode === 'surface' || mode === 'rail') return data.charges.gstSurface;
    return undefined;
  };

  const modeTax: Record<string, StoredModeTax> = {};
  for (const [mode, profile] of Object.entries(DEFAULT_MODE_TAX)) {
    modeTax[mode] = {
      sac: profile.sac,
      gstRate: workbookRate(mode) ?? profile.gstRate,
      // Forward charge, because that is what the workbooks compute. Switching a mode to
      // reverse charge is a decision for the business, made on the tab and approved.
      rcm: 'No',
      itc: flag(profile.itc),
    };
  }

  const chargeCatalog: Record<string, StoredCharge> = {};
  for (const charge of DEFAULT_CHARGES) {
    chargeCatalog[charge.id] = {
      name: charge.name,
      basis: charge.basis,
      amount: charge.id === 'docket' ? data.charges.docket : charge.amount,
      gstApplies: flag(charge.gstApplies),
      fuelApplies: flag(charge.fuelApplies),
      active: flag(charge.active),
      // Per-destination charges carry a cell per zone, at zero, so every one of them is
      // editable and reviewable. A zero charge never reaches a quote.
      ...(charge.basis === 'per-destination'
        ? { byDestination: Object.fromEntries(SURFACE_ZONES.map((zone) => [zone, 0])) }
        : charge.byDestination === undefined
          ? {}
          : { byDestination: charge.byDestination }),
      // Empty rather than absent: the cell exists on the tab, and empty means every mode.
      modes: charge.modes?.join(', ') ?? '',
    };
  }

  const ftlRates: Record<string, Record<string, Record<string, number | null>>> = {};
  for (const vehicle of VEHICLE_TYPES) {
    const byOrigin: Record<string, Record<string, number | null>> = {};
    for (const origin of SURFACE_ZONES) {
      const row: Record<string, number | null> = {};
      for (const destination of SURFACE_ZONES) row[destination] = null;
      byOrigin[origin] = row;
    }
    ftlRates[vehicle.code] = byOrigin;
  }

  return {
    modeTax,
    ftl: { rates: ftlRates },
    charges: {
      fuelFtl: data.charges.fuelFtl ?? 0,
      minWeightRail: data.charges.minWeightRail ?? data.charges.minWeightSurface,
      volumetricDivisorRail:
        data.charges.volumetricDivisorRail ?? data.charges.volumetricDivisorSurface,
    },
    fuelBase: {
      freight: flag(WORKBOOK_FUEL_BASE.freight),
      pickup: flag(WORKBOOK_FUEL_BASE.pickup),
      delivery: flag(WORKBOOK_FUEL_BASE.delivery),
      oda: flag(WORKBOOK_FUEL_BASE.oda),
      charges: flag(WORKBOOK_FUEL_BASE.charges),
    },
    chargeCatalog,
  };
}

/** Whether a value counts as present. An empty record is treated as not yet filled. */
function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as object).length > 0;
  }
  return true;
}

/** Recursively fill keys `target` lacks from `source`, never overwriting a set value. */
function fillFrom<T>(target: T, source: T): T {
  if (!isFilled(target)) return source;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return target;
  if (typeof source !== 'object' || source === null) return target;

  const result = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    result[key] = fillFrom(result[key], value);
  }
  return result as T;
}

/**
 * The settlement blocks a card is missing, ready to write.
 *
 * The configuration gains fields over time — the per-zone ESS amounts arrived after the
 * first cards were seeded — so this fills gaps at any depth rather than only whole blocks.
 * An edited value is never overwritten, and a fully configured card yields nothing to do.
 */
export function settlementFill(
  data: RateCardData,
): Partial<Pick<RateCardData, 'modeTax' | 'fuelBase' | 'chargeCatalog' | 'ftl' | 'charges'>> {
  const defaults = settlementDefaults(data);
  const fill: Partial<
    Pick<RateCardData, 'modeTax' | 'fuelBase' | 'chargeCatalog' | 'ftl' | 'charges'>
  > = {};

  const modeTax = fillFrom(data.modeTax, defaults.modeTax);
  if (JSON.stringify(modeTax) !== JSON.stringify(data.modeTax)) fill.modeTax = modeTax;

  const fuelBase = fillFrom(data.fuelBase, defaults.fuelBase);
  if (JSON.stringify(fuelBase) !== JSON.stringify(data.fuelBase)) fill.fuelBase = fuelBase;

  const ftl = fillFrom(data.ftl, defaults.ftl);
  if (JSON.stringify(ftl) !== JSON.stringify(data.ftl)) fill.ftl = ftl;

  // Only the parameters no workbook carries are filled in; everything else on `charges`
  // came from the source and is left exactly as extracted.
  // A default that is itself undefined is nothing to fill — writing it back would leave
  // the key still missing and report the same gap on every run.
  const missing = Object.entries(defaults.charges).filter(
    ([key, value]) =>
      value !== undefined &&
      (data.charges as unknown as Record<string, unknown>)[key] === undefined,
  );
  if (missing.length > 0) {
    fill.charges = { ...data.charges, ...Object.fromEntries(missing) };
  }

  // An array catalog comes from the API rather than from a card, so it is left as it is.
  if (!Array.isArray(data.chargeCatalog)) {
    const catalog = fillFrom(data.chargeCatalog, defaults.chargeCatalog);
    if (JSON.stringify(catalog) !== JSON.stringify(data.chargeCatalog)) fill.chargeCatalog = catalog;
  }

  return fill;
}
