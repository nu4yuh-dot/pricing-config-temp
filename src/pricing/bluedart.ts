import {
  addMicro,
  maxMicro,
  microPerKg,
  microRateOf,
  microTimes,
  microToRupees,
  toGrams,
  toMicro,
  ZERO_MICRO,
  type Micro,
} from './money';
import {
  FULL_CHARGE_SERVICES,
  MIN_CHARGE,
  MIN_WEIGHT,
  PER_500G_SERVICES,
  SLAB_100,
  SLAB_25,
  SLAB_50,
  isApexServiceable,
  isOdaStatus,
  type BluedartCardData,
  type BluedartOdaMatrix,
  type BluedartPincodeInfo,
  type BluedartService,
  type SlabRates,
} from '../domain/bluedart';

/**
 * Pricing the Bluedart franchise card.
 *
 * Separate from `quote()` because almost nothing is shared: the price depends on the
 * destination zone alone rather than a lane, the slab boundaries are the service's own,
 * and two of the four services are billed per 500 g against a floor.
 *
 * **Arithmetic is deliberately unrounded to the paisa.** The source workbook rounds nothing
 * — its own GST on a 30 kg surface shipment comes to ₹177.998058 — and the 127 golden
 * fixtures are what that workbook computes. Rounding to paise here would put this engine a
 * fraction away from the document the business quotes from. Money is rounded once, at the
 * point it becomes a ledger entry, by `billing/ledger.ts`.
 *
 * It is still integers. Amounts here are millionths of a rupee, which holds every one of
 * those 127 values exactly and keeps the workbook's precision without a float anywhere.
 * This used to imitate Excel's 15-significant-digit cell limit instead, because in raw
 * IEEE-754 the same sum reached in a different order came out differently
 * (1786.7654400000001 against 1786.76544). Integers do not care about the order, so that
 * imitation is gone rather than tuned.
 */

export interface BluedartQuoteInput {
  service: BluedartService;
  actualWeight: number;
  /** Declared value, for FOV. Zero still attracts the FOV minimum. */
  declaredValue?: number;
  length?: number;
  breadth?: number;
  height?: number;
  pieces?: number;
}

export interface BluedartBreakdown {
  zone: string;
  service: BluedartService;
  odaStatus: string;
  edlKm: number;
  volumetricWeight: number;
  chargeableWeight: number;
  freight: number;
  oda: number;
  fuel: number;
  /** The percentage actually applied, so a quote can say which one it used. */
  fuelRate: number;
  awb: number;
  fov: number;
  subTotal: number;
  gst: number;
  gstRate: number;
  sac: string;
  total: number;
}

export type BluedartUnavailableReason =
  | 'unknown-pincode'
  | 'unknown-zone'
  | 'apex-not-serviceable';

export type BluedartQuoteResult =
  | { available: true; breakdown: BluedartBreakdown; warnings: string[] }
  | { available: false; reason: BluedartUnavailableReason; message: string };

/**
 * Volumetric weight.
 *
 * The rate card states it — air and DUTS at L×W×H/5000, surface as (L×W×H/27000)×8 —
 * but the workbook's own calculator has no dimension inputs at all, so it silently
 * under-charges light bulky freight. This applies the stated rule.
 */
export function bluedartVolumetricWeight(
  input: BluedartQuoteInput,
  charges: BluedartCardData['charges'],
): number {
  const length = input.length ?? 0;
  const breadth = input.breadth ?? 0;
  const height = input.height ?? 0;
  const pieces = input.pieces ?? 1;
  if (length <= 0 || breadth <= 0 || height <= 0) return 0;

  const volume = length * breadth * height * pieces;
  const weight =
    input.service === 'SURFACE'
      ? (volume / charges.volumetricDivisorSurface) * charges.volumetricMultiplierSurface
      : volume / charges.volumetricDivisorAir;

  // To the gram. The division recurs — 60x50x40 surface gives 35.5555... kg — and carrying
  // that into a per-kg rate puts float noise in the price (₹517.500000000001). A gram is far
  // finer than any carrier bills to, so nothing real is lost.
  return Math.round(weight * 1000) / 1000;
}

/** The greater of actual and volumetric, never below the service's floor. */
export function bluedartChargeableWeight(
  input: BluedartQuoteInput,
  charges: BluedartCardData['charges'],
): number {
  const volumetric = bluedartVolumetricWeight(input, charges);
  return Math.max(input.actualWeight, volumetric, MIN_WEIGHT[input.service]);
}

/**
 * Freight for the slab services.
 *
 * Incremental: the first block covers everything up to the minimum weight, then each band's
 * rate applies only to the kilograms inside that band, and the bands are added. A heavier
 * shipment therefore always costs more — unlike the DNS decremental cards, where crossing
 * a boundary can make one more kilogram cheaper.
 */
export function slabFreight(rates: SlabRates, chargeableWeight: number, firstBlockTo: number): number {
  return microToRupees(slabFreightMicro(rates, chargeableWeight, firstBlockTo));
}

/**
 * The same freight, in millionths of a rupee.
 *
 * Band widths are taken in grams so that `min(weight, 25) - 25` cannot come out as
 * -3.55e-15, and each band's product is exact, so the bands are summed with nothing
 * rounded in between — which is what the workbook does.
 */
export function slabFreightMicro(
  rates: SlabRates,
  chargeableWeight: number,
  firstBlockTo: number,
): Micro {
  const g = toGrams(chargeableWeight);
  const band = (fromKg: number, toKg: number | null): number => {
    const upper = toKg === null ? g : Math.min(g, toGrams(toKg));
    return Math.max(0, upper - toGrams(fromKg));
  };
  // A band width is in grams, and a rate is per kilogram, so the product is scaled back
  // down by a thousand — exactly, because the rate in micro-rupees is a multiple of it.
  const perGram = (rateRupees: number, grams: number): Micro =>
    microPerKg(toMicro(rateRupees), grams);

  return addMicro(
    toMicro(rates.firstBlock),
    perGram(rates.to25, band(firstBlockTo, SLAB_25)),
    perGram(rates.to50, band(SLAB_25, SLAB_50)),
    perGram(rates.to100, band(SLAB_50, SLAB_100)),
    perGram(rates.above100, band(SLAB_100, null)),
  );
}

/** Freight for the per-500 g services: rounded up to the next half kilo, against a floor. */
export function per500gFreight(ratePer500g: number, chargeableWeight: number, minimum: number): number {
  return microToRupees(per500gFreightMicro(ratePer500g, chargeableWeight, minimum));
}

export function per500gFreightMicro(
  ratePer500g: number,
  chargeableWeight: number,
  minimum: number,
): Micro {
  // Half-kilo blocks, counted in grams so the division is integer: 1.5 kg is exactly three
  // blocks, where 1.5 / 0.5 in binary can land a hair under three and round down to two.
  const halves = Math.ceil(toGrams(chargeableWeight) / 500);
  return maxMicro(toMicro(minimum), microTimes(toMicro(ratePer500g), halves));
}

/**
 * The ODA surcharge.
 *
 * Three paths, in the order the workbook applies them: beyond the last distance band a
 * per-km rate replaces the matrix entirely; an ODA pincode inside the bands reads the
 * matrix; anything else is nil. Documents never carry ODA at all.
 */
export function bluedartOda(
  service: BluedartService,
  info: BluedartPincodeInfo,
  chargeableWeight: number,
  matrix: BluedartOdaMatrix,
): number {
  if (PER_500G_SERVICES.includes(service)) return 0;

  if (info.edlKm > matrix.perKmThreshold) {
    return Math.round(info.edlKm * matrix.perKmBeyond);
  }
  if (!isOdaStatus(info.odaStatus)) return 0;

  const kmIndex = approximateIndex(matrix.kmBands, info.edlKm);
  // Below the first band there is no surcharge to read: the workbook's lookup fails and
  // its IFERROR yields nil, which is the same answer.
  if (kmIndex === -1) return 0;

  const weightIndex = approximateIndex(matrix.weightBands, chargeableWeight);
  if (weightIndex === -1) return 0;

  return matrix.rates[kmIndex]?.[weightIndex] ?? 0;
}

/** Excel's `MATCH(value, bands, 1)`: the largest band at or below the value. */
function approximateIndex(bands: number[], value: number): number {
  let index = -1;
  for (let i = 0; i < bands.length; i++) {
    if ((bands[i] as number) <= value) index = i;
    else break;
  }
  return index;
}

export function quoteBluedart(
  input: BluedartQuoteInput,
  destination: BluedartPincodeInfo | null,
  data: BluedartCardData,
): BluedartQuoteResult {
  if (!destination) {
    return {
      available: false,
      reason: 'unknown-pincode',
      message: 'The destination pincode is not in the pincode master.',
    };
  }

  const zoneRates = data.zones[destination.zone];
  if (!zoneRates) {
    return {
      available: false,
      reason: 'unknown-zone',
      message: `${destination.zone} is not a zone on this rate card.`,
    };
  }

  // 15 pincodes are marked not APEX-serviceable. The workbook's calculator quotes them
  // anyway; quoting a service that cannot be flown is worse than refusing.
  if (input.service === 'APEX' && !isApexServiceable(destination.odaStatus)) {
    return {
      available: false,
      reason: 'apex-not-serviceable',
      message: 'APEX does not serve this pincode. Surface is available.',
    };
  }

  const { charges } = data;
  const chargeableWeight = bluedartChargeableWeight(input, charges);
  const volumetricWeight = bluedartVolumetricWeight(input, charges);

  let freight: number;
  switch (input.service) {
    case 'DOCs':
      freight = per500gFreight(zoneRates.docs, chargeableWeight, MIN_CHARGE.DOCs);
      break;
    case 'DUTS':
      freight = per500gFreight(zoneRates.duts, chargeableWeight, MIN_CHARGE.DUTS);
      break;
    case 'APEX':
      freight = slabFreight(zoneRates.apex, chargeableWeight, MIN_WEIGHT.APEX);
      break;
    case 'SURFACE':
      freight = slabFreight(zoneRates.surface, chargeableWeight, MIN_WEIGHT.SURFACE);
      break;
  }

  const oda = bluedartOda(input.service, destination, chargeableWeight, data.oda);

  // Everything from here is integers at a millionth of a rupee. The workbook rounds
  // nothing, so neither does this — but a float sum depended on the order its terms were
  // added, and an integer sum does not.
  const freightMicro = toMicro(freight);
  const odaMicro = toMicro(oda);

  // Documents are charged air fuel on freight alone; the other two on freight plus ODA.
  const fullCharge = FULL_CHARGE_SERVICES.includes(input.service);
  const fuelRate = input.service === 'SURFACE' ? charges.fuelSurface : charges.fuelAir;
  const fuelMicro = microRateOf(
    fullCharge ? addMicro(freightMicro, odaMicro) : freightMicro,
    fuelRate,
  );

  const awbMicro = fullCharge ? toMicro(charges.awb) : ZERO_MICRO;
  const fovMicro = fullCharge
    ? maxMicro(
        microRateOf(toMicro(input.declaredValue ?? 0), charges.fovRate),
        toMicro(charges.fovMinimum),
      )
    : ZERO_MICRO;

  const subTotalMicro = addMicro(freightMicro, odaMicro, fuelMicro, awbMicro, fovMicro);
  const gstMicro = microRateOf(subTotalMicro, charges.gstRate);
  const totalMicro = addMicro(subTotalMicro, gstMicro);

  const fuel = microToRupees(fuelMicro);
  const awb = microToRupees(awbMicro);
  const fov = microToRupees(fovMicro);
  const subTotal = microToRupees(subTotalMicro);
  const gst = microToRupees(gstMicro);

  const warnings: string[] = [];
  if (PER_500G_SERVICES.includes(input.service) && chargeableWeight > 5) {
    warnings.push(
      `${input.service} is a per-500 g service intended for shipments up to 5 kg; the rate card ` +
        `moves anything heavier to APEX or SURFACE. This quote bills ${chargeableWeight} kg at the ` +
        `document rate.`,
    );
  }
  if (volumetricWeight > input.actualWeight) {
    warnings.push(
      `Billed on volumetric weight ${volumetricWeight} kg rather than the actual ${input.actualWeight} kg.`,
    );
  }

  return {
    available: true,
    warnings,
    breakdown: {
      zone: destination.zone,
      service: input.service,
      odaStatus: destination.odaStatus,
      edlKm: destination.edlKm,
      volumetricWeight,
      chargeableWeight,
      freight,
      oda,
      fuel,
      fuelRate,
      awb,
      fov,
      subTotal,
      gst,
      gstRate: charges.gstRate,
      sac: charges.sac,
      // A sum of integers, converted once. The parts on this quote add to this total
      // exactly, which is the property the float version could not promise.
      total: microToRupees(totalMicro),
    },
  };
}
