import { describe, expect, test } from 'vitest';
import { quoteFtl, VEHICLE_TYPES, vehicleByCode } from './ftl';
import type { Pincode, RateCardData } from '../domain/types';

/**
 * Full-truck-load pricing.
 *
 * FTL is not the partload engine with a bigger number in it. A truck is hired whole, so
 * there are no weight tiers, no chargeable weight and no minimum charge — the price is a
 * figure per vehicle per lane, exactly as A Raymond's contract states it (Pune→Bangalore
 * ₹33,000, Pune→Chennai ₹38,000).
 *
 * Everything after freight is shared with the partload engine: the same fuel base, the same
 * charge menu, the same tax treatment — FTL's own, at 12% with input tax credit.
 */

const zoneAt = (zone: string, pincode: number): Pincode => ({
  pincode,
  area: zone,
  state: '',
  air: { serviceable: true, hub: zone, zone, edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  surface: { serviceable: true, hub: zone, zone, edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  rail: { serviceable: true, hub: zone, station: zone, zone, edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
});

const PNQ = zoneAt('PNQ', 411001);
const BLR = zoneAt('BLR', 560001);
const MAA = zoneAt('MAA', 600001);

const data = {
  charges: { docket: 100, fuelSurface: 0, fuelFtl: 0, gstSurface: 0.05 },
  pickupDelivery: {},
  chargeCatalog: {},
  ftl: {
    rates: {
      '32FT_SXL': { PNQ: { BLR: 33000, MAA: 38000 } },
      '22FT': { PNQ: { BLR: 26000, MAA: null } },
    },
  },
} as unknown as RateCardData;

describe('the vehicle list', () => {
  test('covers the range actually hired, smallest to largest', () => {
    expect(VEHICLE_TYPES[0]?.capacityKg).toBeLessThan(1000);
    expect(VEHICLE_TYPES[VEHICLE_TYPES.length - 1]?.capacityKg).toBeGreaterThan(20000);
  });

  test('is ordered by capacity, so a bigger truck is never cheaper by accident', () => {
    const capacities = VEHICLE_TYPES.map((vehicle) => vehicle.capacityKg);
    expect([...capacities].sort((a, b) => a - b)).toEqual(capacities);
  });

  test('every vehicle has a code, a name and a capacity', () => {
    for (const vehicle of VEHICLE_TYPES) {
      expect(vehicle.code).toMatch(/^[A-Z0-9_]+$/);
      expect(vehicle.label.length).toBeGreaterThan(2);
      expect(vehicle.capacityKg).toBeGreaterThan(0);
    }
  });

  test('a vehicle can be looked up by code', () => {
    expect(vehicleByCode('32FT_SXL')?.label).toMatch(/32/);
    expect(vehicleByCode('nonsense')).toBeUndefined();
  });
});

describe('quoteFtl', () => {
  const ask = (vehicle: string, from = PNQ, to = BLR) =>
    quoteFtl({ vehicle }, { origin: from, destination: to }, data);

  test('prices the lane at the figure contracted for that vehicle', () => {
    const result = ask('32FT_SXL');
    if (!result.available) throw new Error(result.message);
    expect(result.breakdown.freight).toBe(33000);
  });

  test('a different vehicle on the same lane is a different price', () => {
    const big = ask('32FT_SXL');
    const small = ask('22FT');
    if (!big.available || !small.available) throw new Error('expected both to price');
    expect(small.breakdown.freight).toBe(26000);
  });

  test('a different lane is a different price', () => {
    const result = ask('32FT_SXL', PNQ, MAA);
    if (!result.available) throw new Error(result.message);
    expect(result.breakdown.freight).toBe(38000);
  });

  test('reports the vehicle it priced, since the figure is meaningless without it', () => {
    const result = ask('32FT_SXL');
    if (!result.available) throw new Error(result.message);
    expect(result.breakdown.vehicle.code).toBe('32FT_SXL');
    expect(result.breakdown.vehicle.capacityKg).toBeGreaterThan(0);
  });

  test('there is no chargeable weight, because the truck is hired whole', () => {
    const result = ask('32FT_SXL');
    if (!result.available) throw new Error(result.message);
    expect(result.breakdown).not.toHaveProperty('chargeableWeight');
  });

  test('a vehicle the lane is not rated for is unavailable, with the reason', () => {
    const result = ask('22FT', PNQ, MAA);
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe('vehicle-not-rated-on-lane');
    expect(result.message).toMatch(/22/);
    expect(result.message).toMatch(/PNQ/);
  });

  test('an unknown vehicle is rejected rather than priced as something else', () => {
    const result = ask('SPACESHIP');
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe('unknown-vehicle');
  });

  test('an unknown pincode cannot be priced', () => {
    const result = quoteFtl({ vehicle: '32FT_SXL' }, { origin: null, destination: BLR }, data);
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe('unknown-origin-pincode');
  });

  test('a card with no FTL rates says so, rather than quoting zero', () => {
    const result = quoteFtl(
      { vehicle: '32FT_SXL' },
      { origin: PNQ, destination: BLR },
      { ...data, ftl: undefined } as unknown as RateCardData,
    );
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe('ftl-not-offered');
  });
});

describe('FTL is settled like everything else', () => {
  const withCharges = {
    ...data,
    charges: { ...data.charges, fuelFtl: 0.1 },
    chargeCatalog: {
      docket: { name: 'Docket', basis: 'per-shipment', amount: 100, gstApplies: 'Yes', active: 'Yes' },
    },
  } as unknown as RateCardData;

  const priced = () => {
    const result = quoteFtl({ vehicle: '32FT_SXL' }, { origin: PNQ, destination: BLR }, withCharges);
    if (!result.available) throw new Error(result.message);
    return result.breakdown;
  };

  test('FTL carries its own GST rate and SAC, not surface freight’s', () => {
    expect(priced().tax.gstRate).toBe(0.12);
    expect(priced().tax.sac).toBe('9965');
    expect(priced().tax.itc).toBe(true);
  });

  test('fuel is charged at the FTL rate on the FTL freight', () => {
    expect(priced().fuel).toBe(3300);
  });

  test('the charge menu applies, and the total adds up', () => {
    const b = priced();
    expect(b.charges.map((charge) => charge.id)).toEqual(['docket']);
    // 33000 + fuel 3300 + docket 100
    expect(b.subTotal).toBe(36400);
    expect(b.gst).toBe(4368);
    expect(b.total).toBe(40768);
  });

  test('a customer outside GST is not charged it', () => {
    const result = quoteFtl(
      { vehicle: '32FT_SXL' },
      { origin: PNQ, destination: BLR },
      withCharges,
      { billingType: 'FORWARD', gstApplicable: false },
    );
    if (!result.available) throw new Error(result.message);
    expect(result.breakdown.gst).toBe(0);
    expect(result.breakdown.gstNote).toMatch(/not applicable/i);
  });

  test('a card can put FTL under reverse charge', () => {
    const rcm = {
      ...withCharges,
      modeTax: { ftl: { rcm: 'Yes' } },
    } as unknown as RateCardData;
    const result = quoteFtl({ vehicle: '32FT_SXL' }, { origin: PNQ, destination: BLR }, rcm);
    if (!result.available) throw new Error(result.message);
    expect(result.breakdown.gst).toBe(0);
    expect(result.breakdown.gstNote).toMatch(/reverse charge/i);
  });
});
