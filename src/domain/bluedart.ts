/**
 * The Bluedart franchise rate card.
 *
 * A different product from the DNS cards, not another set of numbers in the same shape.
 * Four things about it are structurally unlike anything else in this system:
 *
 *  1. **Directional zones, not a lane matrix.** Everything ships ex-Pune, so a price
 *     depends only on where it is going: five zones by distance band, not 21 x 21 lanes.
 *  2. **Four services, each with its own weight rules.** Documents and non-documents are
 *     billed per 500 g against a floor; APEX and SURFACE have a fixed first block and then
 *     per-kg slabs.
 *  3. **Incremental slabs.** Each band's rate applies only to the kilograms inside that
 *     band, and the bands are added. This is the same shape as `CUMULATIVE_SLABS` but with
 *     a fixed first block instead of a minimum charge, and different boundaries.
 *  4. **Its own charges.** AWB, FOV as a percentage of declared value with a floor, and a
 *     fuel surcharge levied on freight *plus ODA* — at two different percentages.
 *
 * Source: DNS_Directional_RateCard_Calculator.xlsx. Rates below are that workbook's
 * `Rate Data` tab as shipped, and are editable in the app like any other rate.
 */

export const BLUEDART_ZONES = ['WEST', 'NORTH', 'SOUTH', 'EAST', 'NE & REMOTE'] as const;
export type BluedartZone = (typeof BLUEDART_ZONES)[number];

export const BLUEDART_SERVICES = ['DOCs', 'DUTS', 'APEX', 'SURFACE'] as const;
export type BluedartService = (typeof BLUEDART_SERVICES)[number];

export const SERVICE_LABELS: Record<BluedartService, string> = {
  DOCs: 'Documents (DOX)',
  DUTS: 'Non-documents (DUTS / DP)',
  APEX: 'APEX — air, premium',
  SURFACE: 'Surface — economy',
};

/** Which services are billed per 500 g rather than by weight slabs. */
export const PER_500G_SERVICES: BluedartService[] = ['DOCs', 'DUTS'];

/** Which services carry AWB, FOV and ODA. The document services carry none of them. */
export const FULL_CHARGE_SERVICES: BluedartService[] = ['APEX', 'SURFACE'];

/**
 * Rates for one zone.
 *
 * `docs` and `duts` are per 500 g. `apex` and `surface` are a fixed first block followed
 * by per-kg rates for each band above it.
 */
export interface ZoneRates {
  /** Rs per 500 g. */
  docs: number;
  /** Rs per 500 g. */
  duts: number;
  apex: SlabRates;
  surface: SlabRates;
}

export interface SlabRates {
  /** Flat charge covering everything up to the service's minimum weight. */
  firstBlock: number;
  /** Rs/kg from the minimum weight to 25 kg. */
  to25: number;
  /** Rs/kg from 25 to 50 kg. */
  to50: number;
  /** Rs/kg from 50 to 100 kg. */
  to100: number;
  /** Rs/kg above 100 kg. */
  above100: number;
}

/** Minimum chargeable weight per service, in kg. */
export const MIN_WEIGHT: Record<BluedartService, number> = {
  DOCs: 0.5,
  DUTS: 1,
  APEX: 5,
  SURFACE: 10,
};

/** Minimum charge for the per-500 g services, in Rs. */
export const MIN_CHARGE: Record<'DOCs' | 'DUTS', number> = {
  DOCs: 50,
  DUTS: 200,
};

/** Slab boundaries above the first block. Shared by APEX and SURFACE. */
export const SLAB_25 = 25;
export const SLAB_50 = 50;
export const SLAB_100 = 100;

export interface BluedartOdaMatrix {
  /** Minimum km for each row, ascending. Matched approximately: the largest <= distance. */
  kmBands: number[];
  /** Minimum chargeable weight for each column, ascending. Matched the same way. */
  weightBands: number[];
  /** `rates[kmBandIndex][weightBandIndex]`, Rs per consignment. */
  rates: number[][];
  /** Beyond the last km band, this per km replaces the matrix entirely. */
  perKmBeyond: number;
  /** The distance past which `perKmBeyond` applies. */
  perKmThreshold: number;
}

export interface BluedartCharges {
  /** Fraction. Levied on freight + ODA for APEX, on freight alone for DOCs and DUTS. */
  fuelAir: number;
  /** Fraction. Levied on freight + ODA. */
  fuelSurface: number;
  /** Rs per consignment, APEX and SURFACE only. */
  awb: number;
  /** Fraction of declared value. */
  fovRate: number;
  /** Rs. The FOV floor, charged even when the declared value is nil. */
  fovMinimum: number;
  /** Fraction, on the pre-GST sub-total. */
  gstRate: number;
  /** Services Accounting Code for the invoice. */
  sac: string;
  /** Air and DUTS volumetric divisor: L x W x H cm / this. */
  volumetricDivisorAir: number;
  /**
   * Surface volumetric: (L x W x H cm / divisor) x multiplier. Held as two numbers
   * because the rate card states it that way — 27000 and 8 — rather than as one divisor.
   */
  volumetricDivisorSurface: number;
  volumetricMultiplierSurface: number;
}

export interface BluedartCardData {
  zones: Record<string, ZoneRates>;
  oda: BluedartOdaMatrix;
  charges: BluedartCharges;
}

/** The workbook's `Rate Data` tab, as shipped. */
export const BLUEDART_DEFAULT_RATES: Record<BluedartZone, ZoneRates> = {
  WEST: {
    docs: 50,
    duts: 40,
    apex: { firstBlock: 620, to25: 124, to50: 120, to100: 112, above100: 99 },
    surface: { firstBlock: 160, to25: 13, to50: 12.5, to100: 12, above100: 11.5 },
  },
  NORTH: {
    docs: 58,
    duts: 50,
    apex: { firstBlock: 620, to25: 124, to50: 120, to100: 112, above100: 99 },
    surface: { firstBlock: 165, to25: 14, to50: 13.5, to100: 13, above100: 12.5 },
  },
  SOUTH: {
    docs: 58,
    duts: 52,
    apex: { firstBlock: 620, to25: 124, to50: 120, to100: 112, above100: 99 },
    surface: { firstBlock: 165, to25: 14, to50: 13.5, to100: 13, above100: 12.5 },
  },
  EAST: {
    docs: 69,
    duts: 55,
    apex: { firstBlock: 720, to25: 145, to50: 140, to100: 131, above100: 116 },
    surface: { firstBlock: 190, to25: 16, to50: 15.5, to100: 15, above100: 14.5 },
  },
  'NE & REMOTE': {
    docs: 75,
    duts: 60,
    apex: { firstBlock: 900, to25: 190, to50: 185, to100: 175, above100: 165 },
    surface: { firstBlock: 350, to25: 26, to50: 25, to100: 24, above100: 23 },
  },
};

/** The workbook's `ODA Matrix` tab, as shipped. */
export const BLUEDART_DEFAULT_ODA: BluedartOdaMatrix = {
  kmBands: [20, 51, 101, 151, 201, 251, 301, 401],
  weightBands: [0, 101, 251, 501, 1001],
  rates: [
    [550, 990, 1100, 1375, 1650],
    [825, 1210, 1375, 1650, 1925],
    [1100, 1650, 1925, 2200, 2750],
    [1375, 1925, 2200, 2475, 3300],
    [1650, 2200, 2750, 3300, 3960],
    [1925, 2500, 3150, 3800, 4560],
    [2475, 3100, 3950, 4800, 5760],
    [3025, 3700, 4750, 5800, 6960],
  ],
  perKmBeyond: 14,
  perKmThreshold: 500,
};

export const BLUEDART_DEFAULT_CHARGES: BluedartCharges = {
  fuelAir: 0.92,
  fuelSurface: 0.65,
  awb: 100,
  fovRate: 0.0033,
  fovMinimum: 200,
  gstRate: 0.18,
  // Courier and express, which is how all four of these services are classified.
  sac: '9968',
  volumetricDivisorAir: 5000,
  volumetricDivisorSurface: 27000,
  volumetricMultiplierSurface: 8,
};

export const BLUEDART_DEFAULT_DATA: BluedartCardData = {
  zones: BLUEDART_DEFAULT_RATES,
  oda: BLUEDART_DEFAULT_ODA,
  charges: BLUEDART_DEFAULT_CHARGES,
};

/**
 * Which states each zone covers, from the workbook's `Zone Directory`.
 *
 * Held for display and for checking the pincode master against — the zone a shipment
 * actually prices at comes from the pincode, not from this.
 */
export const ZONE_STATES: Record<BluedartZone, string> = {
  WEST: 'Maharashtra, Gujarat, Goa, Madhya Pradesh, Chhattisgarh, Dadra & NH, Daman & Diu',
  NORTH: 'Delhi, Uttar Pradesh, Rajasthan, Punjab, Haryana, Uttarakhand, Himachal Pradesh, Chandigarh',
  SOUTH: 'Karnataka, Telangana, Andhra Pradesh, Tamil Nadu, Kerala, Puducherry',
  EAST: 'West Bengal, Bihar, Jharkhand, Odisha',
  'NE & REMOTE':
    'Assam, Arunachal, Manipur, Meghalaya, Mizoram, Nagaland, Tripura, Sikkim, J&K, Ladakh, Andaman & Nicobar, Lakshadweep',
};

export const ZONE_DISTANCE_TIER: Record<BluedartZone, string> = {
  WEST: 'Nearest (home region)',
  NORTH: 'Mid',
  SOUTH: 'Mid',
  EAST: 'Far',
  'NE & REMOTE': 'Premium / remote',
};

/** How a destination pincode resolves on this product. */
export interface BluedartPincodeInfo {
  zone: string;
  /**
   * The workbook's own wording: `Non-ODA`, `ODA 1`..`ODA 10`, `Below Range (<20)`,
   * `Above Range (>500)`, `Not in APEX`. Kept verbatim rather than reduced to a boolean,
   * because the exact words decide both the surcharge and whether APEX is offered.
   */
  odaStatus: string;
  edlKm: number;
}

/** Whether a status means the ODA surcharge applies. */
export function isOdaStatus(status: string): boolean {
  return status.startsWith('ODA');
}

/** 15 pincodes are marked not serviceable by APEX. */
export function isApexServiceable(status: string): boolean {
  return status !== 'Not in APEX';
}
