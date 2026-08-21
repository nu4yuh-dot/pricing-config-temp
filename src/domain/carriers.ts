/**
 * Carriers — the companies that actually move the freight.
 *
 * Until now a carrier was a TypeScript union: `dns | bluedart | ups`. Adding one meant a
 * release, which is the wrong shape for a commercial fact — carriers are signed and
 * dropped by the business, not by a deploy.
 *
 * So a carrier is a row. What still needs code is only a carrier that prices by a question
 * we cannot already ask: Bluedart quotes by *directional zone* and UPS by *country and
 * product*, and neither is a zone-by-weight lookup. A carrier that does price by zone and
 * weight — most of them — needs nothing but this record and a rate card pointing at it.
 *
 * That distinction is what `rateStructure` records. It is not a preference; it is a
 * statement about whether an engine exists for this carrier's tariff.
 */

/**
 * How a carrier's tariff is shaped, and therefore which engine prices it.
 *
 * `zoneWeight` is the ordinary case and needs no code. The others name engines that exist.
 * A carrier whose tariff fits none of these cannot be priced yet, and saying so out loud
 * is better than quoting it wrong.
 */
export const RATE_STRUCTURES = [
  'zoneWeight',
  'directionalZone',
  'countryProduct',
  'unsupported',
] as const;
export type RateStructure = (typeof RATE_STRUCTURES)[number];

export const RATE_STRUCTURE_LABELS: Record<RateStructure, string> = {
  zoneWeight: 'Zone × weight — priced by the standard engine',
  directionalZone: 'Directional zones — the Bluedart engine',
  countryProduct: 'Country × product — the UPS / MOVIN engine',
  unsupported: 'Not yet priceable — no engine for this tariff',
};

export interface CarrierSla {
  /** The service this promise is about, e.g. `surface`. */
  service: string;
  /** Committed transit, in days. */
  days: number;
}

export interface Carrier {
  /** Short stable code. Appears on dockets and in the core's `carrierAccess`. */
  carrierId: string;
  name: string;
  active: boolean;
  rateStructure: RateStructure;
  /**
   * The rate cards this carrier is priced from.
   *
   * A carrier with none is known but not yet priceable — a real state while a tariff is
   * being loaded, and a different one from being inactive.
   */
  cardKeys: string[];
  contactEmail?: string;
  contactPhone?: string;
  /** Last pickup, as the carrier states it. Free text: "17:30 IST", "18:00 weekdays". */
  cutoffTime?: string;
  /** Refuses a consignment above this. Zero or absent means no stated limit. */
  maxWeightKg?: number;
  /** Whether they will carry dangerous goods. */
  dgCertified?: boolean;
  /** `{awb}` is replaced with the tracking number. */
  trackingUrlTemplate?: string;
  /**
   * A blanket multiplier on this carrier's freight.
   *
   * For a negotiated across-the-board move — a 4% rise — without reissuing a tariff.
   * Applies to freight only, never to taxes or statutory charges, because a multiplier on
   * GST would be inventing tax.
   */
  rateMultiplier?: number;
  slas?: CarrierSla[];
  notes?: string;
}

/** Nothing to price against, so nothing can be quoted. */
export function isPriceable(carrier: Carrier): boolean {
  return carrier.active && carrier.rateStructure !== 'unsupported' && carrier.cardKeys.length > 0;
}

/**
 * Why a carrier cannot be quoted, in words for whoever is looking at the screen.
 *
 * Returns null when it can. Three different reasons, because "no rate" and "switched off"
 * and "we have no engine for this tariff" need three different actions from three
 * different people.
 */
export function unpriceableReason(carrier: Carrier): string | null {
  if (!carrier.active) return `${carrier.name} is switched off.`;
  if (carrier.rateStructure === 'unsupported') {
    return `${carrier.name} prices by a tariff this service cannot read yet.`;
  }
  if (carrier.cardKeys.length === 0) return `${carrier.name} has no rate card loaded.`;
  return null;
}

/** Freight after the carrier's blanket multiplier. Taxes are never multiplied. */
export function applyCarrierMultiplier(freight: number, carrier: Carrier): number {
  const multiplier = carrier.rateMultiplier ?? 1;
  return Math.round(freight * multiplier * 100) / 100;
}
