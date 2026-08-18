import { describe, expect, test } from 'vitest';
import { settle } from './settlement';
import { toPaise as P, toRupees as R } from './money';
import {
  DEFAULT_CHARGES,
  DEFAULT_FUEL_BASE,
  FUEL_ON_TOTAL,
  taxProfileFor,
  type ChargeDefinition,
} from '../domain/tax';

const docketOnly: ChargeDefinition[] = [
  {
    id: 'docket',
    name: 'Docket',
    basis: 'per-shipment',
    amount: 100,
    gstApplies: true,
    fuelApplies: false,
    active: true,
  },
];

/**
 * Amounts go in as paise, because that is what the engine works in now. The expectations
 * below stay in rupees on purpose: they are the figures from the workbooks and the signed
 * cards, and reading them through `R()` is the assertion that the boundary converts.
 */
const baseInput = {
  freight: P(2680),
  pickup: P(400),
  delivery: P(800),
  oda: P(0),
  destinationZone: 'NCR',
  chargeableWeight: 200,
  fuelRate: 0.25,
  fuelBase: DEFAULT_FUEL_BASE,
  charges: docketOnly,
};

describe('mode decides the tax, not the customer', () => {
  test('surface is 5% under reverse charge, so nothing is billed', () => {
    const result = settle({ ...baseInput, mode: 'surface' });
    expect(result.tax.gstRate).toBe(0.05);
    expect(result.tax.rcm).toBe(true);
    expect(R(result.gst)).toBe(0);
    expect(result.gstNote).toMatch(/reverse charge/i);
  });

  test('the reverse-charge note states the rate and SAC, because the invoice must', () => {
    const result = settle({ ...baseInput, mode: 'surface' });
    expect(result.gstNote).toMatch(/5%/);
    expect(result.gstNote).toMatch(/9965/);
  });

  test('air is 18% forward charge, so it is billed', () => {
    const result = settle({ ...baseInput, mode: 'air', fuelRate: 0.45 });
    expect(result.tax.gstRate).toBe(0.18);
    expect(result.tax.rcm).toBe(false);
    expect(R(result.gst)).toBeGreaterThan(0);
    expect(result.gstNote).toBeUndefined();
  });

  test('rail is 5% but forward, unlike road', () => {
    const result = settle({ ...baseInput, mode: 'rail', fuelRate: 0 });
    expect(result.tax.gstRate).toBe(0.05);
    expect(result.tax.rcm).toBe(false);
    expect(R(result.gst)).toBeGreaterThan(0);
  });

  test('every mode carries a SAC code for the invoice', () => {
    expect(taxProfileFor('surface').sac).toBe('9965');
    expect(taxProfileFor('air').sac).toBe('9968');
    expect(taxProfileFor('ftl').sac).toBe('9965');
    expect(taxProfileFor('courier').sac).toBe('9968');
  });

  test('FTL is 12% with input tax credit', () => {
    expect(taxProfileFor('ftl').gstRate).toBe(0.12);
    expect(taxProfileFor('ftl').itc).toBe(true);
  });

  test('a rate can be overridden per card without losing the rest of the profile', () => {
    const result = settle({
      ...baseInput,
      mode: 'air',
      taxOverrides: { air: { gstRate: 0.12 } },
    });
    expect(result.tax.gstRate).toBe(0.12);
    expect(result.tax.sac).toBe('9968');
  });
});

describe('customer-level GST suppression sits on top of the mode', () => {
  test('a customer outside GST pays none even on a forward-charge mode', () => {
    const result = settle({ ...baseInput, mode: 'air', gstApplicable: false });
    expect(R(result.gst)).toBe(0);
    expect(result.gstNote).toMatch(/not applicable/i);
  });

  test('reverse charge can be forced on a forward-charge mode', () => {
    const result = settle({ ...baseInput, mode: 'air', forceRcm: true });
    expect(R(result.gst)).toBe(0);
    expect(result.gstNote).toMatch(/reverse charge/i);
  });
});

describe('the fuel base is configurable', () => {
  test('by default fuel is charged on freight alone', () => {
    const result = settle({ ...baseInput, mode: 'surface' });
    expect(R(result.fuelBaseAmount)).toBe(2680);
    expect(R(result.fuel)).toBe(670);
    expect(result.fuelBaseDescription).toBe('freight');
  });

  test('cartage can be brought into the base', () => {
    const result = settle({
      ...baseInput,
      mode: 'surface',
      fuelBase: { ...DEFAULT_FUEL_BASE, pickup: true, delivery: true },
    });
    expect(R(result.fuelBaseAmount)).toBe(3880);
    expect(R(result.fuel)).toBe(970);
  });

  /**
   * A Raymond's real contract: 35% on total charges. The engine could not express
   * this before, so it under-quoted them.
   */
  test('fuel on total includes cartage, ODA and every charge', () => {
    const result = settle({
      ...baseInput,
      mode: 'air',
      oda: P(450),
      fuelRate: 0.35,
      fuelBase: FUEL_ON_TOTAL,
    });
    // 2680 + 400 + 800 + 450 + docket 100
    expect(R(result.fuelBaseAmount)).toBe(4430);
    expect(R(result.fuel)).toBe(1550.5);
    expect(result.fuelBaseDescription).toBe('freight + pickup + delivery + ODA + other charges');
  });

  test('fuel on total does not also charge fuel per charge, which would double it', () => {
    const withFuelCharge: ChargeDefinition[] = [
      { ...docketOnly[0]!, fuelApplies: true },
    ];
    const result = settle({
      ...baseInput,
      mode: 'surface',
      charges: withFuelCharge,
      fuelBase: FUEL_ON_TOTAL,
    });
    // The docket is in the whole-charges base, so it must not also carry its own fuel.
    expect(R(result.charges[0]!.fuel)).toBe(0);
  });

  test('a charge can carry fuel individually when the whole-charges base is off', () => {
    const withFuelCharge: ChargeDefinition[] = [
      { ...docketOnly[0]!, fuelApplies: true },
    ];
    const result = settle({ ...baseInput, mode: 'surface', charges: withFuelCharge });
    expect(R(result.charges[0]!.fuel)).toBe(25);
  });
});

describe('the charge catalog', () => {
  test('an inactive charge contributes nothing', () => {
    const result = settle({
      ...baseInput,
      mode: 'surface',
      charges: [{ ...docketOnly[0]!, active: false }],
    });
    expect(result.charges).toEqual([]);
    expect(R(result.chargesTotal)).toBe(0);
  });

  test('a charge restricted to air does not apply on surface', () => {
    const awb: ChargeDefinition = {
      id: 'awb',
      name: 'AWB',
      basis: 'per-awb',
      amount: 35,
      gstApplies: true,
      fuelApplies: false,
      active: true,
      modes: ['air', 'nfo'],
    };
    expect(settle({ ...baseInput, mode: 'surface', charges: [awb] }).charges).toEqual([]);
    expect(settle({ ...baseInput, mode: 'air', charges: [awb] }).charges).toHaveLength(1);
  });

  test('a per-kg charge scales with chargeable weight', () => {
    const perKg: ChargeDefinition = {
      id: 'x',
      name: 'Per kg fee',
      basis: 'per-kg',
      amount: 2,
      gstApplies: true,
      fuelApplies: false,
      active: true,
    };
    const result = settle({ ...baseInput, mode: 'surface', charges: [perKg] });
    expect(R(result.charges[0]!.amount)).toBe(400);
  });

  /** A Raymond's ESS surcharges vary by destination, not by shipment. */
  test('a per-destination charge picks the amount for that zone', () => {
    const ess: ChargeDefinition = {
      id: 'ess',
      name: 'ESS',
      basis: 'per-destination',
      amount: 0,
      gstApplies: true,
      fuelApplies: false,
      active: true,
      byDestination: { BLR: 3000, CCU: 3000, NCR: 2000 },
    };
    expect(R(settle({ ...baseInput, mode: 'air', charges: [ess] }).charges[0]!.amount)).toBe(2000);
    expect(
      R(
        settle({ ...baseInput, mode: 'air', destinationZone: 'BLR', charges: [ess] }).charges[0]!
          .amount,
      ),
    ).toBe(3000);
  });

  test('a destination with no ESS entry is not charged at all', () => {
    const ess: ChargeDefinition = {
      id: 'ess',
      name: 'ESS',
      basis: 'per-destination',
      amount: 0,
      gstApplies: true,
      fuelApplies: false,
      active: true,
      byDestination: { BLR: 3000 },
    };
    expect(settle({ ...baseInput, mode: 'air', charges: [ess] }).charges).toEqual([]);
  });

  test('an ODA charge takes its amount from the distance calculation', () => {
    const oda: ChargeDefinition = {
      id: 'oda',
      name: 'ODA',
      basis: 'by-pincode',
      amount: 0,
      gstApplies: true,
      fuelApplies: false,
      active: true,
    };
    const result = settle({ ...baseInput, mode: 'surface', oda: P(825), charges: [oda] });
    expect(R(result.charges[0]!.amount)).toBe(825);
  });

  test('a charge outside GST is added after tax, not inside the taxable value', () => {
    const outside: ChargeDefinition = {
      id: 'deposit',
      name: 'Refundable deposit',
      basis: 'per-shipment',
      amount: 500,
      gstApplies: false,
      fuelApplies: false,
      active: true,
    };
    const result = settle({ ...baseInput, mode: 'air', charges: [outside] });
    expect(R(result.chargesOutsideTax)).toBe(500);
    expect(result.taxableValue).toBe(P(2680) + result.fuel + P(400) + P(800));
    expect(result.total).toBe(result.taxableValue + result.gst + P(500));
  });

  test('the shipped default catalog has a docket active and the rest off', () => {
    const active = DEFAULT_CHARGES.filter((c) => c.active).map((c) => c.id);
    expect(active).toEqual(['docket']);
  });
});

describe('ODA is billed, not merely used for fuel', () => {
  test('ODA enters the taxable value and the total', () => {
    const without = settle({ ...baseInput, mode: 'air' });
    const with_ = settle({ ...baseInput, mode: 'air', oda: P(450) });
    expect(with_.taxableValue - without.taxableValue).toBe(P(450));
    expect(with_.total).toBeGreaterThan(without.total);
  });

  /**
   * ODA can arrive twice — once as `input.oda`, once as a `by-pincode` charge that
   * reads the same figure. It must be billed once.
   */
  test('an ODA charge does not bill the same surcharge twice', () => {
    const odaCharge: ChargeDefinition = {
      id: 'oda',
      name: 'ODA',
      basis: 'by-pincode',
      amount: 0,
      gstApplies: true,
      fuelApplies: false,
      active: true,
    };
    const asInput = settle({ ...baseInput, mode: 'air', oda: P(825) });
    const asBoth = settle({ ...baseInput, mode: 'air', oda: P(825), charges: [...docketOnly, odaCharge] });
    expect(asBoth.taxableValue).toBe(asInput.taxableValue);
  });

  test('fuel on total charges fuel on the ODA once, even when it is also a charge', () => {
    const odaCharge: ChargeDefinition = {
      id: 'oda',
      name: 'ODA',
      basis: 'by-pincode',
      amount: 0,
      gstApplies: true,
      fuelApplies: false,
      active: true,
    };
    const result = settle({
      ...baseInput,
      mode: 'air',
      oda: P(450),
      fuelRate: 0.35,
      fuelBase: FUEL_ON_TOTAL,
      charges: [...docketOnly, odaCharge],
    });
    // 2680 + 400 + 800 + 450 + docket 100 — the ODA counted once.
    expect(R(result.fuelBaseAmount)).toBe(4430);
  });
});

describe('the arithmetic holds together', () => {
  test('total is taxable plus GST plus anything outside tax', () => {
    const result = settle({ ...baseInput, mode: 'air', oda: P(450), fuelRate: 0.45 });
    // Integers, so this is an identity rather than an approximation. This assertion is the
    // whole reason the engine works in paise.
    expect(result.total).toBe(result.taxableValue + result.gst + result.chargesOutsideTax);
  });

  test('it reproduces the known surface figure when reverse charge is set aside', () => {
    // freight 2680 + fuel 970 (on freight+cartage) + cartage 1200 + docket 100 = 4950,
    // which is the golden sub-total. Surface is RCM, so nothing is added on top.
    const result = settle({
      ...baseInput,
      mode: 'surface',
      fuelBase: { ...DEFAULT_FUEL_BASE, pickup: true, delivery: true },
    });
    expect(R(result.taxableValue)).toBe(4950);
    expect(R(result.total)).toBe(4950);
  });
});
