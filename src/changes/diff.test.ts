import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffCardData } from './diff';
import { setByPath } from '../sheets/resolve';
import { upsertRule } from '../domain/lane-rule-store';
import type { RateCard, RateCardData } from '../domain/types';

const card: RateCard = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'model-1.json'), 'utf8'),
);
const base = card.data;

describe('diffCardData', () => {
  test('finds nothing when nothing changed', () => {
    expect(diffCardData(base, base)).toEqual([]);
  });

  test('reports a changed rate with the sheet, cell and human label', () => {
    const after = setByPath<RateCardData>(base, 'grids.surface.minCharge.PNQ.NCR', 560);
    const changes = diffCardData(base, after);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      bind: 'grids.surface.minCharge.PNQ.NCR',
      sheet: 'Surface Rates',
      cellRef: 'J5',
      label: 'Surface Rates · min charge · PNQ→NCR',
      oldValue: 530,
      newValue: 560,
    });
  });

  test('computes the percentage movement', () => {
    const after = setByPath<RateCardData>(base, 'grids.surface.minCharge.PNQ.NCR', 560);
    // 530 -> 560 is +5.660...%
    expect(diffCardData(base, after)[0]?.pctChange).toBeCloseTo(5.66, 2);
  });

  test('reports a rate that became unavailable', () => {
    const after = setByPath<RateCardData>(base, 'grids.surface.minCharge.PNQ.NCR', null);
    const change = diffCardData(base, after)[0];
    expect(change?.oldValue).toBe(530);
    expect(change?.newValue).toBeNull();
    expect(change?.pctChange).toBeNull();
  });

  test('reports a lane that became available', () => {
    const after = setByPath<RateCardData>(base, 'grids.air.minCharge.PNQ.BOM', 2000);
    const change = diffCardData(base, after)[0];
    expect(change?.oldValue).toBeNull();
    expect(change?.newValue).toBe(2000);
    expect(change?.pctChange).toBeNull();
  });

  test('reports several changes across different sheets', () => {
    let after = setByPath<RateCardData>(base, 'grids.surface.minCharge.PNQ.NCR', 560);
    after = setByPath(after, 'charges.fuelSurface', 0.28);
    after = setByPath(after, 'pickupDelivery.PNQ.pickupSurface', 450);

    const changes = diffCardData(base, after);
    expect(changes).toHaveLength(3);
    expect(changes.map((c) => c.sheet).sort()).toEqual([
      'Charges & Terms',
      'Pickup & Delivery',
      'Surface Rates',
    ]);
  });

  test('detects a changed transit time', () => {
    const after = setByPath<RateCardData>(base, 'transitTimes.surface.PNQ.NCR', 4);
    const change = diffCardData(base, after)[0];
    expect(change?.sheet).toBe('TAT Surface');
    expect(change?.cellRef).toBe('J5');
  });

  test('detects a changed EDL surcharge', () => {
    const after = setByPath<RateCardData>(base, 'edlMatrix.rates.0.0', 600);
    const change = diffCardData(base, after)[0];
    expect(change?.sheet).toBe('EDL Matrix');
    expect(change?.oldValue).toBe(550);
    expect(change?.newValue).toBe(600);
  });

  test('detects a renamed zone', () => {
    const after = setByPath<RateCardData>(base, 'zones.surface.PNQ.belt', 'Pune metro');
    const change = diffCardData(base, after)[0];
    expect(change?.sheet).toBe('Cluster Guide');
    expect(change?.newValue).toBe('Pune metro');
    expect(change?.pctChange).toBeNull();
  });

  test('orders changes by sheet then by cell, so a reviewer reads them in place', () => {
    let after = setByPath<RateCardData>(base, 'grids.surface.tier3.GAU.GAU', 10);
    after = setByPath(after, 'grids.surface.minCharge.PNQ.PNQ', 310);

    const changes = diffCardData(base, after);
    expect(changes.map((c) => c.cellRef)).toEqual(['B5', 'V97']);
  });
});

/**
 * The settlement configuration is on a tab for a reason: a GST rate or a fuel-base
 * switch that the diff could not see would go live without anyone reviewing it.
 */
describe('the settlement configuration is reviewable', () => {
  test('switching a mode to reverse charge appears as a change', () => {
    const after = structuredClone(base);
    after.modeTax = { ...after.modeTax, surface: { ...after.modeTax?.surface, rcm: 'Yes' } };
    const change = diffCardData(base, after).find((entry) => entry.bind === 'modeTax.surface.rcm');
    expect(change).toBeDefined();
    expect(change?.oldValue).toBe('No');
    expect(change?.newValue).toBe('Yes');
    expect(change?.sheet).toBe('Tax & Charges');
  });

  test('a GST rate change is reported with its percentage movement', () => {
    const after = structuredClone(base);
    after.modeTax = { ...after.modeTax, air: { ...after.modeTax?.air, gstRate: 0.12 } };
    const change = diffCardData(base, after).find((entry) => entry.bind === 'modeTax.air.gstRate');
    expect(change?.oldValue).toBe(0.18);
    expect(change?.newValue).toBe(0.12);
  });

  test('moving fuel onto total charges appears as a change', () => {
    const after = structuredClone(base);
    after.fuelBase = { ...after.fuelBase, charges: 'Yes' };
    const change = diffCardData(base, after).find((entry) => entry.bind === 'fuelBase.charges');
    expect(change?.newValue).toBe('Yes');
  });

  test('switching a charge on, and repricing it, both appear', () => {
    const after = structuredClone(base);
    const catalog = after.chargeCatalog as Record<string, Record<string, unknown>>;
    catalog['handling'] = { ...catalog['handling'], active: 'Yes', amount: 75 };
    const binds = diffCardData(base, after).map((entry) => entry.bind);
    expect(binds).toContain('chargeCatalog.handling.active');
    expect(binds).toContain('chargeCatalog.handling.amount');
  });

  test('a changed charge is labelled well enough to judge without opening the tab', () => {
    const after = structuredClone(base);
    const catalog = after.chargeCatalog as Record<string, Record<string, unknown>>;
    catalog['docket'] = { ...catalog['docket'], amount: 150 };
    const change = diffCardData(base, after).find(
      (entry) => entry.bind === 'chargeCatalog.docket.amount',
    );
    expect(change?.label).toContain('Amount');
    expect(change?.label).toContain('docket');
  });
});

describe('lane rules reach the approval diff', () => {
  const ruled = (data: RateCardData) =>
    upsertRule(data, {
      id: 'r_review',
      mode: 'surface',
      origin: { kind: 'city', value: 'Pune' },
      destination: { kind: 'any' },
      rates: { minCharge: 0, tier1: 12, tier2: 12, tier3: 12 },
    });

  test('a rule added to a draft cannot go live unreviewed', () => {
    const changes = diffCardData(base, ruled(base));

    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((c) => c.bind.startsWith('laneRules.r_review'))).toBe(true);
  });

  test('the reviewer reads the rule, not a bind path', () => {
    const change = diffCardData(base, ruled(base)).find((c) => c.bind.endsWith('tier1'));
    expect(change?.label).toBe('Pune → Pan-India · district → any · tier 1');
  });

  test('a card with no rules on either side is unaffected', () => {
    expect(diffCardData(base, base)).toEqual([]);
  });
});
