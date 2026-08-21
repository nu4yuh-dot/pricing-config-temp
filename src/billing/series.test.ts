import { describe, expect, test } from 'vitest';
import {
  financialYear,
  formatNumber,
  parseNumber,
  reconcile,
  reconciliationNote,
  type SeriesState,
} from './series';

const state = (over: Partial<SeriesState> = {}): SeriesState => ({
  prefix: 'DNS',
  financialYear: '2026-27',
  issued: 0,
  gaps: [],
  ...over,
});

describe('the financial year an invoice falls in', () => {
  test('April starts a new year, March ends the old one', () => {
    expect(financialYear(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T23:59:59Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-04-01T00:00:00Z'))).toBe('2027-28');
  });

  test('January to March belongs to the year that began the previous April', () => {
    // The trap: a January invoice is in FY 2026-27, not 2027-28.
    expect(financialYear(new Date('2027-01-15T00:00:00Z'))).toBe('2026-27');
  });

  test('the second half is two digits, including across a century-ish boundary', () => {
    expect(financialYear(new Date('2099-05-01T00:00:00Z'))).toBe('2099-00');
  });
});

describe('the number itself', () => {
  const key = { prefix: 'DNS', financialYear: '2026-27' };

  test('zero-padded so the series sorts as text', () => {
    // It will be read in a spreadsheet whatever anybody intended.
    expect(formatNumber(key, 42)).toBe('DNS/2026-27/000042');
    expect(['DNS/2026-27/000009', 'DNS/2026-27/000010'].sort()).toEqual([
      'DNS/2026-27/000009',
      'DNS/2026-27/000010',
    ]);
  });

  test('round-trips through parsing', () => {
    expect(parseNumber(formatNumber(key, 7))).toEqual({
      prefix: 'DNS',
      financialYear: '2026-27',
      sequence: 7,
    });
  });

  test('a number from another scheme is not mistaken for one of ours', () => {
    expect(parseNumber('INV-MAHLE-202608-SURFACE')).toBeNull();
    expect(parseNumber('DNS/2026-27/42')).toBeNull();
  });

  test('a prefix containing a slash still parses, because a state code might', () => {
    expect(parseNumber('DNS/MH/2026-27/000042')?.prefix).toBe('DNS/MH');
  });
});

describe('reconciling the series', () => {
  test('every number on an invoice balances', () => {
    const result = reconcile(state({ issued: 3 }), [
      'DNS/2026-27/000001',
      'DNS/2026-27/000002',
      'DNS/2026-27/000003',
    ]);
    expect(result.balanced).toBe(true);
    expect(result.allocated).toBe(3);
    expect(result.unaccounted).toEqual([]);
  });

  test('a number spent on nothing balances only once it is explained', () => {
    // A crash between allocating and writing leaves a number spent. Reusing it would put
    // two documents at the same position in the sequence, so it is explained instead.
    const unexplained = reconcile(state({ issued: 3 }), [
      'DNS/2026-27/000001',
      'DNS/2026-27/000003',
    ]);
    expect(unexplained.balanced).toBe(false);
    expect(unexplained.unaccounted).toEqual([2]);

    const explained = reconcile(
      state({
        issued: 3,
        gaps: [
          { number: 'DNS/2026-27/000002', sequence: 2, at: new Date(), reason: 'write failed' },
        ],
      }),
      ['DNS/2026-27/000001', 'DNS/2026-27/000003'],
    );
    expect(explained.balanced).toBe(true);
    expect(explained.explained).toBe(1);
  });

  test('numbers from another series or year are ignored, not counted', () => {
    const result = reconcile(state({ issued: 1 }), [
      'DNS/2026-27/000001',
      'DNS/2025-26/000001',
      'OTHER/2026-27/000001',
    ]);
    expect(result.onDocuments).toBe(1);
    expect(result.balanced).toBe(true);
  });

  test('the count of issued numbers matches what is on documents', () => {
    // The off-by-one this replaced reported one number issued against two on documents,
    // and still called the series balanced. The count and the documents have to agree.
    const result = reconcile(state({ issued: 2 }), [
      'DNS/2026-27/000001',
      'DNS/2026-27/000002',
    ]);
    expect(result.allocated).toBe(2);
    expect(result.onDocuments).toBe(2);
    expect(result.balanced).toBe(true);
  });

  test('a document numbered beyond what the series issued is not silently accepted', () => {
    // It cannot have come from this counter, so the series is not the thing to trust.
    const result = reconcile(state({ issued: 1 }), [
      'DNS/2026-27/000001',
      'DNS/2026-27/000009',
    ]);
    expect(result.allocated).toBe(1);
    expect(result.onDocuments).toBe(2);
  });

  test('a series that has issued nothing is balanced, not broken', () => {
    const result = reconcile(state(), []);
    expect(result.allocated).toBe(0);
    expect(result.balanced).toBe(true);
  });

  test('the unaccounted are named, because "there is a gap" is not actionable', () => {
    const result = reconcile(state({ issued: 5 }), ['DNS/2026-27/000001']);
    expect(result.unaccounted).toEqual([2, 3, 4, 5]);
    expect(reconciliationNote(state({ issued: 5 }), result)).toContain('000002');
  });

  test('a balanced series says so plainly', () => {
    const balanced = state({ issued: 2 });
    const result = reconcile(balanced, ['DNS/2026-27/000001', 'DNS/2026-27/000002']);
    expect(reconciliationNote(balanced, result)).toBe(
      'DNS/2026-27: 2 numbers issued, all accounted for.',
    );
  });
});
