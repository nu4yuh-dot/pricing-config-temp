import { describe, expect, test } from 'vitest';
import { applyTemplate, summariseTemplate, type RateTemplate } from './templates';
import { laneKey, UNRESTRICTED_SCOPE, type ContractScope } from './customers';

const template: RateTemplate = {
  key: 'auto-components-standard',
  name: 'Auto components — standard',
  description: 'The usual shape for tier-1 auto suppliers.',
  baseCardKey: 'model-1',
  overrides: {
    'grids.surface.minCharge.PNQ.NCR': 450,
    'grids.surface.tier2.PNQ.NCR': 12,
    'charges.fuelSurface': 0.2,
  },
  scope: {
    modes: ['surface'],
    lanes: [laneKey('surface', 'PNQ', 'NCR')],
    weightBands: null,
  },
  createdBy: 'Priya',
  createdAt: new Date('2026-08-05T00:00:00Z'),
};

const emptyCustomer = { overrides: {}, scope: UNRESTRICTED_SCOPE };

describe('applyTemplate — replace', () => {
  test('takes the template wholesale onto a fresh customer', () => {
    const result = applyTemplate(template, emptyCustomer, 'replace');
    expect(result.overrides).toEqual(template.overrides);
    expect(result.scope).toEqual(template.scope);
  });

  test('reports everything as applied', () => {
    const result = applyTemplate(template, emptyCustomer, 'replace');
    expect(result.applied.sort()).toEqual(Object.keys(template.overrides).sort());
    expect(result.kept).toEqual([]);
  });

  test('discards what the customer had negotiated, which is the point of replace', () => {
    const existing = {
      overrides: { 'grids.surface.minCharge.PNQ.BLR': 399 },
      scope: UNRESTRICTED_SCOPE,
    };
    const result = applyTemplate(template, existing, 'replace');
    expect(result.overrides['grids.surface.minCharge.PNQ.BLR']).toBeUndefined();
  });
});

describe('applyTemplate — fill gaps', () => {
  const existing = {
    // Already negotiated harder than the template on this lane.
    overrides: { 'grids.surface.minCharge.PNQ.NCR': 420 },
    scope: UNRESTRICTED_SCOPE,
  };

  test('keeps what the customer already negotiated', () => {
    const result = applyTemplate(template, existing, 'fill-gaps');
    expect(result.overrides['grids.surface.minCharge.PNQ.NCR']).toBe(420);
    expect(result.kept).toContain('grids.surface.minCharge.PNQ.NCR');
  });

  test('fills in everything the customer had not negotiated', () => {
    const result = applyTemplate(template, existing, 'fill-gaps');
    expect(result.overrides['grids.surface.tier2.PNQ.NCR']).toBe(12);
    expect(result.overrides['charges.fuelSurface']).toBe(0.2);
    expect(result.applied.sort()).toEqual(['charges.fuelSurface', 'grids.surface.tier2.PNQ.NCR']);
  });

  test("takes the template's coverage when the customer has none", () => {
    const result = applyTemplate(template, existing, 'fill-gaps');
    expect(result.scope).toEqual(template.scope);
  });

  test('leaves the customer coverage alone when they have already narrowed it', () => {
    const narrowed: ContractScope = {
      modes: ['air'],
      lanes: [laneKey('air', 'PNQ', 'BLR')],
      weightBands: null,
    };
    const result = applyTemplate(template, { overrides: {}, scope: narrowed }, 'fill-gaps');
    // Merging two partial scopes would cover lanes nobody agreed to.
    expect(result.scope).toEqual(narrowed);
  });
});

describe('summariseTemplate', () => {
  const summary = summariseTemplate(template);

  test('counts the negotiated cells', () => {
    expect(summary.negotiatedCells).toBe(3);
  });

  test('breaks them down by area, so a reviewer sees what kind of terms these are', () => {
    expect(summary.byArea).toEqual({ surface: 2, charges: 1 });
  });

  test('reports the coverage', () => {
    expect(summary.restricted).toBe(true);
    expect(summary.lanes).toBe(1);
    expect(summary.modes).toEqual(['surface']);
  });

  test('reports an unrestricted template as covering everything', () => {
    const open = summariseTemplate({ ...template, scope: UNRESTRICTED_SCOPE });
    expect(open.restricted).toBe(false);
    expect(open.lanes).toBeNull();
    expect(open.modes).toBeNull();
  });
});
