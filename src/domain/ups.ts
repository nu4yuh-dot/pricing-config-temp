/**
 * The UPS / MOVIN international export card.
 *
 * Structurally unlike every other card in this system, and the difference is the
 * destination. Everything else here prices an Indian pincode to an Indian pincode. This
 * ships **ex-Mumbai to the world**, so the destination is a *country* — and for China, a
 * postal range, because the card zones China eight ways at 3 and seven ways at 9.
 *
 * Four more things about it are its own:
 *
 *  1. **Three products.** UPS Envelope is one flat price per zone. UPS Document is priced
 *     to 5 kg, Package to 20 kg, both in half-kilo steps. Past 20 kg a Package falls into
 *     per-kilogram bands running to 1000 kg and beyond.
 *  2. **A surge fee per kilogram**, by a region of the world that is not the rate zone —
 *     Europe and "Rest of the World" are surge regions, Zone 4 and Zone 7 are rate zones,
 *     and they do not line up.
 *  3. **Fuel on freight plus surge**, at 46.75%, and not on the accessorials.
 *  4. **Accessorials with negotiated waivers.** Twenty-one of the thirty-seven are waived
 *     outright for this customer, which is most of what the agreement bought.
 *
 * Sources: `Approved Rates for DNS Express - Ex Mum - Revised (2).xlsx` for the zones and
 * the rates — it is the signed document — and `DNS_International_RateCard.xlsx` for the
 * margin, fuel, surge and GST parameters, which the contract does not state. Built by
 * `scripts/extract_ups.py`; editable in the app afterwards like any other card.
 */

export const UPS_PRODUCTS = ['envelope', 'document', 'package'] as const;
export type UpsProduct = (typeof UPS_PRODUCTS)[number];

export const UPS_PRODUCT_LABELS: Record<UpsProduct, string> = {
  envelope: 'UPS Envelope — flat',
  document: 'UPS Document — to 5 kg',
  package: 'Package — to 20 kg, then per kg',
};

export interface UpsParams {
  origin: string;
  /** Sell margin over the contracted buy rate. */
  margin: number;
  fuelRate: number;
  /** Discount off the published surge fee. */
  surgeDiscount: number;
  gstRate: number;
  volumetricDivisor: number;
  /** The floor under every chargeable weight. */
  minChargeableWeight: number;
}

/** One weight step: the rate applies to anything at or below `toKg`. */
export interface UpsWeightRow {
  toKg: number;
  rates: Record<string, number>;
}

/** A per-kilogram band, applying from `fromKg` up to the next band. */
export interface UpsBulkRow {
  fromKg: number;
  label: string;
  rates: Record<string, number>;
}

export interface UpsAccessorial {
  id: string;
  name: string;
  unit: string;
  /** Charged as the greater of this and `perKg` × chargeable weight. */
  minimum: number;
  perKg: number;
  /** 1 is fully waived, 0.5 half, 0 not waived. */
  waiver: number;
  appliesByDefault: boolean;
}

export interface UpsPostalZone {
  country: string;
  from: number;
  to: number;
  zone: string;
}

export interface UpsCardData {
  params: UpsParams;
  /** The rate grid's columns, e.g. `Z1`…`Z9`, `US`, `DE`, `Z7SP`. */
  zoneKeys: string[];
  /** Country code → rate zone. */
  zones: Record<string, string>;
  /** Overrides for countries the card splits by postal code. China, today. */
  postalZones: UpsPostalZone[];
  /** Codes the card lists with no zone at all. */
  unserved: string[];
  destinationNames: Record<string, string>;
  /** Surge region → published rupees per kg, before the discount. */
  surge: Record<string, number>;
  /** Country code → surge region. */
  surgeRegions: Record<string, string>;
  defaultSurgeRegion: string;
  rates: {
    envelope: Record<string, number>;
    document: UpsWeightRow[];
    package: UpsWeightRow[];
    bulk: UpsBulkRow[];
  };
  accessorials: UpsAccessorial[];
}

export type ZoneResolution =
  | { ok: true; zone: string; surgeRegion: string; viaPostalRange?: UpsPostalZone }
  | { ok: false; reason: 'unknown-country' | 'not-served' | 'postal-code-required' };

/**
 * Which rate zone a destination falls in.
 *
 * A country the card splits by postal code cannot be priced without one. That is a
 * refusal rather than a guess on purpose: China's ranges span Zone 3 and Zone 9, the two
 * differ by hundreds of rupees on a parcel, and picking either without knowing where the
 * shipment is going would be inventing a price.
 */
export function resolveZone(
  data: UpsCardData,
  countryCode: string,
  postalCode?: string | number,
): ZoneResolution {
  const code = countryCode.trim().toUpperCase();

  if (data.unserved.includes(code)) return { ok: false, reason: 'not-served' };

  const ranges = data.postalZones.filter((entry) => entry.country === code);
  const surgeRegion = data.surgeRegions[code] ?? data.defaultSurgeRegion;

  if (ranges.length > 0) {
    if (postalCode === undefined || String(postalCode).trim() === '') {
      return { ok: false, reason: 'postal-code-required' };
    }
    // Digits only: postal codes arrive written every way there is, and the card's ranges
    // are numeric.
    const digits = String(postalCode).replace(/\D/g, '');
    if (digits === '') return { ok: false, reason: 'postal-code-required' };
    const numeric = Number(digits);
    const hit = ranges.find((entry) => numeric >= entry.from && numeric <= entry.to);
    // A postal code inside the country but outside every published range is not priced.
    // The card enumerates the ranges it serves, and the gaps in it are deliberate.
    if (!hit) return { ok: false, reason: 'not-served' };
    return { ok: true, zone: hit.zone, surgeRegion, viaPostalRange: hit };
  }

  const zone = data.zones[code];
  if (!zone) return { ok: false, reason: 'unknown-country' };
  return { ok: true, zone, surgeRegion };
}

/**
 * The rate row for a weight, and whether that rate is per kilogram.
 *
 * At or below the last weight step the card is a lookup: round the chargeable weight up
 * to the next half kilo and read that row. Above it a Package moves onto per-kilogram
 * bands, and a Document simply stops — the contract prices documents to 5 kg and nothing
 * beyond, so anything heavier is a Package.
 */
export type RateSelection =
  | { kind: 'flat'; rate: number; step: number | null }
  | { kind: 'per-kg'; rate: number; band: string }
  | { kind: 'none'; reason: 'above-product-limit' | 'zone-not-priced' };

export function selectRate(
  data: UpsCardData,
  product: UpsProduct,
  zone: string,
  chargeableWeightKg: number,
): RateSelection {
  if (product === 'envelope') {
    const rate = data.rates.envelope[zone];
    return rate === undefined
      ? { kind: 'none', reason: 'zone-not-priced' }
      : { kind: 'flat', rate, step: null };
  }

  const steps = product === 'document' ? data.rates.document : data.rates.package;
  // Any fraction of a kilogram over the step shown takes the next higher rate — term 4 of
  // the agreement, and the calculator's CEILING(weight, 0.5).
  const rounded = Math.ceil(chargeableWeightKg * 2 - 1e-9) / 2;
  const step = steps.find((row) => row.toKg >= rounded - 1e-9);

  if (step) {
    const rate = step.rates[zone];
    return rate === undefined
      ? { kind: 'none', reason: 'zone-not-priced' }
      : { kind: 'flat', rate, step: step.toKg };
  }

  if (product === 'document') return { kind: 'none', reason: 'above-product-limit' };

  // Past the last weight step, the heaviest band whose floor the shipment reaches.
  const bands = [...data.rates.bulk].sort((a, b) => a.fromKg - b.fromKg);
  let chosen: UpsBulkRow | undefined;
  for (const band of bands) {
    if (chargeableWeightKg >= band.fromKg) chosen = band;
  }
  if (!chosen) return { kind: 'none', reason: 'above-product-limit' };

  const rate = chosen.rates[zone];
  return rate === undefined
    ? { kind: 'none', reason: 'zone-not-priced' }
    : { kind: 'per-kg', rate, band: chosen.label };
}
