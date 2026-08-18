import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { quoteUps, upsVolumetricWeight } from './ups';
import { resolveZone, selectRate } from '../domain/ups';
import type { UpsCardData } from '../domain/ups';

/**
 * The UPS card, priced against the agreement it came from.
 *
 * The calculator workbook ships formulas without cached results, so there is nothing to
 * diff against automatically the way the DNS and Bluedart golden suites do. What can be
 * pinned is every rule the agreement and the calculator state in writing — the chargeable
 * weight floor, the half-kilo rounding, the order fuel is applied in, the zone splits —
 * plus one fully worked total that a person has checked in Excel.
 */

const card: UpsCardData = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'ups.json'), 'utf8'),
  ) as { data: { ups: UpsCardData } }
).data.ups;

const quote = (input: Parameters<typeof quoteUps>[0]) => {
  const result = quoteUps(input, card);
  if (!result.available) throw new Error(`expected a price: ${result.reason}`);
  return result.breakdown;
};

describe('the card loaded from the agreement', () => {
  test('carries every zone column the rate grid has', () => {
    expect(card.zoneKeys).toHaveLength(18);
    expect(card.zoneKeys).toContain('Z7SP');
    expect(card.zoneKeys).toContain('Z6SP');
  });

  test('prices the Specials the calculator could not reach', () => {
    // 33 Zone-7 Specials and 3 Zone-6 Specials are unquotable in the calculator's own
    // zone guide. They are in the signed card, so they are priced here.
    expect(card.zones['TT']).toBe('Z7SP'); // Trinidad & Tobago
    expect(card.zones['MV']).toBe('Z6SP'); // Maldives
    expect(quote({ product: 'package', countryCode: 'TT', actualWeight: 5 }).total).toBeGreaterThan(0);
  });

  test('keeps the parameters the contract does not state', () => {
    expect(card.params.fuelRate).toBe(0.4675);
    expect(card.params.gstRate).toBe(0.18);
    expect(card.params.volumetricDivisor).toBe(5000);
    expect(card.params.margin).toBe(0.15);
    expect(card.params.surgeDiscount).toBe(0.45);
  });
});

describe('the worked example', () => {
  /**
   * 10 kg Package to the United Arab Emirates, no dimensions, no accessorials. Zone 1,
   * surge region "UAE & Israel". Checked against the calculator workbook.
   */
  const b = quote({ product: 'package', countryCode: 'AE', actualWeight: 10 });

  test('reaches the zone and surge region the chart gives', () => {
    expect(b.zone).toBe('Z1');
    expect(b.surgeRegion).toBe('UAE & Israel');
  });

  test('freight is the contracted rate plus the margin', () => {
    expect(b.contractRate).toBeCloseTo(3756.6165, 4);
    expect(b.freight).toBeCloseTo(4320.11, 2);
  });

  test('surge is the published rate less the discount, per kg', () => {
    expect(b.surgePerKg).toBeCloseTo(166.1, 2); // 302 less 45%
    expect(b.surge).toBeCloseTo(1661.0, 2);
  });

  test('fuel is charged on freight and surge together', () => {
    expect(b.fuel).toBeCloseTo(2796.17, 2);
  });

  test('the total matches the workbook', () => {
    expect(b.subTotal).toBeCloseTo(8777.28, 2);
    expect(b.gst).toBeCloseTo(1579.91, 2);
    expect(b.total).toBeCloseTo(10357.19, 2);
  });

  test('and it adds up exactly', () => {
    expect(b.subTotal).toBeCloseTo(b.freight + b.surge + b.fuel + b.accessorialsTotal, 6);
    expect(b.total).toBeCloseTo(b.subTotal + b.gst, 6);
  });
});

describe('chargeable weight', () => {
  test('never goes below the half-kilo floor', () => {
    expect(quote({ product: 'package', countryCode: 'AE', actualWeight: 0.1 }).chargeableWeight).toBe(0.5);
  });

  test('takes the volumetric weight when it is greater', () => {
    // 40 x 30 x 20 / 5000 = 4.8 kg against an actual of 1 kg.
    const b = quote({
      product: 'package', countryCode: 'AE', actualWeight: 1,
      length: 40, breadth: 30, height: 20,
    });
    expect(b.volumetricWeight).toBe(4.8);
    expect(b.chargeableWeight).toBe(4.8);
  });

  test('ignores dimensions unless all three are given', () => {
    expect(upsVolumetricWeight({ length: 40, breadth: 30 }, 5000)).toBe(0);
    expect(upsVolumetricWeight({ length: 40, breadth: 30, height: 0 }, 5000)).toBe(0);
  });

  test('volumetric is rounded to two decimals, as the calculator rounds it', () => {
    expect(upsVolumetricWeight({ length: 33, breadth: 17, height: 11 }, 5000)).toBe(1.23);
  });
});

describe('the weight step', () => {
  test('any fraction over a step takes the next higher rate', () => {
    // Term 4 of the agreement. 4.2 kg is billed at the 4.5 kg step.
    const b = quote({ product: 'package', countryCode: 'AE', actualWeight: 4.2 });
    expect(b.rateBasis).toBe('4.5 kg step');
  });

  test('a weight exactly on a step uses that step, not the next', () => {
    expect(quote({ product: 'package', countryCode: 'AE', actualWeight: 4.5 }).rateBasis).toBe(
      '4.5 kg step',
    );
  });

  test('past 20 kg a package moves onto the per-kg bands', () => {
    const b = quote({ product: 'package', countryCode: 'AE', actualWeight: 30 });
    expect(b.rateBasis).toBe('21-44 kgs (per kg)');
    // Per kg, so the freight scales with the weight rather than being flat.
    const heavier = quote({ product: 'package', countryCode: 'AE', actualWeight: 40 });
    expect(heavier.freight).toBeGreaterThan(b.freight);
  });

  test('the heaviest band has no upper limit', () => {
    expect(quote({ product: 'package', countryCode: 'AE', actualWeight: 5000 }).rateBasis).toBe(
      '1000 kgs+ (per kg)',
    );
  });

  test('a document is priced to 5 kg and refuses beyond it', () => {
    expect(quote({ product: 'document', countryCode: 'AE', actualWeight: 5 }).rateBasis).toBe('5 kg step');
    const over = quoteUps({ product: 'document', countryCode: 'AE', actualWeight: 6 }, card);
    expect(over.available).toBe(false);
    if (!over.available) expect(over.reason).toBe('above-product-limit');
  });

  test('an envelope is one flat price whatever it weighs', () => {
    const light = quote({ product: 'envelope', countryCode: 'AE', actualWeight: 0.1 });
    const heavy = quote({ product: 'envelope', countryCode: 'AE', actualWeight: 3 });
    expect(light.freight).toBe(heavy.freight);
    expect(light.rateBasis).toBe('flat');
  });
});

describe('the destination', () => {
  test('China cannot be priced without a postal code', () => {
    // Its ranges span Zone 3 and Zone 9, so picking either blind would invent a price.
    const result = quoteUps({ product: 'package', countryCode: 'CN', actualWeight: 5 }, card);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('postal-code-required');
  });

  test('a Chinese postal code lands in the range the card lists', () => {
    expect(resolveZone(card, 'CN', '200000')).toMatchObject({ ok: true, zone: 'Z3' });
    expect(resolveZone(card, 'CN', '350000')).toMatchObject({ ok: true, zone: 'Z9' });
  });

  test('a Chinese postal code in no published range is refused, not defaulted', () => {
    expect(resolveZone(card, 'CN', '900000')).toMatchObject({ ok: false, reason: 'not-served' });
  });

  test('Yemen is on the chart with no zone, and is refused', () => {
    expect(card.unserved).toContain('YE');
    expect(resolveZone(card, 'YE')).toMatchObject({ ok: false, reason: 'not-served' });
  });

  test('a country not on the chart at all is refused', () => {
    expect(resolveZone(card, 'ZZZ')).toMatchObject({ ok: false, reason: 'unknown-country' });
  });

  test('the surge region is not the rate zone', () => {
    // Great Britain prices in Zone 4 but surges as Europe: two different groupings, and
    // conflating them is the mistake this test exists to catch.
    const b = quote({ product: 'package', countryCode: 'GB', actualWeight: 5 });
    expect(b.zone).toBe('Z4');
    expect(b.surgeRegion).toBe('Europe');
  });

  test('a destination with no region falls back rather than pricing surge at zero', () => {
    const where = resolveZone(card, 'TT');
    expect(where).toMatchObject({ ok: true, surgeRegion: card.defaultSurgeRegion });
    expect(quote({ product: 'package', countryCode: 'TT', actualWeight: 5 }).surge).toBeGreaterThan(0);
  });
});

describe('accessorials', () => {
  test('none apply unless asked for', () => {
    expect(quote({ product: 'package', countryCode: 'AE', actualWeight: 5 }).accessorials).toEqual([]);
  });

  test('a fully waived charge is billed at nothing, and still shown', () => {
    const b = quote({
      product: 'package', countryCode: 'AE', actualWeight: 5,
      accessorials: ['additional-handling-charge'],
    });
    const line = b.accessorials.find((c) => c.id === 'additional-handling-charge');
    expect(line?.gross).toBe(1350);
    expect(line?.waiver).toBe(1);
    expect(line?.amount).toBe(0);
  });

  test('a half-waived charge bills half', () => {
    const b = quote({
      product: 'package', countryCode: 'AE', actualWeight: 5,
      accessorials: ['residential-delivery-surcharge'],
    });
    const line = b.accessorials.find((c) => c.id === 'residential-delivery-surcharge');
    expect(line?.gross).toBe(239);
    expect(line?.amount).toBeCloseTo(119.5, 2);
  });

  test('a per-kg charge takes the greater of its minimum and the weight', () => {
    // Remote area: 3,116 minimum or 57/kg. At 5 kg the minimum wins; at 100 kg it does not.
    const light = quote({
      product: 'package', countryCode: 'AE', actualWeight: 5,
      accessorials: ['remote-area-surcharge'],
    });
    const heavy = quote({
      product: 'package', countryCode: 'AE', actualWeight: 100,
      accessorials: ['remote-area-surcharge'],
    });
    expect(light.accessorials[0]?.gross).toBe(3116);
    expect(heavy.accessorials[0]?.gross).toBe(5700);
  });

  test('fuel is not charged on accessorials', () => {
    const without = quote({ product: 'package', countryCode: 'AE', actualWeight: 5 });
    const with_ = quote({
      product: 'package', countryCode: 'AE', actualWeight: 5,
      accessorials: ['high-value-cargo-export-clearance'],
    });
    expect(with_.fuel).toBe(without.fuel);
    expect(with_.subTotal).toBeCloseTo(without.subTotal + with_.accessorialsTotal, 6);
  });

  test('GST is charged on the accessorials, being part of the sub-total', () => {
    const b = quote({
      product: 'package', countryCode: 'AE', actualWeight: 5,
      accessorials: ['high-value-cargo-export-clearance'],
    });
    expect(b.gst).toBeCloseTo(b.subTotal * 0.18, 2);
  });
});

describe('every quote adds up', () => {
  test('across products, destinations and weights, to the paisa', () => {
    const off: string[] = [];
    for (const country of ['AE', 'US', 'GB', 'DE', 'SG', 'AU', 'TT', 'MV', 'SA']) {
      for (const weight of [0.3, 0.5, 1, 2.7, 5, 12.5, 20, 21, 70, 250, 1200]) {
        for (const product of ['envelope', 'document', 'package'] as const) {
          const result = quoteUps({ product, countryCode: country, actualWeight: weight }, card);
          if (!result.available) continue;
          const b = result.breakdown;
          const parts = b.freight + b.surge + b.fuel + b.accessorialsTotal;
          if (Math.abs(parts - b.subTotal) > 1e-6) off.push(`${country}/${product}/${weight} sub-total`);
          if (Math.abs(b.subTotal + b.gst - b.total) > 1e-6) off.push(`${country}/${product}/${weight} total`);
        }
      }
    }
    expect(off).toEqual([]);
  });
});
