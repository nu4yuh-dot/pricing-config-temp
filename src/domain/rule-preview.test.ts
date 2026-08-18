import { describe, test, expect } from 'vitest';
import { previewRule } from './rule-preview';
import type { ModeGrids } from './types';

const grids = {
  minCharge: { PNQ: { BOM: 430, AMD: 410, IDR: 480, NCR: 500 } },
  tier1: { PNQ: { BOM: 43, AMD: 41, IDR: 48, NCR: 50 } },
  tier2: { PNQ: { BOM: 43, AMD: 41, IDR: 48, NCR: 50 } },
  tier3: { PNQ: { BOM: 43, AMD: 41, IDR: 48, NCR: 50 } },
} as unknown as ModeGrids;

const proposed = { minCharge: 0, tier1: 23, tier2: 23, tier3: 23 };

describe('previewing what a group rule would do', () => {
  test('one row per lane the rule would cover', () => {
    const rows = previewRule(
      { kind: 'zone', value: 'PNQ' },
      { kind: 'group', value: 'west' },
      proposed,
      grids,
      'surface',
    );

    expect(rows.map((r) => r.destination)).toEqual(
      expect.arrayContaining(['BOM', 'AMD', 'IDR']),
    );
    expect(rows.every((r) => r.origin === 'PNQ')).toBe(true);
  });

  test('each row compares today against the proposal', () => {
    const rows = previewRule(
      { kind: 'zone', value: 'PNQ' },
      { kind: 'zone', value: 'BOM' },
      proposed,
      grids,
      'surface',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ standard: 43, proposed: 23 });
    expect(rows[0]?.pctChange).toBeCloseTo(-46.5, 1);
  });

  test('the saving is one rule against the cells it replaces', () => {
    const rows = previewRule(
      { kind: 'zone', value: 'PNQ' },
      { kind: 'group', value: 'west' },
      proposed,
      grids,
      'surface',
    );

    // Seven west zones times four rates is what the cell model would have stored.
    expect(rows.length * 4).toBeGreaterThan(4);
  });

  test('a lane the card does not carry today is shown as newly opened', () => {
    const rows = previewRule(
      { kind: 'zone', value: 'PNQ' },
      { kind: 'zone', value: 'GAU' },
      proposed,
      grids,
      'surface',
    );

    expect(rows[0]?.standard).toBeNull();
    expect(rows[0]?.pctChange).toBeNull();
    expect(rows[0]?.opensLane).toBe(true);
  });

  test('an endpoint that names no zones previews nothing rather than everything', () => {
    expect(previewRule({ kind: 'zone', value: 'PNQ' }, { kind: 'group', value: 'nope' }, proposed, grids, 'surface')).toEqual([]);
  });

  test('a rule closing a lane is previewed as closing it, not as a fall to zero', () => {
    const rows = previewRule(
      { kind: 'zone', value: 'PNQ' },
      { kind: 'zone', value: 'BOM' },
      { minCharge: null, tier1: null, tier2: null, tier3: null },
      grids,
      'surface',
    );

    expect(rows[0]?.proposed).toBeNull();
    expect(rows[0]?.closesLane).toBe(true);
    expect(rows[0]?.pctChange).toBeNull();
  });

  test('a city or state endpoint has no zone preview, because it is not a zone rule', () => {
    expect(
      previewRule({ kind: 'city', value: 'Pune' }, { kind: 'zone', value: 'BOM' }, proposed, grids, 'surface'),
    ).toEqual([]);
  });
});
