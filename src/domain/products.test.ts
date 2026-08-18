import { describe, test, expect } from 'vitest';
import { productTerms, productFitsSegment, summariseProduct, EMPTY_PRODUCT } from './products';
import type { Product } from './products';
import type { RateTemplate } from './templates';
import { UNRESTRICTED_SCOPE } from './customers';

const template = {
  key: 'flat-pan-india',
  name: 'Flat pan-India surface',
  description: '',
  baseCardKey: 'model-3',
  overrides: { 'grids.surface.tier1.PNQ.NCR': 25 },
  scope: UNRESTRICTED_SCOPE,
  createdBy: 'test',
  createdAt: new Date(),
} as RateTemplate;

const ecom: Product = {
  ...EMPTY_PRODUCT,
  key: 'ecom',
  name: 'E-commerce / D2C parcel',
  templateKey: 'flat-pan-india',
  charges: ['cod-collection', 'rto-handling'],
  segment: 'Ecom',
};

describe('turning a product into a contract', () => {
  test('the template supplies the rates, because a product is a package not a price list', () => {
    expect(productTerms(ecom, template).overrides['grids.surface.tier1.PNQ.NCR']).toBe(25);
  });

  test('the product attaches its charges as standing terms', () => {
    const terms = productTerms(ecom, template);

    expect(terms.overrides['settlementCharges.cod-collection.active']).toBe('Yes');
    expect(terms.overrides['settlementCharges.rto-handling.active']).toBe('Yes');
  });

  test('a product with no charges leaves the card charges alone', () => {
    const terms = productTerms({ ...ecom, charges: [] }, template);
    expect(Object.keys(terms.overrides)).toEqual(['grids.surface.tier1.PNQ.NCR']);
  });

  test('the product narrows coverage when it declares any, and inherits it otherwise', () => {
    const south = productTerms({ ...ecom, modes: ['surface'] }, template);

    expect(south.scope.modes).toEqual(['surface']);
    expect(productTerms(ecom, template).scope.modes).toBeNull();
  });

  test('a product never invents rates of its own', () => {
    const terms = productTerms({ ...ecom, charges: [] }, { ...template, overrides: {} });
    expect(terms.overrides).toEqual({});
  });
});

describe('reading a product in the catalog', () => {
  const library = [
    { id: 'cod-collection', name: 'COD collection' },
    { id: 'rto-handling', name: 'RTO handling' },
  ];

  test('the rates it shows are the template’s, since it holds none itself', () => {
    const summary = summariseProduct(ecom, template, library);

    expect(summary.templateName).toBe('Flat pan-India surface');
    expect(summary.baseCardKey).toBe('model-3');
    expect(summary.rateCells).toBe(1);
  });

  test('attached charges are named, not left as ids', () => {
    expect(summariseProduct(ecom, template, library).charges).toEqual([
      { id: 'cod-collection', name: 'COD collection' },
      { id: 'rto-handling', name: 'RTO handling' },
    ]);
  });

  test('a charge nothing defines is a blocker, because it would switch on at zero', () => {
    const summary = summariseProduct({ ...ecom, charges: ['site-entry'] }, template, library);

    expect(summary.unknownCharges).toEqual(['site-entry']);
    expect(summary.blockers.join(' ')).toContain('site-entry');
  });

  test('a missing template blocks it rather than showing an empty product', () => {
    const summary = summariseProduct(ecom, null, library);

    expect(summary.templateName).toBeNull();
    expect(summary.rateCells).toBe(0);
    expect(summary.blockers.join(' ')).toContain('does not exist');
  });

  test('no segment is a blocker, matching the rule that it then matches nobody', () => {
    expect(summariseProduct({ ...ecom, segment: undefined }, template, library).blockers).toHaveLength(1);
  });

  test('a complete product has nothing standing in its way', () => {
    expect(summariseProduct(ecom, template, library).blockers).toEqual([]);
  });

  test('coverage falls back to the template’s when the product declares none', () => {
    const restricted = { ...template, scope: { ...template.scope, modes: ['air'] } } as RateTemplate;

    expect(summariseProduct(ecom, restricted, library).modes).toEqual(['air']);
    expect(summariseProduct({ ...ecom, modes: ['surface'] }, restricted, library).modes).toEqual([
      'surface',
    ]);
  });
});

describe('applying a product to a segment', () => {
  test('a customer tagged for the segment is in it', () => {
    expect(productFitsSegment(ecom, { tags: ['Ecom'] })).toBe(true);
  });

  test('tags are matched case-insensitively, because nobody types them twice the same', () => {
    expect(productFitsSegment(ecom, { tags: ['ecom'] })).toBe(true);
  });

  test('an untagged customer is not swept in', () => {
    expect(productFitsSegment(ecom, { tags: [] })).toBe(false);
    expect(productFitsSegment(ecom, {})).toBe(false);
  });

  test('a product with no segment matches nobody rather than everybody', () => {
    expect(productFitsSegment({ ...ecom, segment: undefined }, { tags: ['Ecom'] })).toBe(false);
  });
});
