import { describe, test, expect } from 'vitest';
import { searchGeography } from './geo-search';
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
    area: `${city} PO`,
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

describe('searching every level of geography at once', () => {
  test('a bare pincode finds that pincode', () => {
    expect(searchGeography('411001', MASTER, 'surface')[0]).toMatchObject({
      kind: 'pincode',
      value: '411001',
    });
  });

  test('a partial pincode finds every pincode under it', () => {
    const hits = searchGeography('4110', MASTER, 'surface').filter((r) => r.kind === 'pincode');
    expect(hits.map((r) => r.value)).toEqual(['411001', '411045']);
  });

  test('a city name finds the city, and says how many pincodes it holds', () => {
    const city = searchGeography('pune', MASTER, 'surface').find((r) => r.kind === 'city');

    expect(city?.value).toBe('Pune');
    expect(city?.meta).toContain('2 pincodes');
  });

  test('a city holding one pincode is not described in the plural', () => {
    const city = searchGeography('bangalore', MASTER, 'surface').find((r) => r.kind === 'city');
    expect(city?.meta).toContain('1 pincode ');
  });

  test('a state name finds the state', () => {
    expect(searchGeography('mahar', MASTER, 'surface').find((r) => r.kind === 'state')?.value).toBe(
      'Maharashtra',
    );
  });

  test('a zone code finds the zone', () => {
    expect(searchGeography('bom', MASTER, 'surface').find((r) => r.kind === 'zone')?.value).toBe(
      'BOM',
    );
  });

  test('a zone the mode does not run is not offered', () => {
    // JSR is a surface cluster; air runs on twelve hubs and JSR is not one of them.
    expect(searchGeography('jsr', MASTER, 'air').find((r) => r.kind === 'zone')).toBeUndefined();
    expect(searchGeography('jsr', MASTER, 'surface').find((r) => r.kind === 'zone')?.value).toBe(
      'JSR',
    );
  });

  test('"metro" finds the named zone group', () => {
    expect(searchGeography('metro', MASTER, 'surface').find((r) => r.kind === 'group')?.value).toBe(
      'metros',
    );
  });

  test('results come back most specific first', () => {
    // "b" reaches a city and two zones, so the ordering has something to order.
    const kinds = searchGeography('b', MASTER, 'surface').map((r) => r.kind);

    expect(kinds).toContain('city');
    expect(kinds).toContain('zone');
    expect(kinds.indexOf('city')).toBeLessThan(kinds.indexOf('zone'));
  });

  test('an empty query offers pan-India rather than nothing', () => {
    expect(searchGeography('', MASTER, 'surface').map((r) => r.kind)).toContain('any');
  });

  test('a query matching nothing returns nothing', () => {
    expect(searchGeography('zzzz', MASTER, 'surface')).toEqual([]);
  });

  test('the pincode list is capped, because 19,494 of them is not a result list', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      at(411000 + i, 'Pune', 'Maharashtra', 'PNQ'),
    );
    const hits = searchGeography('411', many, 'surface', 5).filter((r) => r.kind === 'pincode');
    expect(hits).toHaveLength(5);
  });
});
