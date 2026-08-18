import { describe, test, expect } from 'vitest';
import { toPaise as P, toRupees as R } from '../pricing/money';
import {
  offerApplies,
  offerWindow,
  applicableOffers,
  freightDiscount,
  resolveOffers,
  type Offer,
} from './offers';

const diwali: Offer = {
  key: 'diwali',
  name: 'Diwali Dispatch Offer',
  kind: 'percent-off-freight',
  value: 10,
  startsAt: new Date('2026-10-01T00:00:00Z'),
  endsAt: new Date('2026-10-15T23:59:59Z'),
  audience: { kind: 'product', value: 'ecom' },
  enabled: true,
};

describe('when an offer is live', () => {
  test('before it starts it is scheduled, not applied', () => {
    expect(offerWindow(diwali, new Date('2026-09-30T12:00:00Z'))).toBe('scheduled');
  });

  test('it is live on the last day, not until the last day', () => {
    // "1–15 Oct" means through the 15th. An offer that stopped at midnight on the 15th
    // would end a day early and nobody would notice until a customer did.
    expect(offerWindow(diwali, new Date('2026-10-15T18:00:00Z'))).toBe('active');
  });

  test('after it ends it reverts on its own, with nothing to undo', () => {
    expect(offerWindow(diwali, new Date('2026-10-16T00:00:01Z'))).toBe('expired');
  });
});

describe('who an offer reaches', () => {
  const at = new Date('2026-10-05T10:00:00Z');

  test('a product offer reaches the customers on that product', () => {
    expect(offerApplies(diwali, { at, productKey: 'ecom' })).toBe(true);
    expect(offerApplies(diwali, { at, productKey: 'msme' })).toBe(false);
  });

  test('a segment offer reads the customer’s tags, case-insensitively', () => {
    const offer: Offer = { ...diwali, audience: { kind: 'segment', value: 'Ecom' } };

    expect(offerApplies(offer, { at, tags: ['ecom'] })).toBe(true);
    expect(offerApplies(offer, { at, tags: ['MSME'] })).toBe(false);
  });

  test('a customer offer matches that customer only', () => {
    const offer: Offer = { ...diwali, audience: { kind: 'customer', value: 'MAHLE' } };

    expect(offerApplies(offer, { at, customerCode: 'mahle' })).toBe(true);
    expect(offerApplies(offer, { at, customerCode: 'ACME' })).toBe(false);
  });

  test('a suspended offer reaches nobody, and keeps its dates', () => {
    expect(offerApplies({ ...diwali, enabled: false }, { at, productKey: 'ecom' })).toBe(false);
  });

  test('a quote with no customer matches no product or segment offer', () => {
    expect(applicableOffers([diwali], { at })).toEqual([]);
  });
});

describe('what an offer takes off', () => {
  test('a percentage comes off the freight', () => {
    expect(R(freightDiscount(diwali, P(60)))).toBe(6);
  });

  test('a flat amount never exceeds the freight itself', () => {
    // Freight is not going negative to honour a ₹500 discount on a ₹60 parcel.
    const flat: Offer = { ...diwali, kind: 'amount-off-freight', value: 500 };
    expect(R(freightDiscount(flat, P(60)))).toBe(60);
  });

  test('a waiver takes nothing off the freight', () => {
    const waiver: Offer = { ...diwali, kind: 'waive-charge', chargeId: 'docket', value: 0 };
    expect(freightDiscount(waiver, P(60))).toBe(0);
  });
});

describe('two offers at once', () => {
  const fifteen: Offer = { ...diwali, key: 'flash', name: 'Flash', value: 15 };

  test('freight offers do not stack — the best single one wins', () => {
    // Two overlapping campaigns is an ordinary scheduling accident. Stacking them would
    // sell at 23.5% off, which is a number nobody chose.
    const resolved = resolveOffers([diwali, fifteen], P(100));

    expect(resolved.freightOffer?.key).toBe('flash');
    expect(R(resolved.discount)).toBe(15);
  });

  test('the one that lost is reported, not silently dropped', () => {
    const resolved = resolveOffers([diwali, fifteen], P(100));

    expect(resolved.passedOver.map((entry) => entry.offer.key)).toEqual(['diwali']);
  });

  test('waiving two different charges is two things, and both hold', () => {
    const cod: Offer = { ...diwali, key: 'cod', kind: 'waive-charge', chargeId: 'cod-collection' };
    const docket: Offer = { ...diwali, key: 'dock', kind: 'waive-charge', chargeId: 'docket' };

    expect(resolveOffers([cod, docket], P(100)).waivers.map((w) => w.chargeId)).toEqual([
      'cod-collection',
      'docket',
    ]);
  });

  test('waiving the same charge twice takes it off once', () => {
    const a: Offer = { ...diwali, key: 'a', kind: 'waive-charge', chargeId: 'docket' };
    const b: Offer = { ...diwali, key: 'b', kind: 'waive-charge', chargeId: 'docket' };
    const resolved = resolveOffers([a, b], P(100));

    expect(resolved.waivers).toHaveLength(1);
    expect(resolved.passedOver[0]?.because).toContain('already waived');
  });

  test('a waiver and a freight discount are different levers, and both apply', () => {
    const waiver: Offer = { ...diwali, key: 'w', kind: 'waive-charge', chargeId: 'docket' };
    const resolved = resolveOffers([diwali, waiver], P(100));

    expect(R(resolved.discount)).toBe(10);
    expect(resolved.waivers).toHaveLength(1);
  });
});
