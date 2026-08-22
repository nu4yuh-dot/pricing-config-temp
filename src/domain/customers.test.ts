import { describe, expect, test } from 'vitest';
import { commercialTerms, DEFAULT_COMMERCIAL_TERMS, type CommercialTerms } from './customers';

/**
 * Commercial terms read out of a document, field by field.
 *
 * The whole-object fallback these replace (`customer.commercial ?? DEFAULTS`) defaulted
 * only when the block was entirely missing. A stored `{}` therefore defaulted nothing, and
 * the undefined fields behind it reached money code: a NaN credit limit that refused a
 * booking, a payment term that made nothing overdue, and a falsy `gstApplicable` where the
 * default is true.
 */
describe('commercialTerms', () => {
  test('a missing block is the defaults', () => {
    expect(commercialTerms(undefined)).toEqual(DEFAULT_COMMERCIAL_TERMS);
    expect(commercialTerms(null)).toEqual(DEFAULT_COMMERCIAL_TERMS);
  });

  /** The case that was live in the database. */
  test('an empty block is the defaults, not a block of undefined', () => {
    const terms = commercialTerms({});
    expect(terms).toEqual(DEFAULT_COMMERCIAL_TERMS);
    expect(terms.gstApplicable).toBe(true);
    expect(terms.paymentTermsDays).toBe(30);
  });

  test('a partial block keeps what it states and defaults the rest', () => {
    const terms = commercialTerms({ creditLimit: 500000 });
    expect(terms.creditLimit).toBe(500000);
    expect(terms.paymentTermsDays).toBe(DEFAULT_COMMERCIAL_TERMS.paymentTermsDays);
    expect(terms.gstApplicable).toBe(true);
  });

  test('null credit limit is kept — no facility is not the same as unlimited', () => {
    expect(commercialTerms({ creditLimit: null }).creditLimit).toBeNull();
  });

  test('gstApplicable false is kept, not overwritten by the true default', () => {
    expect(commercialTerms({ gstApplicable: false }).gstApplicable).toBe(false);
  });

  test('a garbage credit limit falls back rather than propagating NaN', () => {
    const junk = { creditLimit: Number.NaN } as unknown as Partial<CommercialTerms>;
    expect(commercialTerms(junk).creditLimit).toBeNull();
    const text = { creditLimit: '500000' } as unknown as Partial<CommercialTerms>;
    expect(commercialTerms(text).creditLimit).toBeNull();
  });

  test('a zero credit limit is a real limit and is kept', () => {
    expect(commercialTerms({ creditLimit: 0 }).creditLimit).toBe(0);
  });
});
