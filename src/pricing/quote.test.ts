import { describe, expect, test } from 'vitest';
import { quote } from './quote';
import type { RateCard, Pincode } from '../domain/types';
import { upsertRule, type StoredLaneRule } from '../domain/lane-rule-store';
import { round2 } from './weight';
import model1 from '../../data/extracted/model-1.json';

const card = model1 as unknown as RateCard;

const PNQ: Pincode = {
  pincode: 411001,
  area: 'Pune City',
  state: 'Maharashtra',
  air: { serviceable: true, hub: 'Pune', zone: 'PNQ', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  surface: { serviceable: true, hub: 'PNQ', zone: 'PNQ', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  rail: { serviceable: true, hub: 'Pune', station: 'Pune', zone: 'PNQ', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
};

const NCR: Pincode = {
  pincode: 110001,
  area: 'New Delhi GPO',
  state: 'Delhi',
  air: { serviceable: true, hub: 'Delhi-NCR', zone: 'NCR', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  surface: { serviceable: true, hub: 'NCR', zone: 'NCR', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  rail: { serviceable: true, hub: 'Delhi', station: 'Delhi (Tughlakabad)', zone: 'NCR', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
};

describe('quote — charge order and derivation', () => {
  const result = quote(
    { mode: 'surface', actualWeight: 200 },
    { origin: PNQ, destination: NCR },
    card,
  );

  test('is available for a served lane', () => {
    expect(result.available).toBe(true);
  });

  test('applies fuel to freight, pickup, delivery and both ODA legs', () => {
    if (!result.available) throw new Error('expected an available quote');
    const { breakdown: b } = result;
    const fuelBase = b.freight + b.pickup + b.pickupOda + b.delivery + b.deliveryOda;
    expect(b.fuel).toBe(Math.round(fuelBase * 0.25 * 10) / 10);
  });

  test('excludes docket from the fuel base', () => {
    if (!result.available) throw new Error('expected an available quote');
    // 2680 + 400 + 800 = 3880; x 0.25 = 970. Docket would have made this 995.
    expect(result.breakdown.fuel).toBe(970);
    expect(result.breakdown.docket).toBe(100);
  });

  test('adds GST to the sub-total using the already-rounded GST figure', () => {
    if (!result.available) throw new Error('expected an available quote');
    const { breakdown: b } = result;
    expect(b.total).toBe(b.subTotal + b.gst);
  });

  test('reports the transit time for the lane', () => {
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.transitDays).toBe(5);
  });
});

describe('quote — zero pickup and delivery within one zone', () => {
  test('charges no cartage when origin and destination share a zone', () => {
    const result = quote(
      { mode: 'surface', actualWeight: 200 },
      { origin: PNQ, destination: { ...PNQ, pincode: 411004 } },
      card,
    );
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.pickup).toBe(0);
    expect(result.breakdown.delivery).toBe(0);
  });
});

describe('quote — rail', () => {
  test('charges no fuel surcharge', () => {
    const result = quote({ mode: 'rail', actualWeight: 101 }, { origin: PNQ, destination: NCR }, card);
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.fuel).toBe(0);
  });
});

describe('quote — NFO is twice the air card', () => {
  test('doubles every air rate', () => {
    const air = quote({ mode: 'air', actualWeight: 100 }, { origin: PNQ, destination: NCR }, card);
    const nfo = quote({ mode: 'nfo', actualWeight: 100 }, { origin: PNQ, destination: NCR }, card);
    if (!air.available || !nfo.available) throw new Error('expected available quotes');
    expect(nfo.breakdown.freight).toBe(air.breakdown.freight * 2);
  });
});

describe('quote — unavailable and unknown', () => {
  const BOM_AIR: Pincode = {
    ...PNQ,
    pincode: 400001,
    air: { ...PNQ.air, zone: 'BOM' },
    surface: { ...PNQ.surface, zone: 'BOM' },
    rail: { ...PNQ.rail, zone: 'BOM' },
  };

  test('reports a lane the mode does not serve', () => {
    const result = quote({ mode: 'air', actualWeight: 200 }, { origin: PNQ, destination: BOM_AIR }, card);
    expect(result.available).toBe(false);
    if (result.available) throw new Error('expected an unavailable quote');
    expect(result.reason).toBe('lane-not-served');
  });

  test('reports an unresolvable origin pincode', () => {
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: null, destination: NCR }, card);
    expect(result.available).toBe(false);
    if (result.available) throw new Error('expected an unavailable quote');
    expect(result.reason).toBe('unknown-origin-pincode');
  });

  test('reports an unresolvable destination pincode', () => {
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: null }, card);
    expect(result.available).toBe(false);
    if (result.available) throw new Error('expected an unavailable quote');
    expect(result.reason).toBe('unknown-destination-pincode');
  });
});

/**
 * The pricing-engine design adds four things to a card: mode-wise GST, a configurable
 * fuel base, a charge catalog and a buy tariff. All four are optional, because the
 * imported workbooks carry none of them and their verified numbers must not move.
 */
describe('quote — a card with no new configuration behaves exactly as before', () => {
  const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, card);

  test('fuel still rides on freight and cartage, and the quote says so', () => {
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.fuel).toBe(970);
    expect(result.breakdown.fuelBaseDescription).toBe('freight + pickup + delivery + ODA');
  });

  test("GST uses the card's own rate at forward charge, not the statutory default", () => {
    if (!result.available) throw new Error('expected an available quote');
    // The workbook's surface GST is 5% forward. The statutory default is 5% *RCM*,
    // which would bill nothing; adopting it silently would change a verified total.
    expect(result.breakdown.tax.gstRate).toBe(0.05);
    expect(result.breakdown.tax.rcm).toBe(false);
    expect(result.breakdown.gst).toBeGreaterThan(0);
  });

  test('the SAC code is still reported, so the quote can be invoiced', () => {
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.tax.sac).toBe('9965');
  });

  test('the docket appears both on its own line and in the charge list', () => {
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.docket).toBe(100);
    expect(result.breakdown.charges.map((c) => c.id)).toEqual(['docket']);
    expect(result.breakdown.chargesTotal).toBe(100);
  });

  test('no buy tariff means no margin, rather than a margin against zero', () => {
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.margin).toBeUndefined();
  });
});

describe('quote — mode-wise GST, once the card declares it', () => {
  const rcmCard: RateCard = {
    ...card,
    data: { ...card.data, modeTax: { surface: { rcm: true } } },
  };

  test('a reverse-charge mode bills no GST and says why', () => {
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, rcmCard);
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.gst).toBe(0);
    expect(result.breakdown.gstNote).toMatch(/reverse charge/i);
    expect(result.breakdown.gstNote).toMatch(/9965/);
  });

  test('the rate is still recorded when it is not billed, because the invoice states it', () => {
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, rcmCard);
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.tax.gstRate).toBe(0.05);
    expect(result.breakdown.tax.rcm).toBe(true);
  });

  test('a per-card rate override replaces the workbook rate', () => {
    const twelve: RateCard = {
      ...card,
      data: { ...card.data, modeTax: { surface: { gstRate: 0.12 } } },
    };
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, twelve);
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.tax.gstRate).toBe(0.12);
    expect(result.breakdown.gst).toBe(Math.round(result.breakdown.subTotal * 0.12 * 10) / 10);
  });
});

describe('quote — fuel base and charge catalog from the card', () => {
  test('fuel on total brings the charges into the fuel base', () => {
    const onTotal: RateCard = {
      ...card,
      data: {
        ...card.data,
        fuelBase: { freight: true, pickup: true, delivery: true, oda: true, charges: true },
      },
    };
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, onTotal);
    if (!result.available) throw new Error('expected an available quote');
    // (2680 + 400 + 800 + docket 100) x 25%
    expect(result.breakdown.fuel).toBe(995);
    expect(result.breakdown.fuelBaseDescription).toMatch(/other charges/);
  });

  test('a catalog charge is quoted, and a charge outside GST lands after tax', () => {
    const withCharges: RateCard = {
      ...card,
      data: {
        ...card.data,
        chargeCatalog: [
          { id: 'docket', name: 'Docket', basis: 'per-shipment', amount: 100, gstApplies: true, fuelApplies: false, active: true },
          { id: 'deposit', name: 'Deposit', basis: 'per-shipment', amount: 500, gstApplies: false, fuelApplies: false, active: true },
        ],
      },
    };
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, withCharges);
    if (!result.available) throw new Error('expected an available quote');
    const b = result.breakdown;
    expect(b.charges.map((c) => c.id)).toEqual(['docket', 'deposit']);
    expect(b.subTotal).toBe(4950);
    expect(b.total).toBe(round2(b.subTotal + b.gst + 500));
  });

  test('a charge restricted to air is not quoted on surface', () => {
    const airOnly: RateCard = {
      ...card,
      data: {
        ...card.data,
        chargeCatalog: [
          { id: 'awb', name: 'AWB', basis: 'per-awb', amount: 35, gstApplies: true, fuelApplies: false, active: true, modes: ['air'] },
        ],
      },
    };
    const surface = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, airOnly);
    const air = quote({ mode: 'air', actualWeight: 200 }, { origin: PNQ, destination: NCR }, airOnly);
    if (!surface.available || !air.available) throw new Error('expected available quotes');
    expect(surface.breakdown.charges).toEqual([]);
    expect(air.breakdown.charges.map((c) => c.id)).toEqual(['awb']);
  });

  test('an empty catalog removes the docket rather than falling back to it', () => {
    const noCharges: RateCard = { ...card, data: { ...card.data, chargeCatalog: [] } };
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, noCharges);
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.docket).toBe(0);
    expect(result.breakdown.subTotal).toBe(4850);
  });
});

describe('quote — margin against the buy tariff', () => {
  /** A cost card 20% under the sell card on the lane being quoted. */
  const costed: RateCard = {
    ...card,
    data: {
      ...card.data,
      cost: {
        carrier: 'Surya Cargo',
        method: 'CUMULATIVE_SLABS',
        grids: {
          ...card.data.grids,
          surface: {
            minCharge: { PNQ: { NCR: 470 } },
            tier1: { PNQ: { NCR: 12 } },
            tier2: { PNQ: { NCR: 11.4 } },
            tier3: { PNQ: { NCR: 10 } },
          },
        },
      },
    },
  };

  test('reports buy, profit and the carrier it is measured against', () => {
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, costed);
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.margin?.buy).toBe(2210);
    expect(result.breakdown.margin?.profit).toBe(470);
    expect(result.breakdown.margin?.carrier).toBe('Surya Cargo');
  });

  test('margin compares freight with freight, not a landed price with a bare rate', () => {
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, costed);
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.margin?.sell).toBe(result.breakdown.freight);
  });

  test('a lane the coloader does not carry yields no margin', () => {
    const gap: RateCard = {
      ...costed,
      data: {
        ...costed.data,
        cost: {
          ...costed.data.cost!,
          grids: {
            ...costed.data.cost!.grids,
            surface: { minCharge: {}, tier1: {}, tier2: {}, tier3: {} },
          },
        },
      },
    };
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, gap);
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.margin).toBeUndefined();
  });

  test('a thin margin is flagged on the quote, so a booking desk can see it', () => {
    const thin: RateCard = {
      ...costed,
      data: {
        ...costed.data,
        cost: {
          ...costed.data.cost!,
          grids: {
            ...costed.data.cost!.grids,
            surface: {
              minCharge: { PNQ: { NCR: 520 } },
              tier1: { PNQ: { NCR: 14.5 } },
              tier2: { PNQ: { NCR: 13.8 } },
              tier3: { PNQ: { NCR: 11.8 } },
            },
          },
        },
      },
    };
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, thin);
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.margin?.thin).toBe(true);
    expect(result.warnings.some((w) => /margin/i.test(w))).toBe(true);
  });
});

/**
 * Weight rules per mode.
 *
 * Rail shared surface's minimum weight and volumetric divisor because the source workbooks
 * had no rail-specific fields, not because the two modes bill the same way — rail already
 * has its own heavy-package rule. A card can now state rail's own, and falls back to
 * surface when it does not, so nothing that predates the fields moves.
 */
describe('quote — rail can carry its own weight rules', () => {
  const railCard = (over: Record<string, number>): RateCard => ({
    ...card,
    data: { ...card.data, charges: { ...card.data.charges, ...over } },
  });

  test('rail falls back to the surface minimum when it states none', () => {
    const result = quote({ mode: 'rail', actualWeight: 10 }, { origin: PNQ, destination: NCR }, card);
    if (!result.available) throw new Error('expected a price');
    expect(result.breakdown.chargeableWeight).toBe(card.data.charges.minWeightSurface);
  });

  test('a rail minimum of its own is used instead', () => {
    const result = quote(
      { mode: 'rail', actualWeight: 10 },
      { origin: PNQ, destination: NCR },
      railCard({ minWeightRail: 200 }),
    );
    if (!result.available) throw new Error('expected a price');
    expect(result.breakdown.chargeableWeight).toBe(200);
  });

  test('a rail volumetric divisor of its own is used instead', () => {
    const box = { mode: 'rail' as const, actualWeight: 10, length: 100, breadth: 100, height: 100 };
    const standard = quote(box, { origin: PNQ, destination: NCR }, card);
    const railOwn = quote(box, { origin: PNQ, destination: NCR }, railCard({ volumetricDivisorRail: 3000 }));
    if (!standard.available || !railOwn.available) throw new Error('expected prices');
    // 1,000,000 cm3 over 3,000 rather than over the surface divisor.
    expect(railOwn.breakdown.volumetricWeight).toBe(333.3);
    expect(railOwn.breakdown.volumetricWeight).not.toBe(standard.breakdown.volumetricWeight);
  });

  test('setting rail rules leaves surface and air alone', () => {
    const withRail = railCard({ minWeightRail: 200, volumetricDivisorRail: 3000 });
    for (const mode of ['surface', 'air'] as const) {
      const before = quote({ mode, actualWeight: 10 }, { origin: PNQ, destination: NCR }, card);
      const after = quote({ mode, actualWeight: 10 }, { origin: PNQ, destination: NCR }, withRail);
      if (!before.available || !after.available) throw new Error('expected prices');
      expect(after.breakdown.chargeableWeight).toBe(before.breakdown.chargeableWeight);
    }
  });

  test('NFO keeps taking the air minimum, because it is quoted on the air card', () => {
    const nfo = quote({ mode: 'nfo', actualWeight: 1 }, { origin: PNQ, destination: NCR }, card);
    if (!nfo.available) throw new Error('expected a price');
    expect(nfo.breakdown.chargeableWeight).toBe(card.data.charges.minWeightAir);
  });
});

describe('quote — a rail divisor of zero is an empty field, not a rule', () => {
  test('zero falls back to surface rather than dividing by it', () => {
    const zeroed: RateCard = {
      ...card,
      data: { ...card.data, charges: { ...card.data.charges, volumetricDivisorRail: 0 } },
    };
    const box = { mode: 'rail' as const, actualWeight: 10, length: 100, breadth: 100, height: 100 };
    const result = quote(box, { origin: PNQ, destination: NCR }, zeroed);
    if (!result.available) throw new Error('expected a price');
    expect(Number.isFinite(result.breakdown.volumetricWeight)).toBe(true);
    expect(result.breakdown.volumetricWeight).toBe(
      quote(box, { origin: PNQ, destination: NCR }, card).available
        ? (quote(box, { origin: PNQ, destination: NCR }, card) as { breakdown: { volumetricWeight: number } }).breakdown.volumetricWeight
        : 0,
    );
  });
});

describe('quote — the lane resolution trace', () => {
  test('a base-card quote names the lane, the shape and the layer', () => {
    const result = quote(
      { mode: 'surface', actualWeight: 200 },
      { origin: PNQ, destination: NCR },
      card,
    );

    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.laneProvenance).toEqual({
      layer: 'base',
      negotiated: [],
      trace: 'PNQ → NCR · zone → zone · base',
    });
  });

  test('a negotiated lane says so, and names which rates were negotiated', () => {
    const result = quote(
      { mode: 'surface', actualWeight: 200 },
      { origin: PNQ, destination: NCR },
      card,
      undefined,
      { 'grids.surface.minCharge.PNQ.NCR': 450 },
    );

    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.laneProvenance.layer).toBe('contract');
    expect(result.breakdown.laneProvenance.negotiated).toEqual(['minCharge']);
    expect(result.breakdown.laneProvenance.trace).toBe('PNQ → NCR · zone → zone · contract');
  });

  test('the trace follows the network the mode quotes on, not the mode name', () => {
    // NFO prices over the air card, so its lane is an air lane.
    const result = quote(
      { mode: 'nfo', actualWeight: 200 },
      { origin: PNQ, destination: NCR },
      card,
      undefined,
      { 'grids.air.minCharge.PNQ.NCR': 900 },
    );

    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.laneProvenance.layer).toBe('contract');
  });
});

describe('quote — lane rules price the lane, the grid catches what they miss', () => {
  const PUNE = { ...PNQ, city: 'Pune' };
  const DELHI = { ...NCR, city: 'Delhi' };
  const ask = { mode: 'surface', actualWeight: 200 } as const;

  const ruled = (rule: StoredLaneRule): RateCard => ({
    ...card,
    data: upsertRule(card.data, rule),
  });

  test('an empty rule set quotes identically to no rule set at all', () => {
    const plain = quote(ask, { origin: PNQ, destination: NCR }, card);
    const empty = quote(ask, { origin: PNQ, destination: NCR }, {
      ...card,
      data: { ...card.data, laneRules: {} },
    });

    if (!plain.available || !empty.available) throw new Error('expected available quotes');
    expect(empty.breakdown.total).toBe(plain.breakdown.total);
  });

  test('a city rule prices the lane and names itself in the trace', () => {
    const result = quote({ ...ask }, { origin: PUNE, destination: DELHI }, ruled({
      id: 'r_city',
      mode: 'surface',
      origin: { kind: 'city', value: 'Pune' },
      destination: { kind: 'city', value: 'Delhi' },
      rates: { minCharge: 0, tier1: 21, tier2: 21, tier3: 21 },
    }));

    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.rates.tier1).toBe(21);
    expect(result.breakdown.laneProvenance.trace).toBe('Pune → Delhi · district → district · base');
  });

  test('a rule that does not match leaves the grid in charge', () => {
    const plain = quote(ask, { origin: PUNE, destination: DELHI }, card);
    const result = quote({ ...ask }, { origin: PUNE, destination: DELHI }, ruled({
      id: 'r_elsewhere',
      mode: 'surface',
      origin: { kind: 'city', value: 'Chennai' },
      destination: { kind: 'any' },
      rates: { minCharge: 0, tier1: 99, tier2: 99, tier3: 99 },
    }));

    if (!plain.available || !result.available) throw new Error('expected available quotes');
    expect(result.breakdown.total).toBe(plain.breakdown.total);
    expect(result.breakdown.laneProvenance.trace).toContain('zone → zone');
  });

  test('a rule for another mode never prices this one', () => {
    const plain = quote(ask, { origin: PUNE, destination: DELHI }, card);
    const result = quote({ ...ask }, { origin: PUNE, destination: DELHI }, ruled({
      id: 'r_air_only',
      mode: 'air',
      origin: { kind: 'any' },
      destination: { kind: 'any' },
      rates: { minCharge: 0, tier1: 99, tier2: 99, tier3: 99 },
    }));

    if (!plain.available || !result.available) throw new Error('expected available quotes');
    expect(result.breakdown.total).toBe(plain.breakdown.total);
  });

  test('the NFO multiplier still applies to a rate that came from a rule', () => {
    const result = quote({ mode: 'nfo', actualWeight: 200 }, { origin: PUNE, destination: DELHI }, ruled({
      id: 'r_air',
      mode: 'air',
      origin: { kind: 'city', value: 'Pune' },
      destination: { kind: 'any' },
      rates: { minCharge: 0, tier1: 100, tier2: 100, tier3: 100 },
    }));

    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.rates.tier1).toBe(100 * card.data.charges.nfoMultiplier);
  });

  test('a rule closing a lane makes it unavailable, exactly as a closed grid cell does', () => {
    const result = quote({ ...ask }, { origin: PUNE, destination: DELHI }, ruled({
      id: 'r_closed',
      mode: 'surface',
      origin: { kind: 'city', value: 'Pune' },
      destination: { kind: 'any' },
      rates: { minCharge: null, tier1: null, tier2: null, tier3: null },
    }));

    expect(result.available).toBe(false);
  });
});

describe('quote — a negotiated rule is never displaced by a standard one', () => {
  const PUNE = { ...PNQ, city: 'Pune' };
  const DELHI = { ...NCR, city: 'Delhi' };
  const ask = { mode: 'surface', actualWeight: 200 } as const;

  const standardExact: StoredLaneRule = {
    id: 'r_base',
    mode: 'surface',
    origin: { kind: 'pincode', value: '411001' },
    destination: { kind: 'pincode', value: '110001' },
    rates: { minCharge: 0, tier1: 30, tier2: 30, tier3: 30 },
  };

  const negotiatedBroad: Record<string, StoredLaneRule> = {
    r_contract: {
      id: 'r_contract',
      mode: 'surface',
      origin: { kind: 'city', value: 'Pune' },
      destination: { kind: 'any' },
      rates: { minCharge: 0, tier1: 12, tier2: 12, tier3: 12 },
    },
  };

  test('the contract rule wins even though the base rule is more specific', () => {
    const result = quote(
      ask,
      { origin: PUNE, destination: DELHI },
      { ...card, data: upsertRule(card.data, standardExact) },
      undefined,
      undefined,
      negotiatedBroad,
    );

    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.rates.tier1).toBe(12);
    expect(result.breakdown.laneProvenance.layer).toBe('contract');
  });

  test('the base rule prices it when the customer has negotiated nothing matching', () => {
    const result = quote(
      ask,
      { origin: PUNE, destination: DELHI },
      { ...card, data: upsertRule(card.data, standardExact) },
      undefined,
      undefined,
      {},
    );

    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.rates.tier1).toBe(30);
    expect(result.breakdown.laneProvenance.layer).toBe('base');
  });
});

describe('an offer on a quote', () => {
  const tenPercent = {
    key: 'diwali',
    name: 'Diwali Dispatch Offer',
    kind: 'percent-off-freight' as const,
    value: 10,
    startsAt: new Date('2026-10-01'),
    endsAt: new Date('2026-10-15'),
    audience: { kind: 'product' as const, value: 'ecom' },
    enabled: true,
  };

  const plain = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, card);
  const discounted = quote(
    { mode: 'surface', actualWeight: 200 },
    { origin: PNQ, destination: NCR },
    card,
    undefined,
    undefined,
    undefined,
    [tenPercent],
  );

  test('takes its percentage off the freight', () => {
    if (!plain.available || !discounted.available) throw new Error('expected available quotes');

    expect(discounted.breakdown.freight).toBe(round2(plain.breakdown.freight * 0.9));
  });

  test('fuel follows the discounted freight, not the list price', () => {
    // Fuel is a percentage of freight. Discounting after fuel would charge the customer
    // fuel on money they never spent.
    if (!plain.available || !discounted.available) throw new Error('expected available quotes');

    expect(discounted.breakdown.fuel).toBeLessThan(plain.breakdown.fuel);
  });

  test('the quote says which offer, and what the price was without it', () => {
    // An offer is never written into a contract, so the quote it touched is the only
    // place it can be found afterwards.
    if (!discounted.available) throw new Error('expected an available quote');

    expect(discounted.breakdown.offer?.name).toBe('Diwali Dispatch Offer');
    expect(discounted.breakdown.offer?.freightBeforeOffer).toBe(
      plain.available ? plain.breakdown.freight : 0,
    );
  });

  test('a waiver removes the charge it names and leaves the rest', () => {
    const waiver = {
      ...tenPercent,
      key: 'no-docket',
      name: 'Docket waived',
      kind: 'waive-charge' as const,
      chargeId: 'docket',
    };
    const result = quote(
      { mode: 'surface', actualWeight: 200 },
      { origin: PNQ, destination: NCR },
      card,
      undefined,
      undefined,
      undefined,
      [waiver],
    );

    if (!result.available || !plain.available) throw new Error('expected available quotes');
    expect(result.breakdown.charges.some((charge) => charge.id === 'docket')).toBe(false);
    expect(result.breakdown.freight).toBe(plain.breakdown.freight);
  });

  test('no offers prices exactly as before, which is why no fixture moved', () => {
    const empty = quote(
      { mode: 'surface', actualWeight: 200 },
      { origin: PNQ, destination: NCR },
      card,
      undefined,
      undefined,
      undefined,
      [],
    );

    if (!empty.available || !plain.available) throw new Error('expected available quotes');
    expect(empty.breakdown.total).toBe(plain.breakdown.total);
    expect(empty.breakdown.offer).toBeUndefined();
  });
});
