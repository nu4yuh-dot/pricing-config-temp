import { describe, expect, test } from 'vitest';
import { newQuoteId, fingerprint } from './quotes';

describe('the quote identifier', () => {
  test('carries the date for a human and randomness for uniqueness', () => {
    const id = newQuoteId(new Date('2026-08-20T11:00:00Z'));
    expect(id).toMatch(/^QT-20260820-[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  test('two quotes on the same day do not collide', () => {
    const day = new Date('2026-08-20T11:00:00Z');
    const ids = new Set(Array.from({ length: 500 }, () => newQuoteId(day)));
    expect(ids.size).toBe(500);
  });

  test('the alphabet leaves out the characters people misread', () => {
    // These end up on invoices and get read aloud down a phone, so I, L, O and U are out.
    const ids = Array.from({ length: 200 }, () => newQuoteId()).join('');
    expect(ids).not.toMatch(/[ILOU]/);
  });
});

describe('the contract fingerprint', () => {
  test('the same terms fingerprint the same, whatever order the fields arrive in', () => {
    // Mongo makes no promise about key order, and a fingerprint that changed with it would
    // report a renegotiation every time a document was rewritten.
    const a = { overrides: { 'rates.a': 1, 'rates.b': 2 }, priceLock: null };
    const b = { priceLock: null, overrides: { 'rates.b': 2, 'rates.a': 1 } };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  test('a changed rate changes the fingerprint', () => {
    const before = { overrides: { 'rates.a': 1 } };
    const after = { overrides: { 'rates.a': 1.5 } };
    expect(fingerprint(after)).not.toBe(fingerprint(before));
  });

  test('an added override changes it, so a new negotiated cell is visible', () => {
    expect(fingerprint({ overrides: { a: 1, b: 2 } })).not.toBe(fingerprint({ overrides: { a: 1 } }));
  });

  test('no terms at all still fingerprints, rather than throwing', () => {
    expect(fingerprint(undefined)).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint(null)).toMatch(/^[0-9a-f]{12}$/);
  });

  test('array order is significant, because a list of steps is not a set', () => {
    expect(fingerprint({ slabs: [1, 2] })).not.toBe(fingerprint({ slabs: [2, 1] }));
  });
});
