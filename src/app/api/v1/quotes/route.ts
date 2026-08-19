import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiKey, badRequest } from '../../_auth';
import { findPincodePair } from '../../../../data/pincodes';
import { liveCard } from '../../../../data/rate-cards';
import { findCustomer, contractedCard } from '../../../../data/customers';
import { quote } from '../../../../pricing/quote';
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

const TIERS: { service: string; mode: Mode; description: string; features: string[] }[] = [
  {
    service: 'ECONOMY',
    mode: 'surface',
    description: 'Road, the standard service.',
    features: ['Door to door', 'Surface network'],
  },
  {
    service: 'EXPRESS',
    mode: 'air',
    description: 'Air, for time-sensitive freight.',
    features: ['Door to door', 'Air network'],
  },
  {
    service: 'CRITICAL',
    mode: 'nfo',
    description: 'Next flight out.',
    features: ['Door to door', 'Next available flight'],
  },
  {
    service: 'RAIL',
    mode: 'rail',
    description: 'Rail, where the lane is served.',
    features: ['Door to door', 'Rail network'],
  },
];

const Body = z.object({
  originPincode: z.union([z.string(), z.number()]),
  destPincode: z.union([z.string(), z.number()]),
  actualWeight: z.coerce.number().positive(),
  length: z.coerce.number().nonnegative().optional(),
  width: z.coerce.number().nonnegative().optional(),
  height: z.coerce.number().nonnegative().optional(),
  /** Our customer code. Absent quotes the base card. */
  customerId: z.string().trim().min(1).optional(),
  declaredValue: z.coerce.number().nonnegative().optional(),
  codValue: z.coerce.number().nonnegative().optional(),
  /** One of ECONOMY / EXPRESS / CRITICAL / RAIL, or a mode name. Absent returns all. */
  transportMode: z.string().trim().optional(),
});

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
  const unauthorised = requireApiKey(request);
  if (unauthorised) return unauthorised;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest('Body must be JSON.');
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return badRequest(
      'Missing or invalid fields. originPincode, destPincode and actualWeight are required.',
      parsed.error.flatten(),
    );
  }
  const input = parsed.data;

  const { origin, destination } = await findPincodePair(
    Number(input.originPincode),
    Number(input.destPincode),
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

  if (input.customerId) {
    const customer = await findCustomer(input.customerId);
    if (!customer) {
      return NextResponse.json(
        { success: false, message: `Unknown customer ${input.customerId}.` },
        { status: 404 },
      );
    }
    // The contracted card is the base card with this customer's negotiated cells
    // applied, so a quote here is the price they were actually promised.
    card = await contractedCard(customer);
  } else {
    card = await liveCard(DEFAULT_CARD_KEY);
  }

  if (!card) {
    return NextResponse.json(
      { success: false, message: 'No rate card is available to price against.' },
      { status: 503 },
    );
  }

  /* ----------------------------------------------------------------- the tiers */

  const wanted = input.transportMode?.toUpperCase();
  const requested = wanted
    ? TIERS.filter((tier) => tier.service === wanted || tier.mode.toUpperCase() === wanted)
    : TIERS;

  const shipment = {
    actualWeight: input.actualWeight,
    ...(input.length === undefined ? {} : { length: input.length }),
    ...(input.width === undefined ? {} : { breadth: input.width }),
    ...(input.height === undefined ? {} : { height: input.height }),
  };

  const tiers = requested.flatMap((tier) => {
    const result = quote({ ...shipment, mode: tier.mode }, { origin, destination }, card);
    // A lane the network does not carry is omitted rather than priced at zero: an
    // absent tier is a true answer, a zero is a bookable-looking lie.
    if (!result.available) return [];
    const b = result.breakdown;

    return [
      {
        service: tier.service,
        price: b.total,
        estimatedDays: b.transitDays === null ? '' : String(b.transitDays),
        description: tier.description,
        features: tier.features,
        breakdown: {
          actualWeight: input.actualWeight,
          volumetricWeight: b.volumetricWeight,
          chargeableWeight: b.chargeableWeight,
          // Vehicle and carrier selection stay with the core: both need fleet and hub
          // knowledge this service does not have. Empty, never invented.
          vehicle: '',
          vehicleName: '',
          vehicleMaxWt: 0,
          vehicleMaxL: 0,
          vehicleMaxW: 0,
          vehicleMaxH: 0,
          vehicleCategory: '',
          volDivisor: 0,
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
          // Their tiers are a multiplier on one rate; ours are separate cards, so the
          // multiplier is always 1 and the name says which card answered.
          serviceMult: 1,
          serviceMultName: `${card.name} · ${tier.mode}`,
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
          freightSubtotal: b.freight,
          adjustedFreight: b.freight,
          discountPct: 0,
          discountAmt: 0,
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

  return NextResponse.json({
    success: true,
    data: {
      origin: pincodeInfo(origin, first, transit),
      destination: pincodeInfo(destination, first, transit),
      tiers,
    },
  });
}
