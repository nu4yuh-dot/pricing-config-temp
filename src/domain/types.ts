/**
 * Domain types shared by the pricing engine, the sheet layouts and the data layer.
 *
 * These mirror the structure of the source workbooks (see
 * docs/superpowers/specs/2026-08-03-pricing-config-design.md §2) but resolve the
 * defects catalogued in §2.4 — one value per parameter, no stale display copies.
 */

// Type-only, so it is erased at compile time and the two modules do not depend on each
// other at runtime. `StoredLaneRule` lives beside the functions that read and write it.
import type { StoredLaneRule } from './lane-rule-store';

export const MODES = ['air', 'surface', 'rail', 'nfo'] as const;
export type Mode = (typeof MODES)[number];

/** Modes whose rates are stored. `nfo` is derived as 2x `air`. */
export const STORED_MODES = ['air', 'surface', 'rail'] as const;
export type StoredMode = (typeof STORED_MODES)[number];

/**
 * How a rate card turns weight and per-kg tiers into freight. The three source
 * workbooks each use a different one of these; see spec §2.2.
 */
export const FREIGHT_METHODS = [
  /** Model 1: minCharge + sum over slabs of (kg in that slab x its rate). */
  'CUMULATIVE_SLABS',
  /** Model 2: minCharge + oneRate(total wt) x (chargeable wt - min wt). */
  'MIN_PLUS_EXCESS',
  /** Model 3: max(minCharge, oneRate(total wt) x full chargeable wt). */
  'MAX_MIN_OR_FULL',
] as const;
export type FreightMethod = (typeof FREIGHT_METHODS)[number];

/** `null` is the source workbook's `'-'`: the mode does not serve that lane. */
export type Grid = Record<string, Record<string, number | null>>;

export interface ModeGrids {
  /** Fixed / minimum charge in Rs, covering weight up to the mode's min weight. */
  minCharge: Grid;
  /** Rs/kg for minWeight..100 kg. */
  tier1: Grid;
  /** Rs/kg for 100..300 kg. */
  tier2: Grid;
  /** Rs/kg for 300 kg and above. */
  tier3: Grid;
}

export type GridName = keyof ModeGrids;
export const GRID_NAMES = ['minCharge', 'tier1', 'tier2', 'tier3'] as const;

/** Slab boundaries. The lower bound of tier1 is the mode's min weight. */
export const TIER2_FROM = 100;
export const TIER3_FROM = 300;

export interface ZoneCartage {
  pickupSurface: number;
  deliverySurface: number;
  pickupAir: number;
  deliveryAir: number;
}

export type PickupDelivery = Record<string, ZoneCartage>;

/**
 * ODA / EDL surcharge. Rows are minimum-km thresholds, columns minimum-weight
 * thresholds; both are matched approximately (largest threshold <= value), which
 * is what the source workbook's `MATCH(..., 1)` does.
 */
export interface EdlMatrix {
  kmBands: number[];
  weightBands: number[];
  /** `rates[kmBandIndex][weightBandIndex]` in Rs per shipment. */
  rates: number[][];
  /** Beyond the last km band, charge this per km. */
  perKmBeyondLastBand: number;
  /** The distance past which `perKmBeyondLastBand` applies. */
  perKmThreshold: number;
}

export interface TransitTimes {
  /** Working days, air hub to air hub. `null` where the mode does not serve the lane. */
  air: Record<string, Record<string, number | null>>;
  surface: Record<string, Record<string, number | null>>;
  rail: Record<string, Record<string, number | null>>;
}

/**
 * Global charge parameters. In the source these live in `Charges & Terms`
 * column E; column B was a stale copy that disagreed with it (spec §2.4 defect 3).
 */
export interface Charges {
  pickupAir: number;
  deliveryAir: number;
  pickupSurface: number;
  deliverySurface: number;
  docket: number;
  /** Fractions, not percentages: 0.18 is 18%. */
  gstAir: number;
  gstSurface: number;
  minWeightAir: number;
  minWeightSurface: number;
  /**
   * Rail's own, when it has one. Absent falls back to surface, which is what the source
   * workbooks assumed — they had no rail field, not because rail bills the same way.
   */
  minWeightRail?: number;
  volumetricDivisorAir: number;
  volumetricDivisorSurface: number;
  /** Rail's own volumetric divisor. Absent falls back to surface. */
  volumetricDivisorRail?: number;
  fuelAir: number;
  fuelSurface: number;
  /** Rail carries no fuel surcharge. Held explicitly rather than special-cased. */
  fuelRail: number;
  /** FTL fuel surcharge. Absent on cards imported before FTL existed. */
  fuelFtl?: number;
  /** Rail parcel norm: a single package at or above this is charged at 2x weight. */
  railHeavyPackageThreshold: number;
  railHeavyPackageMultiplier: number;
  /** NFO is a multiple of the air card. */
  nfoMultiplier: number;
}

/**
 * Zone descriptions, editable via the Cluster Guide tab. Held per card so they
 * version and approve alongside the rates rather than in a separate stream; the
 * set of zone *codes* is structural and lives in `domain/zones.ts`.
 */
export interface ZoneLabels {
  surface: Record<string, { belt: string }>;
  air: Record<string, { city: string }>;
}

/**
 * Buy-side tariff for a lane, in the same shape as sell so the same freight function
 * prices both. Held per mode, keyed by origin then destination.
 */
export interface CostGrids {
  carrier: string;
  method: FreightMethod;
  grids: Record<StoredMode, ModeGrids>;
}

/**
 * A yes/no switch as it is stored.
 *
 * Every value in this system is edited, diffed and approved as a spreadsheet cell, and
 * a cell holds text. Storing these as the words a person types keeps the tax and fuel
 * switches inside that machinery instead of beside it. Booleans are accepted too, for
 * the booking API; `isOn` in pricing/card-config.ts reads either.
 */
export type Flag = 'Yes' | 'No' | boolean;

/** One entry in the charge catalog, in stored form. */
export interface StoredCharge {
  /** Present on the array form the API posts; the record form uses the key. */
  id?: string;
  name?: string;
  basis?: string;
  amount?: number;
  gstApplies?: Flag;
  fuelApplies?: Flag;
  active?: Flag;
  /**
   * May an operator add this to a single booking, for a customer with no standing term?
   *
   * A `Flag` rather than a boolean because it is an ordinary cell: the grid editors and the
   * source workbooks write the word. It was written by `createLibraryCharge` and absent
   * from this type, which is how the library came to compare it against `true`.
   */
  bookableOneOff?: Flag;
  /** For `per-destination` charges: amount by destination zone. */
  byDestination?: Record<string, number>;
  /** `air, nfo` in a cell; an array from the API. Absent means every mode. */
  modes?: string | string[];
}

export interface StoredModeTax {
  sac?: string;
  /** Fraction, not percent. */
  gstRate?: number;
  rcm?: Flag;
  itc?: Flag;
}

export interface RateCardData {
  grids: Record<StoredMode, ModeGrids>;
  /**
   * Lane rules, keyed by a stable id.
   *
   * Additive. The grid above is exactly the case where both endpoints are zones, and a
   * card with no rules quotes as it always did — which is what keeps the golden fixtures
   * meaningful through this change. Keyed by id rather than held in a list so that every
   * rate has a stable dotted path, and the override, diff and approval machinery works on
   * a rule without knowing rules exist.
   */
  laneRules?: Record<string, StoredLaneRule>;
  pickupDelivery: PickupDelivery;
  edlMatrix: EdlMatrix;
  transitTimes: TransitTimes;
  charges: Charges;
  zones: ZoneLabels;
  /**
   * Per-mode GST treatment. Absent means the card is taxed at its own `charges.gst*`
   * rate under forward charge, which is what the imported workbooks imply.
   */
  modeTax?: Record<string, StoredModeTax>;
  /**
   * Which components the fuel percentage is charged on. Absent means the workbook base:
   * freight, both cartage legs and both ODA legs.
   */
  fuelBase?: { freight?: Flag; pickup?: Flag; delivery?: Flag; oda?: Flag; charges?: Flag };
  /**
   * Ancillary charges, keyed by charge id so each field is an editable cell. Absent
   * means the single docket field; empty means no charges at all.
   */
  chargeCatalog?: Record<string, StoredCharge> | StoredCharge[];
  /** Buy tariff, enabling margin checks and reconciliation. */
  cost?: CostGrids;
  /**
   * Full-truck-load rates: vehicle code, then origin zone, then destination zone. A truck
   * is hired whole, so there are no weight tiers here — see pricing/ftl.ts.
   */
  ftl?: { rates: Record<string, Record<string, Record<string, number | null>>> };
  /**
   * The Bluedart franchise card: directional zones, four services, its own ODA matrix and
   * charges. Present only on the Bluedart product's card, so the rates live in one place
   * rather than being copied onto each DNS card where they would drift apart.
   */
  bluedart?: import('./bluedart').BluedartCardData;
  /**
   * The UPS / MOVIN international export card: destination countries rather than lanes,
   * three products, a per-kilogram surge by world region. Present only on the UPS card.
   */
  ups?: import('./ups').UpsCardData;
}

/**
 * Where a card's rates come from — our own network, or a franchise partner's.
 *
 * The three DNS cards differ only in freight *method*; they are one network priced three
 * ways. Bluedart is somebody else's tariff entirely: different zones, different services,
 * different charges. UPS is a third thing again — an international export tariff whose
 * destination is a country rather than a pincode.
 *
 * This was called `product` until the redesign, which needs that word for something else
 * — a named, sellable package bundling a rate template with coverage and charges. Two
 * meanings on one word in a pricing system is how a card ends up filed under the wrong
 * thing, so the older and narrower meaning gave the name up.
 */
export const CARD_SOURCES = ['dns', 'bluedart', 'ups'] as const;
export type CardSource = (typeof CARD_SOURCES)[number];

export interface RateCard {
  key: string;
  name: string;
  freightMethod: FreightMethod;
  /**
   * The card version these numbers came from.
   *
   * Optional because a card assembled in a test or in memory has no version. Populated by
   * `liveCard`, and it survives `effectiveCard`, so a contracted card still reports the
   * base version its prices were built on — which is what a quote has to record to be
   * explainable after the card moves on.
   */
  version?: number;
  /** Absent means `dns`, so every card that predates the distinction still reads right. */
  source?: CardSource;
  /**
   * What `source` was called before. Read-only compatibility: rows written by an earlier
   * version still carry it, and normalising on read is cheaper and safer than migrating a
   * live collection for a rename.
   *
   * @deprecated Use `source`.
   */
  product?: CardSource;
  data: RateCardData;
}

/** A pincode's resolution for one mode. */
export interface PincodeModeInfo {
  serviceable: boolean;
  hub: string;
  zone: string;
  edlKm: number;
  oda: boolean;
  odaCategory: string;
}

export interface Pincode {
  pincode: number;
  area: string;
  state: string;
  /**
   * Optional and not yet populated. `area` is a post office, not a city — 300 of them
   * in Maharashtra alone — so a `city` lane rule has nothing to match on until a
   * source for this is chosen. Declared here so the matcher can be built and tested
   * ahead of that decision.
   */
  city?: string;
  air: PincodeModeInfo;
  surface: PincodeModeInfo;
  rail: PincodeModeInfo & { station: string };
  /**
   * How the same pincode resolves on the Bluedart franchise card: a directional zone
   * ex-Pune rather than a lane endpoint. Optional because it arrives by a separate merge
   * (scripts/extract_bluedart.py) and a card seeded before it should still quote.
   */
  bluedart?: {
    zone: string;
    /** The card's own wording, e.g. `Non-ODA`, `ODA 3`, `Not in APEX`. */
    odaStatus: string;
    edlKm: number;
    district: string;
  };
}
