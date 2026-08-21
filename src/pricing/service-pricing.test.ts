import { describe, expect, test } from 'vitest';
import { quote } from './quote';
import type { RateCard, Pincode } from '../domain/types';
import model1 from '../../data/extracted/model-1.json';

const card = model1 as unknown as RateCard;

const PNQ: Pincode = {
  pincode: 411001,
  area: 'Pune City',
  state: 'Maharashtra',
  air: { serviceable: true, hub: 'Pune', zone: 'PNQ', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  surface: { serviceable: true, hub: 'PNQ', zone: 'PNQ', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  rail: { serviceable: true, hub: 'Pune', station: 'Pune', zone: 'PNQ', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
};

const NCR: Pincode = {
  pincode: 110001,
  area: 'New Delhi GPO',
  state: 'Delhi',
  air: { serviceable: true, hub: 'Delhi-NCR', zone: 'NCR', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  surface: { serviceable: true, hub: 'NCR', zone: 'NCR', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
  rail: { serviceable: true, hub: 'Delhi', station: 'Delhi (Tughlakabad)', zone: 'NCR', edlKm: 0, oda: false, odaCategory: 'Non-ODA' },
};

const lane = { origin: PNQ, destination: NCR };
const priceOf = (input: Parameters<typeof quote>[0]) => {
  const result = quote(input, lane, card);
  if (!result.available) throw new Error('lane unavailable in fixture');
  return result.breakdown;
};

describe('a service prices through its multiplier', () => {
  test('a service at 1 prices exactly as its mode does', () => {
    // The safety property: defining services changes nothing until one differs.
    const plain = priceOf({ mode: 'surface', actualWeight: 200 });
    const viaService = priceOf({
      mode: 'surface',
      actualWeight: 200,
      service: { key: 'surface', mode: 'surface', multiplier: 1 },
    });
    expect(viaService.total).toBe(plain.total);
    expect(viaService.freight).toBe(plain.freight);
  });

  test('an express service multiplies the freight and nothing else about the lane', () => {
    const plain = priceOf({ mode: 'surface', actualWeight: 200 });
    const express = priceOf({
      mode: 'surface',
      actualWeight: 200,
      service: { key: 'surface-express', mode: 'surface', multiplier: 1.15 },
    });
    expect(express.freight).toBeCloseTo(plain.freight * 1.15, 1);
    // Chargeable weight is a property of the consignment, not of what it was sold as.
    expect(express.chargeableWeight).toBe(plain.chargeableWeight);
  });

  test('tax follows the multiplied freight rather than being multiplied itself', () => {
    // Multiplying GST directly would invent tax. It has to fall out of the new subtotal.
    const express = priceOf({
      mode: 'surface',
      actualWeight: 200,
      service: { key: 'surface-express', mode: 'surface', multiplier: 1.15 },
    });
    expect(express.gst).toBeCloseTo(express.subTotal * express.tax.gstRate, 1);
  });

  test('a service rides its own network, not the mode the caller named', () => {
    // Asking for surface while the service rides air must price on the air card, because
    // that is the network the consignment actually moves on.
    const onAir = priceOf({
      mode: 'surface',
      actualWeight: 200,
      service: { key: 'air-console', mode: 'air', multiplier: 1 },
    });
    const plainAir = priceOf({ mode: 'air', actualWeight: 200 });
    expect(onAir.freight).toBe(plainAir.freight);
  });
});

describe('NFO keeps behaving exactly as it did', () => {
  test('with no service given, NFO still takes the card’s own multiplier', () => {
    // NFO was hardcoded as air × the card's nfoMultiplier. A card that tuned that number
    // must keep pricing by it rather than by a default someone assumed.
    const nfo = priceOf({ mode: 'nfo', actualWeight: 200 });
    const air = priceOf({ mode: 'air', actualWeight: 200 });
    expect(nfo.freight).toBeCloseTo(air.freight * card.data.charges.nfoMultiplier, 1);
  });

  test('NFO expressed as a service reproduces the same freight', () => {
    const asMode = priceOf({ mode: 'nfo', actualWeight: 200 });
    const asService = priceOf({
      mode: 'air',
      actualWeight: 200,
      service: { key: 'nfo', mode: 'air', multiplier: card.data.charges.nfoMultiplier },
    });
    expect(asService.freight).toBe(asMode.freight);
  });
});
