import type { Mode, Pincode, RateCard, StoredMode, Grid, ModeGrids } from '../domain/types';
import { GRID_NAMES } from '../domain/types';
import { computeFreightPaise, applicableTierRate, type LaneRates } from './freight';
import { add, subtract, toPaise, toRupees, ZERO, type Paise } from './money';
import { chargeableWeight, railChargeableWeight, volumetricWeight } from './weight';
import { odaSurchargePaise } from './edl';
import { settle, type ResolvedCharge,
  chargeInRupees,
  type QuotedCharge,
} from './settlement';
import { marginFor, type CostBasis, type Margin } from './margin';
import { chargesFrom, fuelBaseFrom, taxOverridesFrom } from './card-config';
import { gridLaneProvenance, resolveLaneRule, type LaneProvenance } from '../domain/lane-rules';
import { rulesFrom, type StoredLaneRule } from '../domain/lane-rule-store';
import { resolveOffers, type Offer } from '../domain/offers';
import type { ModeTaxProfile } from '../domain/tax';
import type { Overrides } from '../domain/customers';

export interface QuoteInput {
  mode: Mode;
  actualWeight: number;
  length?: number;
  breadth?: number;
  height?: number;
  pieces?: number;
  /** Rail only: a single package at or above the threshold is billed at 2x weight. */
  singlePackageOver100kg?: boolean;
}

export interface Endpoints {
  origin: Pincode | null;
  destination: Pincode | null;
}

/**
 * Whether GST belongs on this quote.
 *
 * Under reverse charge the customer accounts for the GST themselves, so adding it
 * here would overstate the price. Some customers (SEZ, export) are outside GST
 * altogether. Both change the total, which is why the pricing engine has to know
 * rather than leaving it to an invoice later.
 */
export interface BillingContext {
  billingType: 'FORWARD' | 'RCM';
  gstApplicable: boolean;
}

export interface Breakdown {
  originZone: string;
  destinationZone: string;
  originEdlKm: number;
  destinationEdlKm: number;
  volumetricWeight: number;
  chargeableWeight: number;
  transitDays: number | null;
  /** The four rates read off the lane, after any NFO multiplier. */
  rates: LaneRates;
  /**
   * Which rule priced this lane and which layer supplied it. With one lane shape there
   * was one cell to look at; the answer stops being obvious as soon as there are more.
   */
  laneProvenance: LaneProvenance;
  /** The single rate Models 2 and 3 selected; null for Model 1, which blends tiers. */
  applicableRate: number | null;
  freight: number;
  pickup: number;
  pickupOda: number;
  delivery: number;
  deliveryOda: number;
  fuel: number;
  /** What the fuel percentage was charged on, in words, for the quote to show. */
  fuelBaseDescription: string;
  /** The docket line, kept for continuity; it is also the first entry in `charges`. */
  docket: number;
  /** Every ancillary charge that applied, each with its own fuel and GST treatment. */
  charges: QuotedCharge[];
  chargesTotal: number;
  subTotal: number;
  /** The mode's GST treatment: rate, SAC, reverse charge, input tax credit. */
  tax: ModeTaxProfile;
  gst: number;
  /** Set only when GST was deliberately not charged, saying why. */
  gstNote?: string;
  total: number;
  /** Present only when the card carries a buy tariff for the lane. */
  margin?: Margin;
  /**
   * The offer that changed this quote, if one did.
   *
   * An offer is never written into a contract, so a quote it touched is the only place it
   * can be seen. `freightBeforeOffer` is what would have been charged, kept beside the
   * discount rather than derived from it — a person checking an invoice should not have
   * to reverse a percentage to find out what the price was.
   */
  offer?: {
    name: string;
    key: string;
    kind: string;
    discount: number;
    freightBeforeOffer: number;
    /** Charge ids removed by a waiver, each with the offer that removed it. */
    waived: { chargeId: string; offerName: string }[];
  };
}

export type UnavailableReason =
  | 'unknown-origin-pincode'
  | 'unknown-destination-pincode'
  | 'lane-not-served';

export type QuoteResult =
  | { available: true; breakdown: Breakdown; warnings: string[] }
  | { available: false; reason: UnavailableReason; message: string };

/** Air and NFO quote over the air network; surface and rail over the clusters. */
function storedModeFor(mode: Mode): StoredMode {
  return mode === 'nfo' ? 'air' : mode;
}

function rateAt(grid: Grid, origin: string, destination: string): number | null {
  return grid[origin]?.[destination] ?? null;
}

/** NFO is the air card multiplied through; it is not stored separately. */
function laneRates(grids: ModeGrids, origin: string, destination: string, multiplier: number): LaneRates {
  const [minCharge, tier1, tier2, tier3] = GRID_NAMES.map((name) => {
    const value = rateAt(grids[name], origin, destination);
    return value === null ? null : value * multiplier;
  });
  return { minCharge: minCharge ?? null, tier1: tier1 ?? null, tier2: tier2 ?? null, tier3: tier3 ?? null };
}

/** NFO is the air card multiplied through, and a rule's rates are multiplied the same way. */
function scale(value: number | null, multiplier: number): number | null {
  return value === null ? null : value * multiplier;
}

/** The buy tariff for one lane, when the card carries one. */
function costFor(
  card: RateCard,
  storedMode: StoredMode,
  origin: string,
  destination: string,
  rules: ModeRules,
): CostBasis | null {
  const cost = card.data.cost;
  if (!cost) return null;
  const grids = cost.grids[storedMode];
  if (!grids) return null;
  return {
    carrier: cost.carrier,
    method: cost.method,
    minWeight: rules.minWeight,
    rates: laneRates(grids, origin, destination, rules.multiplier),
  };
}

interface ModeRules {
  minWeight: number;
  volumetricDivisor: number;
  fuel: number;
  gst: number;
  pickupKey: 'pickupAir' | 'pickupSurface';
  deliveryKey: 'deliveryAir' | 'deliverySurface';
  multiplier: number;
}

function rulesFor(mode: Mode, card: RateCard): ModeRules {
  const c = card.data.charges;
  // NFO is quoted on the air card, so it takes air's weight rules with it. Rail may state
  // its own; where it does not it falls back to surface, which is what the workbooks did.
  const isAirLike = mode === 'air' || mode === 'nfo';
  const railMinWeight = mode === 'rail' ? c.minWeightRail : undefined;
  // A divisor of zero is never a rule, it is an empty field — and dividing by it would
  // make every rail shipment weigh infinity. Zero falls back the same as absent.
  const railDivisor =
    mode === 'rail' && c.volumetricDivisorRail ? c.volumetricDivisorRail : undefined;
  return {
    minWeight: isAirLike ? c.minWeightAir : (railMinWeight ?? c.minWeightSurface),
    volumetricDivisor: isAirLike
      ? c.volumetricDivisorAir
      : (railDivisor ?? c.volumetricDivisorSurface),
    fuel: mode === 'rail' ? c.fuelRail : isAirLike ? c.fuelAir : c.fuelSurface,
    gst: isAirLike ? c.gstAir : c.gstSurface,
    pickupKey: isAirLike ? 'pickupAir' : 'pickupSurface',
    deliveryKey: isAirLike ? 'deliveryAir' : 'deliverySurface',
    multiplier: mode === 'nfo' ? c.nfoMultiplier : 1,
  };
}

/**
 * Price one shipment against one rate card.
 *
 * Charge order, which the source workbook states explicitly and which matters
 * because fuel is levied on the accessorials as well as the freight:
 *
 *   freight -> pickup -> pickup ODA -> delivery -> delivery ODA
 *           -> fuel (on all of the above) -> docket -> sub-total -> GST -> total
 *
 * `overrides` is the contract's own cell map, and it is read only to say which layer
 * supplied the lane. Applying a contract folds its cells into a plain card, so the card
 * arriving here already carries the negotiated numbers; without the map the quote would
 * price identically but could not tell anyone why.
 *
 * `contractRules` is different: it does move prices. A rule is not a cell on the base
 * card, so there is nothing for it to override and nothing to fold in — it has to be
 * passed and resolved. Contract rules are considered as a complete set before the base
 * card is consulted, so a standard rule added later can never displace a negotiated one.
 */
export function quote(
  input: QuoteInput,
  endpoints: Endpoints,
  card: RateCard,
  billing?: BillingContext,
  overrides?: Overrides,
  contractRules?: Record<string, StoredLaneRule>,
  /**
   * Offers already narrowed to this customer and this moment.
   *
   * Resolved by the caller rather than here, because whether an offer reaches somebody
   * depends on their product and their tags — customer facts, which the pricing engine
   * has never needed to know and should not start knowing now.
   */
  offers?: readonly Offer[],
): QuoteResult {
  const { origin, destination } = endpoints;
  if (!origin) {
    return {
      available: false,
      reason: 'unknown-origin-pincode',
      message: 'The origin pincode is not in the pincode master.',
    };
  }
  if (!destination) {
    return {
      available: false,
      reason: 'unknown-destination-pincode',
      message: 'The destination pincode is not in the pincode master.',
    };
  }

  const { mode } = input;
  const storedMode = storedModeFor(mode);
  const rules = rulesFor(mode, card);
  const originInfo = origin[storedMode];
  const destInfo = destination[storedMode];

  // A rule prices the lane when one matches; otherwise the zone x zone grid does, which
  // is what every card did before rules existed. The grid is itself the zone-to-zone
  // case, so this is a fallback in storage only, not in meaning — and a card carrying no
  // rules takes the second branch every time, which is why no verified number moves.
  const resolution = resolveLaneRule(
    [
      ...rulesFrom(card.data.laneRules, 'base'),
      ...(contractRules === undefined ? [] : rulesFrom(contractRules, 'contract')),
    ],
    { mode: storedMode, origin, destination },
  );

  const rates: LaneRates = resolution
    ? {
        minCharge: scale(resolution.rule.rates.minCharge, rules.multiplier),
        tier1: scale(resolution.rule.rates.tier1, rules.multiplier),
        tier2: scale(resolution.rule.rates.tier2, rules.multiplier),
        tier3: scale(resolution.rule.rates.tier3, rules.multiplier),
      }
    : laneRates(card.data.grids[storedMode], originInfo.zone, destInfo.zone, rules.multiplier);

  const weight =
    mode === 'rail'
      ? railChargeableWeight(input, rules, {
          singlePackage: input.singlePackageOver100kg ?? false,
          threshold: card.data.charges.railHeavyPackageThreshold,
          multiplier: card.data.charges.railHeavyPackageMultiplier,
        })
      : chargeableWeight(input, rules);

  const rawFreight = computeFreightPaise(card.freightMethod, weight, rules.minWeight, rates);
  if (rawFreight === null) {
    return {
      available: false,
      reason: 'lane-not-served',
      message: `${mode} does not serve ${originInfo.zone} to ${destInfo.zone}.`,
    };
  }
  const listFreight = rawFreight;

  // An offer adjusts the price on its way out; it never touches what is stored. Applied
  // before settlement on purpose — fuel is a percentage of freight, so a discount that
  // landed after fuel would leave the customer paying fuel on money they did not spend.
  const resolvedOffers = offers && offers.length > 0 ? resolveOffers(offers, listFreight) : null;
  const freight = resolvedOffers ? subtract(listFreight, resolvedOffers.discount) : listFreight;
  const waived = new Set(resolvedOffers?.waivers.map((waiver) => waiver.chargeId) ?? []);

  const sameZone = originInfo.zone === destInfo.zone;
  const pickup = sameZone
    ? ZERO
    : toPaise(card.data.pickupDelivery[originInfo.zone]?.[rules.pickupKey] ?? 0);
  const delivery = sameZone
    ? ZERO
    : toPaise(card.data.pickupDelivery[destInfo.zone]?.[rules.deliveryKey] ?? 0);
  const pickupOda = odaSurchargePaise(originInfo.edlKm, weight, card.data.edlMatrix);
  const deliveryOda = odaSurchargePaise(destInfo.edlKm, weight, card.data.edlMatrix);

  // Everything from fuel onwards is settlement: which components fuel rides on, which
  // charges apply, and how the mode is taxed. `settle` owns that order.
  const settlement = settle({
    freight,
    mode,
    pickup,
    delivery,
    oda: add(pickupOda, deliveryOda),
    destinationZone: destInfo.zone,
    chargeableWeight: weight,
    fuelRate: rules.fuel,
    fuelBase: fuelBaseFrom(card.data),
    charges: chargesFrom(card.data).filter((charge) => !waived.has(charge.id)),
    taxOverrides: taxOverridesFrom(mode, card.data, rules.gst),
    ...(billing === undefined ? {} : { gstApplicable: billing.gstApplicable }),
    ...(billing?.billingType === 'RCM' ? { forceRcm: true } : {}),
  });

  const cost = costFor(card, storedMode, originInfo.zone, destInfo.zone, rules);
  // Margin reads the discounted freight, because that is the money that arrives. An offer
  // that turns a thin lane into a loss-making one should say so while it is running.
  const margin = cost
    ? marginFor({ sellFreightPaise: freight, cost, chargeableWeight: weight })
    : null;

  const warnings: string[] = [];
  if (margin?.loss) {
    warnings.push(
      `This lane sells for ₹${margin.sell} against a ${margin.carrier} cost of ` +
        `₹${margin.buy} — a loss of ₹${Math.abs(margin.profit)}.`,
    );
  } else if (margin?.thin) {
    const pct = margin.ratio === null ? '-' : `${(margin.ratio * 100).toFixed(1)}%`;
    warnings.push(
      `Thin margin: ${pct} on freight against the ${margin.carrier} cost of ₹${margin.buy}.`,
    );
  }
  if (!originInfo.serviceable) {
    warnings.push(`Origin pincode ${origin.pincode} is marked not serviceable by ${mode}.`);
  }
  if (!destInfo.serviceable) {
    warnings.push(`Destination pincode ${destination.pincode} is marked not serviceable by ${mode}.`);
  }

  return {
    available: true,
    warnings,
    breakdown: {
      originZone: originInfo.zone,
      destinationZone: destInfo.zone,
      originEdlKm: originInfo.edlKm,
      destinationEdlKm: destInfo.edlKm,
      volumetricWeight: volumetricWeight(input, rules),
      chargeableWeight: weight,
      transitDays: card.data.transitTimes[storedMode][originInfo.zone]?.[destInfo.zone] ?? null,
      rates,
      // A rule already knows its own trace and layer. Only the grid path needs the
      // override map, because a folded contract card is indistinguishable from a base one.
      laneProvenance: resolution
        ? { layer: resolution.rule.layer, negotiated: [], trace: resolution.trace }
        : gridLaneProvenance({
            mode: storedMode,
            originZone: originInfo.zone,
            destinationZone: destInfo.zone,
            ...(overrides === undefined ? {} : { overrides }),
          }),
      applicableRate:
        card.freightMethod === 'CUMULATIVE_SLABS' ? null : applicableTierRate(weight, rates),
      // The boundary. Everything above this line is integer paise; everything the caller
      // sees is rupees, converted once, here. The API contract did not change.
      freight: toRupees(freight),
      ...(resolvedOffers && (resolvedOffers.freightOffer || resolvedOffers.waivers.length > 0)
        ? {
            offer: {
              name: resolvedOffers.freightOffer?.name ?? resolvedOffers.waivers[0]?.offer.name ?? '',
              key: resolvedOffers.freightOffer?.key ?? resolvedOffers.waivers[0]?.offer.key ?? '',
              kind: resolvedOffers.freightOffer?.kind ?? 'waive-charge',
              discount: toRupees(resolvedOffers.discount),
              freightBeforeOffer: toRupees(listFreight),
              waived: resolvedOffers.waivers.map((waiver) => ({
                chargeId: waiver.chargeId,
                offerName: waiver.offer.name,
              })),
            },
          }
        : {}),
      pickup: toRupees(pickup),
      pickupOda: toRupees(pickupOda),
      delivery: toRupees(delivery),
      deliveryOda: toRupees(deliveryOda),
      fuel: toRupees(settlement.fuel),
      fuelBaseDescription: settlement.fuelBaseDescription,
      docket: toRupees(
        settlement.charges.find((charge) => charge.id === 'docket')?.amount ?? ZERO,
      ),
      charges: settlement.charges.map(chargeInRupees),
      chargesTotal: toRupees(settlement.chargesTotal),
      subTotal: toRupees(settlement.taxableValue),
      tax: settlement.tax,
      gst: toRupees(settlement.gst),
      ...(settlement.gstNote === undefined ? {} : { gstNote: settlement.gstNote }),
      total: toRupees(settlement.total),
      ...(margin === null ? {} : { margin }),
    },
  };
}
