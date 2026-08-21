import { describe, expect, test } from 'vitest';
import {
  isPriceable,
  unpriceableReason,
  applyCarrierMultiplier,
  type Carrier,
} from './carriers';

const carrier = (over: Partial<Carrier> = {}): Carrier => ({
  carrierId: 'velocity',
  name: 'Velocity',
  active: true,
  rateStructure: 'zoneWeight',
  cardKeys: ['velocity-2026'],
  ...over,
});

describe('whether a carrier can be quoted', () => {
  test('active, with an engine and a card, is priceable', () => {
    expect(isPriceable(carrier())).toBe(true);
    expect(unpriceableReason(carrier())).toBeNull();
  });

  test('switched off is a different problem from having no rates', () => {
    // Three reasons, because they need three different people to act.
    expect(unpriceableReason(carrier({ active: false }))).toMatch(/switched off/);
    expect(unpriceableReason(carrier({ cardKeys: [] }))).toMatch(/no rate card/);
    expect(unpriceableReason(carrier({ rateStructure: 'unsupported' }))).toMatch(/cannot read yet/);
  });

  test('a carrier we have no engine for says so rather than quoting', () => {
    expect(isPriceable(carrier({ rateStructure: 'unsupported' }))).toBe(false);
  });

  test('a known carrier with no tariff loaded yet is a real state', () => {
    // Signed, not yet priceable. Different from inactive, and worth saying differently.
    const signed = carrier({ cardKeys: [] });
    expect(signed.active).toBe(true);
    expect(isPriceable(signed)).toBe(false);
  });
});

describe('the blanket multiplier', () => {
  test('an across-the-board rise applies without reissuing a tariff', () => {
    expect(applyCarrierMultiplier(1000, carrier({ rateMultiplier: 1.04 }))).toBe(1040);
  });

  test('no multiplier means no change', () => {
    expect(applyCarrierMultiplier(2506.9, carrier())).toBe(2506.9);
  });

  test('it rounds to paise rather than carrying a floating-point tail', () => {
    expect(applyCarrierMultiplier(333.33, carrier({ rateMultiplier: 1.04 }))).toBe(346.66);
  });
});
