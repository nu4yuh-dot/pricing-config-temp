import { describe, test, expect } from 'vitest';
import { priceLockOverrides } from './price-lock';
import type { RateCardData } from './types';

/** A card with two surface lanes and nothing else, which is enough to state every rule. */
const card = {
  grids: {
    surface: {
      minCharge: { PNQ: { NCR: 410, BOM: null } },
      tier1: { PNQ: { NCR: 23, BOM: null } },
      tier2: { PNQ: { NCR: 21, BOM: null } },
      tier3: { PNQ: { NCR: 19, BOM: null } },
    },
    air: { minCharge: {}, tier1: {}, tier2: {}, tier3: {} },
    rail: { minCharge: {}, tier1: {}, tier2: {}, tier3: {} },
  },
} as unknown as RateCardData;

describe('locking today’s prices', () => {
  test('every served rate is pinned at what it is worth today', () => {
    const locked = priceLockOverrides(card, {});

    expect(locked['grids.surface.minCharge.PNQ.NCR']).toBe(410);
    expect(locked['grids.surface.tier1.PNQ.NCR']).toBe(23);
    expect(Object.keys(locked)).toHaveLength(4);
  });

  test('a negotiated cell is left alone — a lock must never overwrite an agreement', () => {
    const locked = priceLockOverrides(card, { 'grids.surface.tier1.PNQ.NCR': 18 });

    expect(locked['grids.surface.tier1.PNQ.NCR']).toBeUndefined();
    expect(locked['grids.surface.minCharge.PNQ.NCR']).toBe(410);
  });

  test('an unserved lane is not frozen shut', () => {
    // Writing null here would read as "not carried" forever, and keep the customer off a
    // lane the network opens later. There is no price to protect, so there is nothing to do.
    expect(priceLockOverrides(card, {})['grids.surface.minCharge.PNQ.BOM']).toBeUndefined();
  });

  test('a null the customer negotiated stays theirs', () => {
    const locked = priceLockOverrides(card, { 'grids.surface.minCharge.PNQ.NCR': null });
    expect(locked['grids.surface.minCharge.PNQ.NCR']).toBeUndefined();
  });
});
