import { describe, test, expect } from 'vitest';
import { suggestProduct, codeFor, MANUAL_REVIEW_VOLUME } from './signups';

const catalog = [
  { key: 'ecom', name: 'E-commerce / D2C parcel', segment: 'Ecom' },
  { key: 'website', name: 'Website / online retail', segment: 'Website' },
  { key: 'msme', name: 'Retail MSME', segment: 'MSME' },
];

describe('suggesting a product for a signup', () => {
  test('each answer points at the segment the catalog sells to', () => {
    expect(suggestProduct({ channel: 'own-website' }, catalog).productKey).toBe('website');
    expect(suggestProduct({ channel: 'marketplace' }, catalog).productKey).toBe('ecom');
    expect(suggestProduct({ channel: 'local-shop' }, catalog).productKey).toBe('msme');
  });

  test('a big declared volume is flagged rather than answered', () => {
    // The guess is no worse at 4,000 a month; the stake is. Rack rates by default would
    // sell at list price to somebody who was about to negotiate.
    const suggestion = suggestProduct(
      { channel: 'marketplace', declaredVolume: MANUAL_REVIEW_VOLUME + 1 },
      catalog,
    );

    expect(suggestion.flagged).toBe(true);
    expect(suggestion.productKey).toBeNull();
  });

  test('volume at the threshold is still suggested', () => {
    expect(
      suggestProduct({ channel: 'marketplace', declaredVolume: MANUAL_REVIEW_VOLUME }, catalog)
        .productKey,
    ).toBe('ecom');
  });

  test('no answer means no inference, not a default product', () => {
    expect(suggestProduct({ channel: 'other' }, catalog).productKey).toBeNull();
  });

  test('a segment nothing is sold to comes back empty rather than stale', () => {
    const suggestion = suggestProduct({ channel: 'own-website' }, [catalog[1]!].slice(1));

    expect(suggestion.productKey).toBeNull();
    expect(suggestion.reason).toContain('Website');
  });

  test('the reason names the rule that fired, for the person confirming it', () => {
    expect(suggestProduct({ channel: 'marketplace' }, catalog).reason).toContain('Meesho');
  });
});

describe('the code a signup becomes', () => {
  test('derived from the legal name, since nobody signing up knows what a code is', () => {
    expect(codeFor('SharmaCrafts Online')).toBe('SHARMACRAFTS');
  });

  test('punctuation and spacing are dropped rather than encoded', () => {
    expect(codeFor('Vertex Traders Pvt. Ltd')).toBe('VERTEXTRADER');
  });

  test('a name with nothing usable produces nothing, rather than a code of punctuation', () => {
    expect(codeFor('...')).toBe('');
  });
});
