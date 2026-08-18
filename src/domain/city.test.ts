import { describe, test, expect } from 'vitest';
import { cityOf, withCity } from './city';
import type { Pincode } from './types';

function at(pincode: number, district: string, state = 'Maharashtra'): Pincode {
  const mode = {
    serviceable: true,
    hub: 'PNQ',
    zone: 'PNQ',
    edlKm: 0,
    oda: false,
    odaCategory: 'Non-ODA',
  };
  return {
    pincode,
    area: 'Test PO',
    state,
    air: mode,
    surface: mode,
    rail: { ...mode, station: 'PNQ' },
    bluedart: { zone: 'A', odaStatus: 'Non-ODA', edlKm: 0, district },
  } as Pincode;
}

/** The same pincode with no Bluedart block at all, which is how a seeded card may arrive. */
function withoutDistrict(pincode: number): Pincode {
  const base = at(pincode, '');
  delete (base as { bluedart?: unknown }).bluedart;
  return base;
}

describe('city derived from district', () => {
  test('uses the district the Bluedart import carries', () => {
    expect(cityOf(at(411001, 'Pune'))).toBe('Pune');
  });

  test('renames districts the business calls something else', () => {
    expect(cityOf(at(560001, 'Bengaluru Urban', 'Karnataka'))).toBe('Bangalore');
  });

  test('a pincode with no district has no city rather than a wrong one', () => {
    expect(cityOf(withoutDistrict(411001))).toBeUndefined();
  });

  test('a blank district is treated as absent, not as a city called empty', () => {
    expect(cityOf(at(411001, '   '))).toBeUndefined();
  });

  test('withCity fills the field the matcher reads', () => {
    expect(withCity(at(411001, 'Pune')).city).toBe('Pune');
  });

  test('withCity leaves a pincode without a district untouched', () => {
    expect(withCity(withoutDistrict(411001)).city).toBeUndefined();
  });
});
