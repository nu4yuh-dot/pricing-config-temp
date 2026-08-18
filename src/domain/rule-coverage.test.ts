import { describe, test, expect } from 'vitest';
import { coverageOf } from './rule-coverage';
import type { Pincode } from './types';

function at(pincode: number, city: string, state: string, zone: string): Pincode {
  const mode = {
    serviceable: true,
    hub: zone,
    zone,
    edlKm: 0,
    oda: false,
    odaCategory: 'Non-ODA',
  };
  return {
    pincode,
    area: 'PO',
    state,
    city,
    air: mode,
    surface: mode,
    rail: { ...mode, station: zone },
  } as Pincode;
}

const MASTER = [
  at(411001, 'Pune', 'Maharashtra', 'PNQ'),
  at(411045, 'Pune', 'Maharashtra', 'PNQ'),
  at(400001, 'Mumbai', 'Maharashtra', 'BOM'),
  at(560001, 'Bangalore', 'Karnataka', 'BLR'),
];

describe('what an endpoint covers', () => {
  test('a state covers every pincode in it, grouped by city', () => {
    const c = coverageOf({ kind: 'state', value: 'Maharashtra' }, MASTER, 'surface');

    expect(c.pincodes).toBe(3);
    expect(c.cities.map((x) => x.city).sort()).toEqual(['Mumbai', 'Pune']);
    expect(c.cities.find((x) => x.city === 'Pune')?.pincodes).toEqual([411001, 411045]);
  });

  test('the biggest city is listed first, because that is what the number is about', () => {
    const c = coverageOf({ kind: 'state', value: 'Maharashtra' }, MASTER, 'surface');
    expect(c.cities[0]?.city).toBe('Pune');
  });

  test('a single pincode covers exactly itself', () => {
    expect(coverageOf({ kind: 'pincode', value: '411001' }, MASTER, 'surface').pincodes).toBe(1);
  });

  test('pan-India covers the whole master', () => {
    expect(coverageOf({ kind: 'any' }, MASTER, 'surface').pincodes).toBe(4);
  });

  test('an endpoint matching nothing covers nothing rather than everything', () => {
    const c = coverageOf({ kind: 'city', value: 'Nowhere' }, MASTER, 'surface');

    expect(c.pincodes).toBe(0);
    expect(c.cities).toEqual([]);
  });

  test('coverage is read per mode, so a zone can cover different pincodes on air', () => {
    const split = [
      { ...at(421302, 'Thane', 'Maharashtra', 'BOM'), air: { ...at(421302, 'Thane', 'Maharashtra', 'PNQ').air } },
    ] as Pincode[];

    expect(coverageOf({ kind: 'zone', value: 'BOM' }, split, 'surface').pincodes).toBe(1);
    expect(coverageOf({ kind: 'zone', value: 'BOM' }, split, 'air').pincodes).toBe(0);
  });

  test('a pincode with no city is grouped rather than dropped from the count', () => {
    const noCity = [{ ...at(411001, '', 'Maharashtra', 'PNQ'), city: undefined }] as Pincode[];
    const c = coverageOf({ kind: 'any' }, noCity, 'surface');

    expect(c.pincodes).toBe(1);
    expect(c.cities[0]?.city).toBe('Unknown city');
  });
});
