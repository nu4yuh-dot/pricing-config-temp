import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveCard } from './contract';
import { quote } from '../pricing/quote';
import { EMPTY_TERMS, type Overrides } from '../domain/customers';
import type { Pincode, RateCard } from '../domain/types';

/**
 * Two real contracts, expressed in the fields the engine already has.
 *
 * MAHLE and A Raymond are the two contracts on file with full terms, and between them
 * they exercise every idea in the settlement engine: flat per-kg lane pricing, a minimum
 * plus per-kg excess, a customer-specific minimum chargeable weight, fuel on total
 * charges, and an express surcharge that varies by destination.
 *
 * They also settle the question of whether a fourth freight formula is needed. It is not.
 * What they need is the *right* formula per customer, which is a property of the base card
 * a contract is written against:
 *
 *   MAHLE     flat per-kg by lane, with a floor  ->  MAX_MIN_OR_FULL   (model-3)
 *   A Raymond minimum plus per-kg on the excess  ->  MIN_PLUS_EXCESS   (model-2)
 *
 * One divergence is recorded rather than papered over: see the MAHLE air block below.
 */

const load = (key: string): RateCard =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', `${key}.json`), 'utf8'),
  );

const zoneAt = (zone: string, pincode: number, area: string): Pincode => ({
  pincode,
  area,
  state: '',
  air: { serviceable: true, hub: zone, zone, edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  surface: { serviceable: true, hub: zone, zone, edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  rail: { serviceable: true, hub: zone, station: zone, zone, edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
});

const MAA = zoneAt('MAA', 600001, 'Chennai');
const PNQ = zoneAt('PNQ', 411001, 'Pune');
const NCR = zoneAt('NCR', 110001, 'New Delhi');
const BLR = zoneAt('BLR', 560001, 'Bengaluru');

const priced = (card: RateCard, overrides: Overrides, input: Parameters<typeof quote>[0], from: Pincode, to: Pincode) => {
  const result = quote(
    input,
    { origin: from, destination: to },
    effectiveCard(card, { ...EMPTY_TERMS, overrides }),
    undefined,
    overrides,
  );
  if (!result.available) throw new Error(`not available: ${result.message}`);
  return result.breakdown;
};

/* ------------------------------------------------------------------------ MAHLE */

/**
 * MAHLE Anand Thermal Systems, GSTIN 27AABCB2186L1ZI, Chakan/Pune.
 *
 * Surface is flat per-kg by lane with no tiers, which `MAX_MIN_OR_FULL` expresses exactly:
 * with a minimum charge of zero it reduces to rate x weight, and the contracted minimum
 * chargeable weight supplies the floor.
 */
const MAHLE: Overrides = {
  // Surface, Rs/kg by lane. All three tiers carry the same rate because the contract
  // has no tiers — the rate does not change with weight.
  'grids.surface.minCharge.MAA.PNQ': 0,
  'grids.surface.tier1.MAA.PNQ': 8,
  'grids.surface.tier2.MAA.PNQ': 8,
  'grids.surface.tier3.MAA.PNQ': 8,
  'grids.surface.minCharge.PNQ.NCR': 0,
  'grids.surface.tier1.PNQ.NCR': 9,
  'grids.surface.tier2.PNQ.NCR': 9,
  'grids.surface.tier3.PNQ.NCR': 9,

  // Air, all metros: Rs 4,800 up to the 50 kg minimum, then Rs 75/kg. Taken from
  // Annexure 2 of the signed card, not from the summary deck — the deck said Rs 5,200
  // and Rs 80/kg, both of which are wrong.
  'grids.air.minCharge.PNQ.NCR': 4800,
  'grids.air.tier1.PNQ.NCR': 75,
  'grids.air.tier2.PNQ.NCR': 75,
  'grids.air.tier3.PNQ.NCR': 75,

  // Contracted weight rules, which differ from the card's defaults of 25 / 50.
  'charges.minWeightAir': 50,
  'charges.minWeightSurface': 100,
  // "1 CFT for Air LxBxH / 5000" on the air annexure, "/ 4000" on the surface one.
  'charges.volumetricDivisorAir': 5000,
  'charges.volumetricDivisorSurface': 4000,

  // Fuel 10%, on the standard base — this contract does not say "on total".
  'charges.fuelAir': 0.1,
  'charges.fuelSurface': 0.1,

  // P&D Rs 2,000 surface and Rs 3,000 air, as Rs 1,000 / Rs 1,500 each leg.
  'pickupDelivery.MAA.pickupSurface': 1000,
  'pickupDelivery.PNQ.deliverySurface': 1000,
  'pickupDelivery.PNQ.pickupAir': 1500,
  'pickupDelivery.NCR.deliveryAir': 1500,
};

describe('MAHLE — flat per-kg by lane, on the max-or-full card', () => {
  const card = load('model-3');

  test('surface freight is the contracted rate times the weight, exactly', () => {
    expect(priced(card, MAHLE, { mode: 'surface', actualWeight: 200 }, MAA, PNQ).freight).toBe(1600);
  });

  test('the contracted 100 kg surface minimum floors a small shipment', () => {
    // 30 kg is billed as 100 kg: Rs 8 x 100.
    expect(priced(card, MAHLE, { mode: 'surface', actualWeight: 30 }, MAA, PNQ).freight).toBe(800);
  });

  test('a second lane carries its own rate', () => {
    expect(priced(card, MAHLE, { mode: 'surface', actualWeight: 200 }, PNQ, NCR).freight).toBe(1800);
  });

  test('the landed surface total is right end to end', () => {
    const b = priced(card, MAHLE, { mode: 'surface', actualWeight: 200 }, MAA, PNQ);
    // freight 1600 + fuel 10% of (1600+1000+1000) + cartage 2000 + docket 100
    expect(b.fuel).toBe(360);
    expect(b.subTotal).toBe(4060);
    expect(b.gst).toBe(203);
    expect(b.total).toBe(4263);
  });

  test('air above the minimum is charged per kg on the full weight', () => {
    const b = priced(card, MAHLE, { mode: 'air', actualWeight: 100 }, PNQ, NCR);
    // Rs 75 x 100 kg, then 10% fuel on freight + Rs 3,000 cartage, then the docket.
    expect(b.freight).toBe(7500);
    expect(b.fuel).toBe(1050);
    expect(b.subTotal).toBe(11650);
    expect(b.total).toBe(13747);
  });

  test('the 26–50 kg air band comes out at the contracted Rs 4,800', () => {
    expect(priced(card, MAHLE, { mode: 'air', actualWeight: 40 }, PNQ, NCR).freight).toBe(4800);
  });

  /**
   * The one divergence, recorded deliberately.
   *
   * Annexure 2 lists three air bands — 1–25 kg Rs 4,500, 26–50 Rs 4,800, 51+ Rs 75/kg —
   * but also sets the minimum chargeable weight for air at 50 kg. A 20 kg shipment is
   * therefore billed as 50 kg, which puts it in the second band. The Rs 4,500 band cannot
   * be reached, so the engine charges Rs 5,200.
   *
   * Two readings are possible and only MAHLE can settle it: either the Rs 4,500 band is
   * superseded by the 50 kg minimum (what this asserts, and it never undercharges), or the
   * minimum is really 25 kg with a step at 26 kg — which is a second flat band, and no rate
   * card in this system, or in the source workbooks, has two.
   */
  test('the 1–25 kg air band is unreachable behind the 50 kg minimum', () => {
    const b = priced(card, MAHLE, { mode: 'air', actualWeight: 20 }, PNQ, NCR);
    expect(b.chargeableWeight).toBe(50);
    expect(b.freight).toBe(4800);
    expect(b.freight).not.toBe(4500);
  });
});

/* -------------------------------------------------------------------- A Raymond */

/**
 * A Raymond, Chakan, PAN-India.
 *
 * Air is "minimum 50 kg at Rs 4,500, above that Rs 80 per kg", which is `MIN_PLUS_EXCESS`
 * exactly: the minimum covers the first 50 kg and only the excess is charged per kg.
 * Fuel is 35% on total charges, and there are nine express surcharges by destination.
 */
const ARAYMOND: Overrides = {
  'grids.air.minCharge.PNQ.BLR': 4500,
  'grids.air.tier1.PNQ.BLR': 80,
  'grids.air.tier2.PNQ.BLR': 80,
  'grids.air.tier3.PNQ.BLR': 80,
  'charges.minWeightAir': 50,

  // Fuel 35%, on everything — the case the fixed fuel base could not express.
  'charges.fuelAir': 0.35,
  'fuelBase.freight': 'Yes',
  'fuelBase.pickup': 'Yes',
  'fuelBase.delivery': 'Yes',
  'fuelBase.oda': 'Yes',
  'fuelBase.charges': 'Yes',

  // P&D Rs 1,000 per consignment, taken at the pickup end.
  'pickupDelivery.PNQ.pickupAir': 1000,
  'pickupDelivery.BLR.deliveryAir': 0,

  // ESS, switched on and priced per destination.
  'chargeCatalog.ess.active': 'Yes',
  'chargeCatalog.ess.byDestination.BLR': 3000,
  'chargeCatalog.ess.byDestination.HSR': 2000,
};

describe('A Raymond — minimum plus excess, fuel on total, ESS by destination', () => {
  const card = load('model-2');

  test('the minimum covers the first 50 kg', () => {
    expect(priced(card, ARAYMOND, { mode: 'air', actualWeight: 50 }, PNQ, BLR).freight).toBe(4500);
  });

  test('above the minimum only the excess is charged per kg', () => {
    // 4500 + 80 x (100 - 50)
    expect(priced(card, ARAYMOND, { mode: 'air', actualWeight: 100 }, PNQ, BLR).freight).toBe(8500);
  });

  test('the express surcharge for that destination is charged', () => {
    const b = priced(card, ARAYMOND, { mode: 'air', actualWeight: 100 }, PNQ, BLR);
    const ess = b.charges.find((charge) => charge.id === 'ess');
    expect(ess?.amount).toBe(3000);
  });

  test('fuel rides on freight, cartage and every charge', () => {
    const b = priced(card, ARAYMOND, { mode: 'air', actualWeight: 100 }, PNQ, BLR);
    // (freight 8500 + pickup 1000 + docket 100 + ESS 3000) x 35%
    expect(b.fuel).toBe(4410);
    expect(b.fuelBaseDescription).toBe('freight + pickup + delivery + ODA + other charges');
  });

  test('the landed total is right end to end', () => {
    const b = priced(card, ARAYMOND, { mode: 'air', actualWeight: 100 }, PNQ, BLR);
    expect(b.subTotal).toBe(17010);
    expect(b.gst).toBe(3061.8);
    expect(b.total).toBe(20071.8);
  });

  /** Charging 35% of freight and cartage alone under-quotes them on every shipment. */
  test('leaving the charges out of the fuel base under-quotes them', () => {
    const onTotal = priced(card, ARAYMOND, { mode: 'air', actualWeight: 100 }, PNQ, BLR);
    const withoutCharges = priced(
      card,
      { ...ARAYMOND, 'fuelBase.charges': 'No' },
      { mode: 'air', actualWeight: 100 },
      PNQ,
      BLR,
    );
    expect(withoutCharges.fuel).toBe(3325);
    // 35% of the docket and the ESS — Rs 1,085 lost on this one shipment.
    expect(onTotal.fuel - withoutCharges.fuel).toBe(1085);
    expect(onTotal.total).toBeGreaterThan(withoutCharges.total);
  });

  test('a destination with no express surcharge is not charged one', () => {
    const b = priced(card, ARAYMOND, { mode: 'air', actualWeight: 100 }, PNQ, NCR);
    expect(b.charges.find((charge) => charge.id === 'ess')).toBeUndefined();
  });
});

/**
 * Weight rules are negotiated as often as rates are.
 *
 * A volumetric divisor or a minimum chargeable weight decides the weight a shipment is
 * billed at before any rate applies, so a contracted value moves every quote on the
 * account. These are stored as ordinary negotiated cells and priced through the same path.
 */
describe('a contract can negotiate its own weight rules', () => {
  const card = load('model-1');
  const box = { mode: 'surface' as const, actualWeight: 10, length: 80, breadth: 60, height: 50 };

  test('the standard divisor applies when nothing is negotiated', () => {
    const standard = priced(card, {}, box, PNQ, NCR);
    // 80 x 60 x 50 = 240,000 cm3 over the card's own surface divisor.
    expect(standard.volumetricWeight).toBe(
      Math.round((240000 / card.data.charges.volumetricDivisorSurface) * 10) / 10,
    );
  });

  test('a negotiated divisor changes the billed weight, and so the price', () => {
    const standard = priced(card, {}, box, PNQ, NCR);
    const negotiated = priced(
      card,
      { 'charges.volumetricDivisorSurface': 6000 },
      box,
      PNQ,
      NCR,
    );
    // A larger divisor means less volumetric weight: 240,000 / 6,000 = 40 kg.
    expect(negotiated.volumetricWeight).toBe(40);
    expect(negotiated.volumetricWeight).not.toBe(standard.volumetricWeight);
    expect(negotiated.freight).toBeLessThan(standard.freight);
  });

  test('a negotiated minimum weight floors a small shipment', () => {
    const light = { mode: 'surface' as const, actualWeight: 30 };
    const standard = priced(card, {}, light, PNQ, NCR);
    const negotiated = priced(card, { 'charges.minWeightSurface': 100 }, light, PNQ, NCR);
    expect(negotiated.chargeableWeight).toBe(100);
    expect(negotiated.chargeableWeight).toBeGreaterThan(standard.chargeableWeight);
  });

  test('the divisor is per mode: negotiating surface leaves air alone', () => {
    const overrides = { 'charges.volumetricDivisorSurface': 6000 };
    const air = { mode: 'air' as const, actualWeight: 10, length: 80, breadth: 60, height: 50 };
    expect(priced(card, overrides, air, PNQ, NCR).volumetricWeight).toBe(
      priced(card, {}, air, PNQ, NCR).volumetricWeight,
    );
  });
});

/**
 * A charge the standard menu does not have.
 *
 * Customers negotiate one-off charges — a demurrage, a deposit, a site levy — and the menu
 * of six cannot anticipate them. A charge is identified by its id, so a contract may name
 * one the card has never heard of; it prices as a flat per-shipment amount, which is what
 * a one-off almost always is.
 */
describe('a customer can carry a charge the menu does not have', () => {
  const card = load('model-1');
  const ask = { mode: 'surface' as const, actualWeight: 200 };

  test('a custom charge reaches the quote and the total', () => {
    const plain = priced(card, {}, ask, PNQ, NCR);
    const withLevy = priced(
      card,
      {
        'chargeCatalog.site-levy.name': 'Site entry levy',
        'chargeCatalog.site-levy.amount': 250,
        'chargeCatalog.site-levy.gstApplies': 'Yes',
        'chargeCatalog.site-levy.active': 'Yes',
      },
      ask,
      PNQ,
      NCR,
    );
    const levy = withLevy.charges.find((charge) => charge.id === 'site-levy');
    expect(levy?.name).toBe('Site entry levy');
    expect(levy?.amount).toBe(250);
    expect(withLevy.subTotal).toBe(plain.subTotal + 250);
  });

  test('it defaults to a flat per-shipment charge, which is what a one-off is', () => {
    const b = priced(
      card,
      { 'chargeCatalog.demurrage.amount': 500, 'chargeCatalog.demurrage.active': 'Yes' },
      ask,
      PNQ,
      NCR,
    );
    expect(b.charges.find((charge) => charge.id === 'demurrage')?.basis).toBe('per-shipment');
  });

  test('a custom charge outside GST is added after tax, not inside the taxable value', () => {
    const plain = priced(card, {}, ask, PNQ, NCR);
    const b = priced(
      card,
      {
        'chargeCatalog.deposit.name': 'Refundable deposit',
        'chargeCatalog.deposit.amount': 1000,
        'chargeCatalog.deposit.gstApplies': 'No',
        'chargeCatalog.deposit.active': 'Yes',
      },
      ask,
      PNQ,
      NCR,
    );
    // The taxable value is untouched, so no GST is charged on a refundable amount.
    expect(b.subTotal).toBe(plain.subTotal);
    expect(b.gst).toBe(plain.gst);
    expect(b.total).toBe(plain.total + 1000);
  });

  test('switching it off removes it again without losing what was configured', () => {
    const overrides = {
      'chargeCatalog.site-levy.amount': 250,
      'chargeCatalog.site-levy.active': 'No',
    };
    const b = priced(card, overrides, ask, PNQ, NCR);
    expect(b.charges.find((charge) => charge.id === 'site-levy')).toBeUndefined();
  });
});

/* ------------------------------------------------------- where a price came from */

describe('resolution trace on a real contract', () => {
  test("MAHLE's Chennai-Pune surface lane reports as negotiated, naming all four rates", () => {
    const b = priced(load('model-3'), MAHLE, { mode: 'surface', actualWeight: 200 }, MAA, PNQ);

    expect(b.laneProvenance.layer).toBe('contract');
    expect(b.laneProvenance.negotiated).toEqual(['minCharge', 'tier1', 'tier2', 'tier3']);
    expect(b.laneProvenance.trace).toBe('MAA → PNQ · zone → zone · contract');
  });

  test('a lane MAHLE never negotiated still reads as the base card', () => {
    const b = priced(load('model-3'), MAHLE, { mode: 'surface', actualWeight: 200 }, BLR, NCR);

    expect(b.laneProvenance.layer).toBe('base');
    expect(b.laneProvenance.negotiated).toEqual([]);
  });
});
