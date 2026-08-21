import type { Pincode } from '../domain/types';
import type { CustomerDoc } from '../data/customers';

/**
 * Our data, in the shapes the core's surviving code already reads.
 *
 * This file exists because of what removing a screen does not remove. When the core's
 * pricing and customer-master screens go, the code that *read* what they wrote stays:
 * booking resolves a pincode, the enterprise portal shows a billing configuration, the
 * contract form fills a city dropdown. Those readers do not care who authored the data,
 * only what shape it arrives in.
 *
 * So each function here answers one query that a surviving file makes today, field for
 * field. Their `Pincode.findOne({ pincode })` becomes a call to us that returns the same
 * document — nothing on their side has to learn a new vocabulary at the moment of cutover,
 * which is what makes the cutover survivable.
 *
 * Where we genuinely do not hold a field, it is returned empty rather than invented.
 * `connScore` is theirs, computed from hub and network data we have never held; a plausible
 * number in that slot would be a lie that prices nothing but reads as fact.
 */

/** Their `IPincode`, from ours. Field names and order follow their model exactly. */
export interface LegacyPincode {
  pincode: string;
  locality: string;
  state: string;
  district: string;
  citySection: string;
  lat: number;
  lon: number;
  hub: string;
  airport: string;
  aptDistKm: number;
  aptCategory: string;
  aptScope: string;
  cargoHub: string;
  cargoDistKm: number;
  majorArpt: string;
  serviceZone: string;
  oda: string;
  odaStatus: string;
  odaSlab: number;
  zone: string;
  lane: string;
  deliverySla: string;
  routeType: string;
  hubSpoke: string;
  cod: string;
  reversePickup: string;
  connScore: number;
}

export function toLegacyPincode(pincode: Pincode, transitDays: number | null = null): LegacyPincode {
  const surface = pincode.surface;
  const air = pincode.air;

  return {
    // Theirs is a string and zero-padded; ours is a number. A pincode beginning with a
    // zero would otherwise arrive as five digits and match nothing.
    pincode: String(pincode.pincode).padStart(6, '0'),
    locality: pincode.area,
    state: pincode.state,
    district: pincode.bluedart?.district ?? '',
    citySection: pincode.city ?? '',
    // Geocoding is the core's; we hold no coordinates.
    lat: 0,
    lon: 0,
    hub: surface.hub,
    airport: air.hub,
    aptDistKm: air.edlKm,
    aptCategory: air.odaCategory,
    aptScope: air.serviceable ? 'served' : 'not served',
    cargoHub: surface.hub,
    cargoDistKm: surface.edlKm,
    majorArpt: air.hub,
    serviceZone: surface.zone,
    oda: surface.oda ? 'Y' : 'N',
    odaStatus: surface.odaCategory,
    odaSlab: surface.edlKm,
    zone: surface.zone,
    lane: surface.zone,
    deliverySla: transitDays === null ? '' : `${transitDays} day${transitDays === 1 ? '' : 's'}`,
    routeType: '',
    hubSpoke: '',
    cod: '',
    reversePickup: '',
    // Theirs, from hub and network data we have never held. Zero, never guessed.
    connScore: 0,
  };
}

/* --------------------------------------------------------- customer master */

/** Their `ICustomerMaster`, from ours. */
export interface LegacyCustomerMaster {
  custId: string;
  name: string;
  tier: string;
  segment: string;
  chargeConfig: string;
  pdConfig: string;
  odaConfig: string;
  gstProfile: string;
  discountPct: number;
  validFrom: string;
  validTo: string;
  payment: string;
  notes: string;
  billingCycle: string;
  creditPeriod: string;
  billingBasis: string;
  gstTreatment: string;
  preferredCarrierId: string;
}

/**
 * "Not configured" rather than an empty string.
 *
 * Their own `billing-config` endpoint substitutes exactly this wording when a field is
 * unset, and the portal renders it. Returning `""` instead would show a customer a blank
 * where their own system showed a sentence.
 */
const orNotConfigured = (value: string | undefined) =>
  value === undefined || value.trim() === '' ? 'Not configured' : value;

export function toLegacyCustomerMaster(customer: CustomerDoc): LegacyCustomerMaster {
  const billing = customer.enterprise?.billing;
  const terms = customer.commercial;

  return {
    custId: customer.code,
    name: customer.name,
    // Free text on their side too: the account in their own portal is on "Walk-in", which
    // their dropdown never offered.
    tier: billing?.tier ?? 'Walk-in',
    segment: '',
    // Config profile ids are theirs; we hold the rates those profiles named, not the ids.
    chargeConfig: '',
    pdConfig: '',
    odaConfig: '',
    gstProfile: billing?.gstProfile ?? '',
    discountPct: 0,
    validFrom: '',
    validTo: '',
    payment: terms?.paymentTermsDays ? `${terms.paymentTermsDays} Days` : '',
    notes: '',
    billingCycle: orNotConfigured(billing?.cycle),
    creditPeriod: orNotConfigured(billing?.creditPeriod),
    billingBasis: orNotConfigured(billing?.basis),
    gstTreatment: orNotConfigured(billing?.gstTreatment),
    preferredCarrierId: '',
  };
}

/* ------------------------------------------------------ customer rate card */

/** Their `ICustomerRateCard`, one row per negotiated lane. */
export interface LegacyCustomerRateCard {
  custId: string;
  customer: string;
  level: string;
  origHub: string;
  origCity: string;
  origZone: string;
  destHub: string;
  destCity: string;
  destZone: string;
  carrierId: string;
  slabProfileId: string;
  slabs: { weight: number; rate: number }[];
  minFrt: number;
  validFrom: string;
  validTo: string;
  notes: string;
}

/**
 * A customer's negotiated rates as their `CustomerRateCard` rows.
 *
 * Two things this translation has to be honest about.
 *
 * Their slabs are a single rate for the whole weight — their `getRateForWeight` takes the
 * last slab whose weight the consignment reaches, and multiplies once. Our Model 1 builds
 * freight from several bands cumulatively, so the same numbers put through their engine
 * would produce a different total. That is acceptable here and only here: this feeds the
 * portal's Contracts tab, which displays rates and prices nothing. It must never become an
 * input to pricing.
 *
 * And a rule agreed at pincode level has no representation at all — their `level` enum
 * stops at CITY. Rather than filing it under a coarser level and quietly widening what the
 * customer negotiated, those are left out and counted, so a caller can see that what it
 * received is not the whole contract.
 */
export interface LegacyRatesResult {
  rates: LegacyCustomerRateCard[];
  /** Rules we hold that their shape cannot express. Zero is the normal case. */
  notRepresentable: number;
}

const LEVEL_FOR: Record<string, string> = {
  'city:city': 'CITY',
  'zone:zone': 'ZONE',
  'state:state': 'STATE',
  'city:state': 'CITY_STATE',
  'city:zone': 'CITY_ZONE',
  'state:zone': 'STATE_ZONE',
  'state:city': 'CITY_STATE',
  'zone:city': 'CITY_ZONE',
  'zone:state': 'STATE_ZONE',
};

/** Their `ICityReference`, derived from the pincode master rather than kept as a list. */
export interface LegacyCity {
  cityId: string;
  cityName: string;
  hub: string;
  prefixes: string[];
  metro: string;
  pinCount: number;
  notes: string;
}

/**
 * Cities, from the pincodes that are in them.
 *
 * Derived rather than stored, for the same reason `knownZones` is: a second list of cities
 * would go stale the first time a pincode moved hub, and nothing would say so. The prefix
 * list is the distinct first three digits, which is what makes a city findable by pincode.
 */
export function toLegacyCities(pincodes: readonly Pincode[]): LegacyCity[] {
  const byCity = new Map<string, { hub: string; prefixes: Set<string>; count: number }>();

  for (const pincode of pincodes) {
    // `area` is a post office, not a city — 300 of them in Maharashtra alone — so a city
    // is only named where we actually hold one.
    const name = pincode.city?.trim();
    if (!name) continue;

    const key = name.toLowerCase();
    const entry = byCity.get(key) ?? { hub: pincode.surface.hub, prefixes: new Set(), count: 0 };
    entry.prefixes.add(String(pincode.pincode).padStart(6, '0').slice(0, 3));
    entry.count += 1;
    byCity.set(key, entry);
  }

  return [...byCity.entries()]
    .map(([key, entry]) => ({
      cityId: key.replace(/[^a-z0-9]+/g, '-'),
      cityName: key.replace(/\b\w/g, (character) => character.toUpperCase()),
      hub: entry.hub,
      prefixes: [...entry.prefixes].sort(),
      metro: '',
      pinCount: entry.count,
      notes: '',
    }))
    // Their own query sorts by hub then city; matching it means their dropdown renders
    // identically without the client sorting again.
    .sort((a, b) => a.hub.localeCompare(b.hub) || a.cityName.localeCompare(b.cityName));
}


/**
 * Builds their rate rows from a customer's effective contract.
 *
 * Rows carry the *effective* numbers, not the negotiated deltas: a customer who moved one
 * band still wants to read their whole rate, and a row showing only what changed would be
 * unreadable next to a contract document.
 */
export function toLegacyCustomerRateCards(
  customer: CustomerDoc,
  effective: {
    grids: Record<string, { minCharge: Lane; tier1: Lane; tier2: Lane; tier3: Lane }>;
    minWeight: Record<string, number>;
  },
  negotiated: readonly { mode: string; origin: string; destination: string }[],
): LegacyRatesResult {
  const rates: LegacyCustomerRateCard[] = [];

  for (const lane of negotiated) {
    const grids = effective.grids[lane.mode];
    if (!grids) continue;

    const at = (grid: Lane) => grid?.[lane.origin]?.[lane.destination] ?? null;
    const floor = effective.minWeight[lane.mode] ?? 0;

    // Their slab weights are lower bounds; ours are the same boundaries the engine uses.
    const slabs = [
      { weight: floor, rate: at(grids.tier1) },
      { weight: 100, rate: at(grids.tier2) },
      { weight: 300, rate: at(grids.tier3) },
    ]
      // A band the card does not price is left out rather than sent as zero, which their
      // reader would show as free freight above that weight.
      .filter((slab): slab is { weight: number; rate: number } => slab.rate !== null)
      .sort((a, b) => a.weight - b.weight);

    rates.push({
      custId: customer.code,
      customer: customer.name,
      // Bind-path overrides are keyed by zone on both ends, which is exactly their ZONE.
      level: 'ZONE',
      origHub: lane.origin,
      origCity: '',
      origZone: lane.origin,
      destHub: lane.destination,
      destCity: '',
      destZone: lane.destination,
      carrierId: '',
      slabProfileId: 'STANDARD',
      slabs,
      minFrt: at(grids.minCharge) ?? 0,
      validFrom: '',
      validTo: '',
      notes: `${lane.mode} · negotiated`,
    });
  }

  // Rules agreed at pincode level cannot be expressed; their enum stops at CITY.
  const notRepresentable = Object.values(customer.liveTerms.laneRules ?? {}).filter(
    (rule) =>
      rule.origin.kind === 'pincode' ||
      rule.destination.kind === 'pincode' ||
      rule.origin.kind === 'group' ||
      rule.destination.kind === 'group',
  ).length;

  // Lane rules that do map onto one of their levels.
  for (const rule of Object.values(customer.liveTerms.laneRules ?? {})) {
    const level = LEVEL_FOR[`${rule.origin.kind}:${rule.destination.kind}`];
    if (!level) continue;

    const slabs = [
      { weight: 0, rate: rule.rates.tier1 },
      { weight: 100, rate: rule.rates.tier2 },
      { weight: 300, rate: rule.rates.tier3 },
    ].filter((slab): slab is { weight: number; rate: number } => slab.rate !== null);

    const origin = rule.origin.value ?? '';
    const destination = rule.destination.value ?? '';

    rates.push({
      custId: customer.code,
      customer: customer.name,
      level,
      origHub: rule.origin.kind === 'zone' ? origin : '',
      origCity: rule.origin.kind === 'city' ? origin : '',
      origZone: rule.origin.kind === 'zone' ? origin : '',
      destHub: rule.destination.kind === 'zone' ? destination : '',
      destCity: rule.destination.kind === 'city' ? destination : '',
      destZone: rule.destination.kind === 'zone' ? destination : '',
      carrierId: '',
      slabProfileId: 'STANDARD',
      slabs,
      minFrt: rule.rates.minCharge ?? 0,
      validFrom: '',
      validTo: '',
      notes: `${rule.mode} · lane rule`,
    });
  }

  return { rates, notRepresentable };
}

type Lane = Record<string, Record<string, number | null>> | undefined;
