import { describe, expect, test } from 'vitest';
import { columnLetter, columnNumber, parseRef, formatRef, offsetRef } from './address';

describe('columnLetter', () => {
  test('maps the first column to A', () => {
    expect(columnLetter(1)).toBe('A');
  });

  test('maps the twenty-sixth column to Z', () => {
    expect(columnLetter(26)).toBe('Z');
  });

  test('rolls over into two letters past Z', () => {
    expect(columnLetter(27)).toBe('AA');
    expect(columnLetter(28)).toBe('AB');
  });

  test('reaches the widest column the source workbooks use', () => {
    // Surface Rates runs to AC, where the HOW TO READ panel sits.
    expect(columnLetter(29)).toBe('AC');
  });
});

describe('columnNumber', () => {
  test('is the inverse of columnLetter', () => {
    for (const n of [1, 2, 26, 27, 28, 29, 52, 53, 702, 703]) {
      expect(columnNumber(columnLetter(n))).toBe(n);
    }
  });

  test('accepts lower case', () => {
    expect(columnNumber('ac')).toBe(29);
  });
});

describe('parseRef', () => {
  test('splits a single-letter reference', () => {
    expect(parseRef('A1')).toEqual({ column: 1, row: 1 });
  });

  test('splits a two-letter reference', () => {
    expect(parseRef('AC27')).toEqual({ column: 29, row: 27 });
  });

  test('rejects a reference without a row', () => {
    expect(() => parseRef('A')).toThrow(/invalid cell reference/i);
  });

  test('rejects a reference without a column', () => {
    expect(() => parseRef('12')).toThrow(/invalid cell reference/i);
  });
});

describe('formatRef', () => {
  test('rebuilds a reference from column and row', () => {
    expect(formatRef(1, 1)).toBe('A1');
    expect(formatRef(29, 27)).toBe('AC27');
  });
});

describe('offsetRef', () => {
  test('moves right and down from an anchor', () => {
    expect(offsetRef('A3', 1, 2)).toBe('B5');
  });

  test('returns the anchor for a zero offset', () => {
    expect(offsetRef('J5', 0, 0)).toBe('J5');
  });

  test('crosses the Z boundary correctly', () => {
    expect(offsetRef('Y1', 3, 0)).toBe('AB1');
  });
});
