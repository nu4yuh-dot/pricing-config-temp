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
  service: Service,
): number | null {
  if (modeTransitDays === null) return null;
  return Math.max(1, modeTransitDays + (service.transitAdjustmentDays ?? 0));
}
