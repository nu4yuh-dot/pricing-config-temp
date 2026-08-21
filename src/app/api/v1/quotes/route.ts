import { NextResponse } from 'next/server';
import { z } from 'zod';
import { QuoteRequest } from '../../../../api/contracts';
import { authenticatedJson, badRequest } from '../../_auth';
import { recordQuote, fingerprint } from '../../../../data/quotes';
import { findPincodePair } from '../../../../data/pincodes';
import { liveCard } from '../../../../data/rate-cards';
import { findCustomer, contractedCard } from '../../../../data/customers';
import { offersFor } from '../../../../data/offers';
import {
  mayUseCarrier,
  carrierRefusedMessage,
  carrierName,
  SOURCE_CARRIERS,
} from '../../../../customers/carrier-access';
import { quote } from '../../../../pricing/quote';
import { listServices, isBuiltIn } from '../../../../data/services';
import { serviceTiers, serviceRules } from '../../../../domain/services';
import { applicableTierRate } from '../../../../pricing/freight';
import type { Mode, Pincode, RateCard } from '../../../../domain/types';

/**
 * Quotes for the SameX core.
 *
 * The core is replacing its in-repo pricing engine with this service, and its brief
 * names the seam: the existing `/api/pricing/calculate` contract becomes this service's
 * public contract, largely unchanged. So this endpoint speaks *their* shape — pincodes,
 * weight, dimensions, three service tiers — rather than ours, and the mapping between
 * the two lives here rather than being pushed onto the caller.
 *
 * Their tiers are one rate multiplied by a service factor. Ours are separately
 * negotiated grids per mode, which is a better answer to the same question: an EXPRESS
 * price here is the air rate that was actually agreed, not surface with a markup on it.
 *
 *   ECONOMY  -> surface      EXPRESS -> air      CRITICAL -> nfo (next flight out)
 *
 * Rail is returned as a fourth entry. `tiers` is an array and their rule is
 * append-only, so a caller that only reads three keeps working.
 */

/**
 * The tiers are the service registry, not a list in this file.
 *
 * They were four constants, which was right while nothing varied them. Now a service is a
 * record — a network, a multiplier, its own transit and tax treatment — and the tiers
 * offered here are whichever of those are active.
 *
 * Two guarantees hold that list steady for callers already installed. The four networks
 * keep the names the core has always sent (`ECONOMY`, `EXPRESS`, `CRITICAL`, `RAIL`) and
 * keep their order, so a caller reading the first three reads exactly what it did before.
 * And anything configured is appended, under a name of its own, which their append-only
 * rule already covers: `tiers` is an array, and an unrecognised entry is ignored.
 */

/** The canonical form of a request, whichever names it arrived under. */
function canonical(input: z.infer<typeof QuoteRequest>) {
  return {
    destination: input.destinationPincode ?? input.destPincode,
    customerCode: input.customerCode ?? input.customerId,
  };
}

/**
 * The card a request prices against.
 *
 * Their contract has no notion of a rate card, so an anonymous quote needs a default.
 * It is configurable rather than hardcoded because which of the three models is "the
 * book rate" is a commercial decision, not a property of the code.
 */
const DEFAULT_CARD_KEY = process.env.PRICING_DEFAULT_CARD_KEY ?? 'model-1';

const round2 = (value: number): number => Math.round(value * 100) / 100;


/** The fuel percentage this mode carries, as a percentage rather than a fraction. */
function fuelPctFor(card: RateCard, mode: Mode): number {
  const charges = card.data.charges;
  const fraction =
    mode === 'rail'
      ? charges.fuelRail
      : mode === 'surface'
        ? charges.fuelSurface
        : charges.fuelAir;
  return round2((fraction ?? 0) * 100);
}

/** The volumetric divisor this mode bills on. Rail falls back to surface, as the engine does. */
function divisorFor(card: RateCard, mode: Mode): number {
  const charges = card.data.charges;
  if (mode === 'air' || mode === 'nfo') return charges.volumetricDivisorAir;
  if (mode === 'rail') return charges.volumetricDivisorRail ?? charges.volumetricDivisorSurface;
  return charges.volumetricDivisorSurface;
}

const modeInfo = (pincode: Pincode, mode: Mode) =>
  mode === 'air' || mode === 'nfo' ? pincode.air : mode === 'rail' ? pincode.rail : pincode.surface;

/** Their `PincodeInfo`, from ours. Fields the core owns are left empty, never invented. */
function pincodeInfo(pincode: Pincode, mode: Mode, transitDays: number | null) {
  const info = modeInfo(pincode, mode);
  return {
    pincode: String(pincode.pincode),
    locality: pincode.area,
    state: pincode.state,
    hub: info.hub,
    airport: pincode.air.hub,
    aptDistKm: pincode.air.edlKm,
    cargoHub: pincode.surface.hub,
    cargoDistKm: pincode.surface.edlKm,
    odaStatus: info.odaCategory,
    odaSlab: info.edlKm,
    zone: info.zone,
    lane: info.zone,
    deliverySla: transitDays === null ? '' : `${transitDays} day${transitDays === 1 ? '' : 's'}`,
    // Connectivity scoring is the core's: it comes from hub and network data this
    // service does not hold. Left at zero rather than guessed.
    connScore: 0,
  };
}

export async function POST(request: Request) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;
  const raw = auth.body;

  const parsed = QuoteRequest.safeParse(raw);
  if (!parsed.success) {
    return badRequest(
      'Missing or invalid fields. originPincode, destinationPincode and actualWeight are required.',
      parsed.error.flatten(),
    );
  }
  const input = parsed.data;
  const named = canonical(input);

  if (named.destination === undefined) {
    return badRequest('destinationPincode is required.');
  }

  const { origin, destination } = await findPincodePair(
    Number(input.originPincode),
    Number(named.destination),
  );
  if (!origin || !destination) {
    return NextResponse.json(
      {
        success: false,
        message: `${!origin ? 'Origin' : 'Destination'} pincode is not serviceable.`,
      },
      { status: 404 },
    );
  }

  /* ------------------------------------------------------------------ the card */

  let card: RateCard | null;
  let quotedFor: Awaited<ReturnType<typeof findCustomer>> = null;

  // Held so the quote record can say which terms priced it, not merely which customer.
  let contract: { fingerprint: string; overrides: number } | null = null;

  if (named.customerCode) {
    const customer = await findCustomer(named.customerCode);
    if (!customer) {
      return NextResponse.json(
        { success: false, message: `Unknown customer ${named.customerCode}.` },
        { status: 404 },
      );
    }
    // The contracted card is the base card with this customer's negotiated cells
    // applied, so a quote here is the price they were actually promised.
    card = await contractedCard(customer);
    quotedFor = customer;
    contract = {
      fingerprint: fingerprint(customer.liveTerms),
      overrides: Object.keys(customer.liveTerms.overrides).length,
    };
  } else {
    card = await liveCard(DEFAULT_CARD_KEY);
  }

  if (!card) {
    return NextResponse.json(
      { success: false, message: 'No rate card is available to price against.' },
      { status: 503 },
    );
  }

  /**
   * Whether this customer may be quoted the carrier whose card won.
   *
   * A customer's base card can be a partner's — Bluedart, UPS — and the core gates those
   * per account. The Bluedart, UPS and FTL endpoints each checked; this one did not, so a
   * customer sitting on a partner card was quoted it whatever their access said. Nothing
   * has walked through that yet because every customer today is on a DNS card, which is
   * never gated: it is not a partner they opt into, it is the thing they signed up for.
   *
   * Refused outright rather than falling back to the standard network. Their base card *is*
   * the partner's, so there is no other price to give — and a price nobody may book is
   * worse than none, because somebody plans around it.
   */
  /**
   * Offers that reach this customer at this moment.
   *
   * This endpoint priced without them, which meant an offer created and assigned in the
   * console changed nothing here — the console said a discount was live and the price the
   * core was quoted was the undiscounted one. `GET /api/v1/network/quotes` had always
   * applied them; this one, which is the endpoint the core actually calls, had not.
   *
   * Resolved once for the request rather than per tier: the answer depends on the customer
   * and the moment, neither of which changes between tiers, and re-reading them per tier
   * would let two tiers in one response disagree about whether an offer was live.
   */
  const offers = quotedFor
    ? await offersFor({
        at: new Date(),
        customerCode: quotedFor.code,
        ...(quotedFor.tags ? { tags: quotedFor.tags } : {}),
        ...(quotedFor.appliedProduct ? { productKey: quotedFor.appliedProduct.key } : {}),
      })
    : [];

    const carrier = SOURCE_CARRIERS[card.source ?? 'dns'] ?? card.source ?? 'dns';
  if (!mayUseCarrier(quotedFor, carrier)) {
    return NextResponse.json(
      {
        success: false,
        // Additive: a caller that reads only `message` behaves exactly as before.
        reason: 'carrier-not-enabled',
        message: carrierRefusedMessage(quotedFor!.name, carrierName(carrier)),
      },
      { status: 403 },
    );
  }

  /* ----------------------------------------------------------------- the tiers */

  const offered = serviceTiers(await listServices());

  const wanted = input.transportMode?.toUpperCase();
  // Matched on the API name or the underlying mode, as before — a caller sending `AIR`
  // rather than `EXPRESS` has always worked and continues to.
  const requested = wanted
    ? offered.filter(
        (tier) => tier.api === wanted || tier.mode.toUpperCase() === wanted,
      )
    : offered;

  // A supplied chargeable weight is honoured by handing the engine a shipment that
  // weighs it: the engine takes the greatest of actual, volumetric and the mode minimum,
  // so passing it as the actual weight is what makes it the floor. The dimensions are
  // still sent, so our own volumetric figure is computed and reported alongside.
  const shipment = {
    actualWeight: Math.max(input.actualWeight, input.chargeableWeight ?? 0),
    ...(input.length === undefined ? {} : { length: input.length }),
    ...(input.width === undefined ? {} : { breadth: input.width }),
    ...(input.height === undefined ? {} : { height: input.height }),
  };

  const tiers = requested.flatMap((tier) => {
    // A built-in network prices as its own mode: passing a multiplier of 1 would be the
    // same arithmetic, but `nfo` is the exception — the card's own nfoMultiplier governs
    // it, and handing the engine a service would override that with a 1 stored on a
    // record nobody has tuned.
    const rules = isBuiltIn(tier.service.key) ? undefined : serviceRules(tier.service);
    const result = quote(
      { ...shipment, mode: tier.mode, ...(rules === undefined ? {} : { service: rules }) },
      { origin, destination },
      card,
      undefined,
      undefined,
      undefined,
      offers,
    );
    // A lane the network does not carry is omitted rather than priced at zero: an
    // absent tier is a true answer, a zero is a bookable-looking lie.
    if (!result.available) return [];
    const b = result.breakdown;

    return [
      {
        service: tier.api,
        price: b.total,
        estimatedDays: b.transitDays === null ? '' : String(b.transitDays),
        description: tier.description,
        features: tier.features,
        breakdown: {
          actualWeight: input.actualWeight,
          volumetricWeight: b.volumetricWeight,
          chargeableWeight: b.chargeableWeight,
          /** Echoed when the caller sent one, so the two can be compared at a glance. */
          ...(input.chargeableWeight === undefined
            ? {}
            : { chargeableWeightSupplied: input.chargeableWeight }),
          // Vehicle and carrier selection stay with the core: both need fleet and hub
          // knowledge this service does not have. Empty, never invented.
          vehicle: '',
          vehicleName: '',
          vehicleMaxWt: 0,
          vehicleMaxL: 0,
          vehicleMaxW: 0,
          vehicleMaxH: 0,
          vehicleCategory: '',
          /**
           * The divisor we actually used, not zero.
           *
           * This was reported as zero under the rule that fields the core owns are never
           * invented — but this one is ours. It is the number needed to check a chargeable
           * weight, and withholding it is what turns a reconcilable difference into an
           * argument.
           */
          volDivisor: divisorFor(card, tier.mode),
          rateSource: b.laneProvenance.trace,
          /**
           * The per-kilogram tariff rate governing this weight.
           *
           * `applicableRate` is populated for the min-plus-excess and max-of-min-or-full
           * cards, where one rate prices the shipment. A cumulative-slab card has no
           * single rate — the price is built from several slabs — so the engine returns
           * null for it. The field still has to mean one thing across all three, and it
           * means *the tariff rate for this weight band*, so a slab card reports the same
           * band lookup the other two use. An average of freight over weight would be a
           * different quantity in the same field: at 150 kg the min-plus-excess card
           * reports its tier-2 rate of 13 while the average is 11.80, and two engines
           * compared cell by cell would read that as a pricing difference.
           */
          ratePerKg: b.applicableRate ?? applicableTierRate(b.chargeableWeight, b.rates) ?? 0,
          minFreight: b.rates.minCharge ?? 0,
          baseFreight: b.freight,
          /**
           * Their tiers are one rate times a service factor, and this is that factor.
           *
           * A network reports 1 because its rate was negotiated directly rather than
           * derived — an EXPRESS price here is the air rate actually agreed, not surface
           * with a markup. A configured service reports its own multiplier, because that
           * is literally how its price was reached.
           */
          serviceMult: isBuiltIn(tier.service.key) ? 1 : tier.service.multiplier,
          serviceMultName: `${card.name} · ${tier.service.name}`,
          originCity: origin.city ?? origin.area,
          destCity: destination.city ?? destination.area,
          chargeConfigName: card.name,
          pdConfigName: card.name,
          odaConfigName: card.name,
          odaOriginCharge: b.pickupOda,
          odaOriginStatus: modeInfo(origin, tier.mode).odaCategory,
          odaDestCharge: b.deliveryOda,
          odaDestStatus: modeInfo(destination, tier.mode).odaCategory,
          fuelSurchargePct: fuelPctFor(card, tier.mode),
          fuelSurchargeAmt: b.fuel,
          awbCharge: b.docket,
          handlingCharge: 0,
          codFee: 0,
          insuranceCharge: 0,
          pickupCharge: b.pickup,
          deliveryCharge: b.delivery,
          /**
           * Freight before and after an offer, and the discount between them.
           *
           * These were `b.freight` twice and two hardcoded zeros, which was safe only while
           * nothing could discount a quote. An offer does exactly that — and reporting the
           * reduced freight with `discountAmt: 0` would tell the core a lower price was the
           * list price, leaving nobody able to explain months later why that shipment was
           * cheaper. An offer is applied and never stored, so if the quote does not carry it,
           * nothing does.
           */
          freightSubtotal: b.offer?.freightBeforeOffer ?? b.freight,
          adjustedFreight: b.freight,
          discountPct: b.offer?.freightBeforeOffer
            ? Number(((b.offer.discount / b.offer.freightBeforeOffer) * 100).toFixed(2))
            : 0,
          discountAmt: b.offer?.discount ?? 0,
          /**
           * Which offer, by name. Additive — a caller that does not read it is unaffected,
           * and one that does can say "Diwali 10%" instead of "the price changed".
           */
          ...(b.offer
            ? {
                offer: {
                  key: b.offer.key,
                  name: b.offer.name,
                  kind: b.offer.kind,
                  discount: b.offer.discount,
                  freightBeforeOffer: b.offer.freightBeforeOffer,
                  ...(b.offer.waived.length > 0 ? { waived: b.offer.waived } : {}),
                },
              }
            : {}),
          subtotal: b.subTotal,
          gstProfile: b.tax.sac,
          // Theirs is a percentage, ours a fraction.
          gstPct: round2(b.tax.gstRate * 100),
          gstAmt: b.gst,
          total: b.total,
          carrierId: '',
          carrierName: '',
          carrierSelectionReason: 'Carrier selection is the core’s.',
        },
      },
    ];
  });

  const first = requested[0]?.mode ?? 'surface';
  const transit =
    tiers.length > 0 && tiers[0]?.estimatedDays ? Number(tiers[0].estimatedDays) : null;

  /**
   * Kept before it is returned, because the identifier has to name something that exists.
   *
   * If the write fails the quote is still answered — refusing to price a shipment because
   * we could not file the paperwork would be the wrong trade for a booking desk. The
   * response then carries no `quoteId` rather than one that resolves to nothing, which is
   * the honest signal: absent means unprovable, and a caller can see that at the time
   * instead of six weeks later.
   */
  let recorded: { quoteId: string; validUntil: Date } | null = null;
  try {
    recorded = await recordQuote({
      caller: auth.caller.keyId,
      request: {
        originPincode: Number(input.originPincode),
        destinationPincode: Number(named.destination),
        actualWeight: input.actualWeight,
        ...(input.length === undefined && input.width === undefined && input.height === undefined
          ? {}
          : {
              dimensionsCm: {
                ...(input.length === undefined ? {} : { length: input.length }),
                ...(input.width === undefined ? {} : { breadth: input.width }),
                ...(input.height === undefined ? {} : { height: input.height }),
              },
            }),
        ...(input.chargeableWeight === undefined
          ? {}
          : { chargeableWeightSupplied: input.chargeableWeight }),
        ...(named.customerCode === undefined ? {} : { customerCode: named.customerCode }),
        ...(input.declaredValue === undefined ? {} : { declaredValue: input.declaredValue }),
        ...(input.codValue === undefined ? {} : { codValue: input.codValue }),
        ...(input.transportMode === undefined ? {} : { transportMode: input.transportMode }),
      },
      pricedAgainst: {
        cardKey: card.key,
        cardName: card.name,
        ...(card.version === undefined ? {} : { cardVersion: card.version }),
        ...(named.customerCode === undefined ? {} : { customerCode: named.customerCode }),
        ...(contract === null
          ? {}
          : { contractFingerprint: contract.fingerprint, contractOverrides: contract.overrides }),
      },
      tiers: tiers.map((tier) => ({
        service: tier.service,
        mode: offered.find((entry) => entry.api === tier.service)?.mode ?? '',
        total: tier.price,
        chargeableWeight: tier.breakdown.chargeableWeight,
        breakdown: tier.breakdown as unknown as Record<string, unknown>,
      })),
    });
  } catch (error) {
    console.error('quote could not be recorded', error);
  }

  return NextResponse.json({
    success: true,
    data: {
      // The identifier for this priced answer. The handbook asks for it by name: a number
      // on an invoice has to be re-explainable long after the card has moved on.
      ...(recorded === null
        ? {}
        : {
            quoteId: recorded.quoteId,
            // Rates and fuel move. Past this the quote has to be asked for again rather
            // than honoured from memory.
            validUntil: recorded.validUntil.toISOString(),
          }),
      origin: pincodeInfo(origin, first, transit),
      destination: pincodeInfo(destination, first, transit),
      tiers,
    },
  });
}
