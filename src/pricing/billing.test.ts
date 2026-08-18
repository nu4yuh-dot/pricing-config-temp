import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { quote } from './quote';
import type { Pincode, RateCard } from '../domain/types';

const card: RateCard = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'model-1.json'), 'utf8'),
);

const zone = (z: string): Pincode['surface'] => ({
  serviceable: true,
  hub: z,
  zone: z,
  edlKm: 0,
  oda: false,
  odaCategory: 'Non-ODA',
});

const PNQ: Pincode = {
  pincode: 411001,
  area: 'Pune',
  state: 'Maharashtra',
  air: zone('PNQ'),
  surface: zone('PNQ'),
  rail: { ...zone('PNQ'), station: 'Pune' },
};
const NCR: Pincode = {
  pincode: 110001,
  area: 'New Delhi',
  state: 'Delhi',
  air: zone('NCR'),
  surface: zone('NCR'),
  rail: { ...zone('NCR'), station: 'Delhi' },
};

const shipment = { mode: 'surface' as const, actualWeight: 200 };
const ends = { origin: PNQ, destination: NCR };

describe('GST on the quote', () => {
  test('is charged by default, matching the known golden total', () => {
    const result = quote(shipment, ends, card);
    if (!result.available) throw new Error('expected a quote');
    expect(result.breakdown.gst).toBe(247.5);
    expect(result.breakdown.total).toBe(5197.5);
  });

  test('is charged for a normal forward-charge customer', () => {
    const result = quote(shipment, ends, card, {
      billingType: 'FORWARD',
      gstApplicable: true,
    });
    if (!result.available) throw new Error('expected a quote');
    expect(result.breakdown.gst).toBe(247.5);
  });
});

describe('reverse charge (RCM)', () => {
  const result = quote(shipment, ends, card, { billingType: 'RCM', gstApplicable: true });

  test('does not add GST, because the customer accounts for it', () => {
    if (!result.available) throw new Error('expected a quote');
    expect(result.breakdown.gst).toBe(0);
  });

  test('makes the total equal the pre-GST sub-total', () => {
    if (!result.available) throw new Error('expected a quote');
    expect(result.breakdown.total).toBe(result.breakdown.subTotal);
    expect(result.breakdown.total).toBe(4950);
  });

  test('says why GST is absent, so a quote is never silently cheaper', () => {
    if (!result.available) throw new Error('expected a quote');
    expect(result.breakdown.gstNote).toMatch(/reverse charge/i);
  });

  test('leaves every other line untouched', () => {
    const plain = quote(shipment, ends, card);
    if (!result.available || !plain.available) throw new Error('expected quotes');
    expect(result.breakdown.freight).toBe(plain.breakdown.freight);
    expect(result.breakdown.fuel).toBe(plain.breakdown.fuel);
    expect(result.breakdown.subTotal).toBe(plain.breakdown.subTotal);
  });
});

describe('GST not applicable at all', () => {
  const result = quote(shipment, ends, card, { billingType: 'FORWARD', gstApplicable: false });

  test('adds no GST', () => {
    if (!result.available) throw new Error('expected a quote');
    expect(result.breakdown.gst).toBe(0);
    expect(result.breakdown.total).toBe(4950);
  });

  test('gives a different reason from reverse charge', () => {
    if (!result.available) throw new Error('expected a quote');
    expect(result.breakdown.gstNote).toMatch(/not applicable/i);
    expect(result.breakdown.gstNote).not.toMatch(/reverse charge/i);
  });
});

describe('a normal quote', () => {
  test('carries no GST note, since nothing needs explaining', () => {
    const result = quote(shipment, ends, card);
    if (!result.available) throw new Error('expected a quote');
    expect(result.breakdown.gstNote).toBeUndefined();
  });
});
