import { STORED_MODES, type Mode, type StoredMode } from './types';

/**
 * Services — what a customer actually buys, as against the network that carries it.
 *
 * The distinction this file exists for: a *mode* is a physical network (road, air, rail),
 * and there are four of them because that is how many the rate cards, the pincode master
 * and the engine are built around. A *service* is something sold — "Surface Express",
 * "Air Console" — and there can be as many as commercial wants, because a service is a
 * mode plus a multiplier plus a promise about transit.
 *
 * That is not a new idea here. `nfo` has always been exactly this: air, priced at twice
 * the rate. And the quote response has carried `serviceMult` and `serviceMultName` since
 * it was written, sitting at 1 because nothing yet varied them.
 *
 * So services are editable and modes are not, and the reason is honest rather than
 * arbitrary: adding a service is arithmetic on an existing tariff, while adding a mode
 * would need a rate grid on every card and a zone on all 19,494 pincodes.
 */

export interface Service {
  /** Stable code, used in APIs and on invoices. */
  key: string;
  name: string;
  /** The physical network this rides. */
  mode: StoredMode;
  active: boolean;
  /**
   * Multiplier on the freight of the underlying mode.
   *
   * 1 is the mode's own rate. NFO is air at 2. A discount service is below 1. Applies to
   * freight only — never to tax, and never to statutory charges.
   */
  multiplier: number;
  /**
   * Days added to (or taken off) the mode's transit.
   *
   * An express service is not merely dearer; it arrives sooner, and a quote that says
   * otherwise is wrong in the way customers notice.
   */
  transitAdjustmentDays?: number;
  /** Overrides the mode's SAC when this service is taxed differently. */
  sacCode?: string;
  /** Overrides the mode's GST rate, as a fraction. Road is GTA at 5%, air 18%. */
  gstRate?: number;
  description?: string;
  /** Shown to a customer choosing between services. */
  features?: string[];
}

/**
 * The services that exist without anybody configuring one.
 *
 * These reproduce today's behaviour exactly — four modes, NFO at twice air — so a system
 * with no service records prices precisely as it did before this file existed.
 */
export const BUILT_IN_SERVICES: Service[] = [
  {
    key: 'surface',
    name: 'Surface',
    mode: 'surface',
    active: true,
    multiplier: 1,
    description: 'Road, the standard service.',
    features: ['Door to door', 'Surface network'],
  },
  {
    key: 'air',
    name: 'Air',
    mode: 'air',
    active: true,
    multiplier: 1,
    description: 'Air, for time-sensitive freight.',
    features: ['Door to door', 'Air network'],
  },
  {
    key: 'rail',
    name: 'Rail',
    mode: 'rail',
    active: true,
    multiplier: 1,
    description: 'Rail, where the lane is served.',
    features: ['Door to door', 'Rail network'],
  },
  {
    key: 'nfo',
    name: 'Next flight out',
    mode: 'air',
    active: true,
    // Exactly what the engine already does for nfo. Written down rather than hidden.
    multiplier: 2,
    transitAdjustmentDays: -1,
    description: 'Next flight out.',
    features: ['Door to door', 'Next available flight'],
  },
];

/**
 * The name a service goes by on the API.
 *
 * The four networks answer under the names the core has always sent — `ECONOMY`,
 * `EXPRESS`, `CRITICAL`, `RAIL` — because callers are installed against them and the
 * contract is append-only. Anything configured afterwards answers under its own key,
 * upper-cased, which is a name nobody is yet using and so cannot collide.
 *
 * Deliberately not stored on the service record. A tier name is how this service is
 * addressed from outside, and letting somebody type one into a form is how two services
 * end up claiming `EXPRESS` and the second silently stops being reachable.
 */
const API_TIER_NAMES: Record<string, string> = {
  surface: 'ECONOMY',
  air: 'EXPRESS',
  nfo: 'CRITICAL',
  rail: 'RAIL',
};

export function apiTierName(service: Pick<Service, 'key'>): string {
  return API_TIER_NAMES[service.key] ?? service.key.toUpperCase();
}

/**
 * The four names the networks answer under, which nothing else may claim.
 *
 * A service keyed `express` would derive `EXPRESS` and shadow air on the API — the caller
 * would ask for the tier it has always asked for and get a different price. Refused when
 * the service is saved, which is the only place it can be refused usefully.
 */
const RESERVED_API_NAMES = new Set(Object.values(API_TIER_NAMES));

export function apiNameIsTaken(key: string): boolean {
  const normalised = key.trim().toLowerCase();
  if (normalised in API_TIER_NAMES) return false; // it *is* that network
  return RESERVED_API_NAMES.has(normalised.toUpperCase());
}

/** A service definition must not price something the engine cannot carry. */
export function serviceIsValid(service: Service): string | null {
  if (service.key.trim() === '') return 'A service needs a key.';
  if (!(STORED_MODES as readonly string[]).includes(service.mode)) {
    return `${service.mode} is not a network this service prices. Choose ${STORED_MODES.join(', ')}.`;
  }
  if (!Number.isFinite(service.multiplier) || service.multiplier <= 0) {
    // Zero would quote free freight; negative would pay the customer to ship.
    return 'The multiplier must be greater than zero.';
  }
  if (service.gstRate !== undefined && (service.gstRate < 0 || service.gstRate > 1)) {
    return 'The GST rate is a fraction — 0.05 for 5%.';
  }
  if (apiNameIsTaken(service.key)) {
    return `${service.key.trim().toUpperCase()} is the name one of the four networks answers under on the API. Choose another key.`;
  }
  if (service.name.trim() === '') return 'A service needs a name.';
  return null;
}

/**
 * The service a legacy `Mode` value means.
 *
 * Every mode name is also a service key, so callers that still send `surface` or `nfo`
 * keep working exactly as before. This is what lets services be added without anything
 * already deployed having to change.
 */
export function serviceForMode(mode: Mode, services: readonly Service[]): Service | null {
  return services.find((service) => service.key === mode) ?? null;
}

/** Freight after the service's multiplier. Tax is applied to the result, never multiplied. */
export function applyServiceMultiplier(freight: number, service: Service): number {
  return Math.round(freight * service.multiplier * 100) / 100;
}

/** Transit the customer is promised, after the service's adjustment. Never below one day. */
export function serviceTransitDays(
  modeTransitDays: number | null,
  /** Anything carrying the adjustment — a full record, or the rules handed to the engine. */
  service?: Pick<Service, 'transitAdjustmentDays'>,
): number | null {
  if (modeTransitDays === null) return null;
  return Math.max(1, modeTransitDays + (service?.transitAdjustmentDays ?? 0));
}

/** What the engine needs to price through a service. */
export interface ServiceRules {
  key: string;
  mode: StoredMode;
  multiplier: number;
  transitAdjustmentDays?: number;
  sacCode?: string;
  gstRate?: number;
}

export function serviceRules(service: Service): ServiceRules {
  return {
    key: service.key,
    mode: service.mode,
    multiplier: service.multiplier,
    ...(service.transitAdjustmentDays === undefined
      ? {}
      : { transitAdjustmentDays: service.transitAdjustmentDays }),
    ...(service.sacCode === undefined ? {} : { sacCode: service.sacCode }),
    ...(service.gstRate === undefined ? {} : { gstRate: service.gstRate }),
  };
}

/** One quotable service, as the API offers it. */
export interface ServiceTier {
  /** The name the caller asks for and reads back. */
  api: string;
  /** Which mode's grid prices it. `nfo` keeps its own name so the engine's rule still applies. */
  mode: Mode;
  service: Service;
  description: string;
  features: string[];
}

/**
 * The services on offer, in the order a caller should see them.
 *
 * Inactive services are left out entirely rather than returned as unavailable: an inactive
 * service is one commercial has withdrawn, and offering a price for it — even a refused
 * one — invites somebody to ask why they cannot book it.
 *
 * The four networks come first and in their established order, so a caller reading only
 * the first three keeps getting exactly what it did before any service was configured.
 */
export function serviceTiers(services: readonly Service[]): ServiceTier[] {
  const tier = (service: Service): ServiceTier => ({
    api: apiTierName(service),
    // A built-in prices as its own mode — `nfo` included, so the card's own nfoMultiplier
    // still governs it rather than a multiplier copied onto the record.
    mode: (service.key === 'nfo' ? 'nfo' : service.mode) as Mode,
    service,
    description: service.description ?? `${service.name}.`,
    features: service.features ?? [],
  });

  const active = services.filter((service) => service.active);
  const builtIn = STORED_MODES.flatMap((mode) => {
    const found = active.find((service) => service.key === mode);
    return found ? [tier(found)] : [];
  });
  const nfo = active.find((service) => service.key === 'nfo');
  const configured = active
    .filter((service) => !BUILT_IN_SERVICES.some((built) => built.key === service.key))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Established order: surface, air, nfo, rail — which is what the core's tier list has
  // always been. Rebuilt from the registry rather than restated, so a renamed service
  // carries its new name here too.
  const order = ['surface', 'air', 'nfo', 'rail'];
  const networks = [...builtIn, ...(nfo ? [tier(nfo)] : [])].sort(
    (a, b) => order.indexOf(a.service.key) - order.indexOf(b.service.key),
  );

  // A configured service whose name would collide is dropped rather than emitted twice.
  // Saving one is refused, so this only fires on a record that predates that check — and
  // two tiers under one name is worse than a missing one, because a caller reads the first.
  const taken = new Set(networks.map((entry) => entry.api));
  return [
    ...networks,
    ...configured.map(tier).filter((entry) => {
      if (taken.has(entry.api)) return false;
      taken.add(entry.api);
      return true;
    }),
  ];
}
