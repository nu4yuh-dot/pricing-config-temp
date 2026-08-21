import { describe, expect, test } from 'vitest';
import { toLegacyPincode, toLegacyCities, toLegacyCustomerMaster } from './legacy-shapes';
import type { Pincode } from '../domain/types';
import type { CustomerDoc } from '../data/customers';
import { ObjectId } from 'mongodb';

const mode = (over = {}) => ({
  serviceable: true,
  hub: 'BOM',
  zone: 'BOM',
  edlKm: 0,
  oda: false,
  odaCategory: 'Non-ODA',
  ...over,
});

const pincode = (over: Partial<Pincode> = {}): Pincode =>
  ({
    pincode: 400001,
    area: 'Mumbai GPO',
    state: 'Maharashtra',
    air: mode({ hub: 'Mumbai' }),
    surface: mode(),
    rail: { ...mode(), station: 'CSTM' },
    ...over,
  }) as Pincode;

describe('a pincode in the shape their code reads', () => {
  test('every field their model declares is present', () => {
    // Their consumers destructure this document; a missing key reads as undefined and
    // ends up on a docket.
    const legacy = toLegacyPincode(pincode());
    for (const field of [
      'pincode', 'locality', 'state', 'district', 'citySection', 'lat', 'lon', 'hub',
      'airport', 'aptDistKm', 'aptCategory', 'aptScope', 'cargoHub', 'cargoDistKm',
      'majorArpt', 'serviceZone', 'oda', 'odaStatus', 'odaSlab', 'zone', 'lane',
      'deliverySla', 'routeType', 'hubSpoke', 'cod', 'reversePickup', 'connScore',
    ]) {
      expect(legacy).toHaveProperty(field);
    }
  });

  test('the pincode is a zero-padded string, as theirs is', () => {
    // Ours is a number. A Kerala pincode starting 6 is fine; one starting 0 would arrive
    // as five digits and match nothing on their side.
    expect(toLegacyPincode(pincode({ pincode: 682001 })).pincode).toBe('682001');
    expect(toLegacyPincode(pincode({ pincode: 110001 })).pincode).toBe('110001');
  });

  test('hub and state are right, because those are what their code actually reads', () => {
    const legacy = toLegacyPincode(pincode());
    expect(legacy.hub).toBe('BOM');
    expect(legacy.state).toBe('Maharashtra');
  });

  test('ODA is their Y/N flag, not our boolean', () => {
    expect(toLegacyPincode(pincode()).oda).toBe('N');
    expect(toLegacyPincode(pincode({ surface: mode({ oda: true }) as never })).oda).toBe('Y');
  });

  test('connScore is zero rather than a plausible number', () => {
    // It is computed from hub and network data we have never held. A number here would
    // read as fact and price nothing.
    expect(toLegacyPincode(pincode()).connScore).toBe(0);
  });

  test('the SLA is a sentence when we know transit, and blank when we do not', () => {
    expect(toLegacyPincode(pincode(), 5).deliverySla).toBe('5 days');
    expect(toLegacyPincode(pincode(), 1).deliverySla).toBe('1 day');
    expect(toLegacyPincode(pincode(), null).deliverySla).toBe('');
  });
});

describe('the customer master in their shape', () => {
  const customer = (over: Partial<CustomerDoc> = {}): CustomerDoc =>
    ({
      _id: new ObjectId(),
      code: 'RL-001',
      name: 'Reliance Logistics',
      baseCardKey: 'model-1',
      liveTerms: { overrides: {}, scope: {} },
      draftTerms: { overrides: {}, scope: {} },
      ...over,
    }) as CustomerDoc;

  test('an unset billing field reads "Not configured", exactly as their endpoint says', () => {
    // Their portal renders this string. An empty one would show a blank where their own
    // system showed a sentence.
    const master = toLegacyCustomerMaster(customer());
    expect(master.billingCycle).toBe('Not configured');
    expect(master.billingBasis).toBe('Not configured');
    expect(master.gstTreatment).toBe('Not configured');
    expect(master.creditPeriod).toBe('Not configured');
  });

  test('configured values come through as stored', () => {
    const master = toLegacyCustomerMaster(
      customer({
        enterprise: {
          team: [], addresses: [], departments: [],
          billing: {
            tier: 'ENTERPRISE',
            cycle: '1st → Last Day Monthly',
            basis: 'POD Verified',
            gstTreatment: '18% IGST Interstate',
            creditPeriod: '45 Days',
          },
        },
      } as Partial<CustomerDoc>),
    );
    expect(master.tier).toBe('ENTERPRISE');
    expect(master.billingCycle).toBe('1st → Last Day Monthly');
    expect(master.billingBasis).toBe('POD Verified');
    expect(master.creditPeriod).toBe('45 Days');
  });

  test('custId is our customer code — the key both systems agree on', () => {
    expect(toLegacyCustomerMaster(customer()).custId).toBe('RL-001');
  });
});

describe('cities derived from the pincode master', () => {
  const withCity = (name: string | undefined, pin: number, hub = 'BOM') =>
    pincode({ pincode: pin, city: name, surface: mode({ hub, zone: hub }) as never });

  test('a city is named once, with the prefixes that find it', () => {
    const cities = toLegacyCities([
      withCity('Mumbai', 400001),
      withCity('Mumbai', 400002),
      withCity('Mumbai', 401101),
    ]);
    expect(cities).toHaveLength(1);
    expect(cities[0]?.cityName).toBe('Mumbai');
    expect(cities[0]?.pinCount).toBe(3);
    expect(cities[0]?.prefixes).toEqual(['400', '401']);
  });

  test('a pincode with no city is skipped, not given an invented one', () => {
    // `area` is a post office, not a city. Using it would produce 300 "cities" in
    // Maharashtra alone.
    expect(toLegacyCities([withCity(undefined, 400001)])).toEqual([]);
  });

  test('sorted by hub then city, matching their own query', () => {
    const cities = toLegacyCities([
      withCity('Pune', 411001, 'PNQ'),
      withCity('Mumbai', 400001, 'BOM'),
      withCity('Nashik', 422001, 'BOM'),
    ]);
    expect(cities.map((city) => city.cityName)).toEqual(['Mumbai', 'Nashik', 'Pune']);
  });

  test('city names differing only by case are one city', () => {
    const cities = toLegacyCities([withCity('Mumbai', 400001), withCity('MUMBAI', 400002)]);
    expect(cities).toHaveLength(1);
    expect(cities[0]?.pinCount).toBe(2);
  });
});
