import { describe, test, expect } from 'vitest';
import { groupChanges } from './grouping';
import type { Change } from './diff';

const cell = (bind: string, label: string, oldValue: number, newValue: number): Change => ({
  bind,
  sheet: 'Surface Rates',
  cellRef: 'A1',
  label,
  oldValue,
  newValue,
  pctChange: ((newValue - oldValue) / oldValue) * 100,
});

const ruleChange = (id: string, rate: string, label: string): Change => ({
  bind: `laneRules.${id}.rates.${rate}`,
  sheet: 'Smart geography',
  cellRef: id,
  label,
  oldValue: 24,
  newValue: 21,
  pctChange: -12.5,
});

describe('grouping a proposal into decisions', () => {
  test('nothing to review is no groups', () => {
    expect(groupChanges([])).toEqual([]);
  });

  test('a rule is one decision however many of its rates moved', () => {
    const groups = groupChanges([
      ruleChange('r_a', 'tier1', 'Pune → Bangalore · district → district · tier 1'),
      ruleChange('r_a', 'tier2', 'Pune → Bangalore · district → district · tier 2'),
      ruleChange('r_a', 'tier3', 'Pune → Bangalore · district → district · tier 3'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.changes).toHaveLength(3);
    expect(groups[0]?.title).toBe('Pune → Bangalore · district → district');
  });

  test('two rules are two decisions', () => {
    const groups = groupChanges([
      ruleChange('r_a', 'tier1', 'Pune → Bangalore · district → district · tier 1'),
      ruleChange('r_b', 'tier1', 'Maharashtra → Karnataka · state → state · tier 1'),
    ]);

    expect(groups).toHaveLength(2);
  });

  test('lane cells on one mode collapse by the zone group they land in', () => {
    const groups = groupChanges([
      cell('grids.surface.tier1.PNQ.BOM', 'Surface · tier 1 · PNQ→BOM', 410, 23),
      cell('grids.surface.tier1.PNQ.AMD', 'Surface · tier 1 · PNQ→AMD', 410, 23),
      cell('grids.surface.tier1.PNQ.NCR', 'Surface · tier 1 · PNQ→NCR', 480, 28),
    ]);

    const titles = groups.map((g) => g.title);
    expect(titles).toContain('Surface rates · West');
    expect(titles).toContain('Surface rates · North');
    expect(groups.find((g) => g.title === 'Surface rates · West')?.changes).toHaveLength(2);
  });

  test('a group says how many lanes it touched, which is the number nobody could see', () => {
    const groups = groupChanges([
      cell('grids.surface.tier1.PNQ.BOM', 'Surface · tier 1 · PNQ→BOM', 410, 23),
      cell('grids.surface.minCharge.PNQ.BOM', 'Surface · minimum · PNQ→BOM', 410, 23),
      cell('grids.surface.tier1.PNQ.AMD', 'Surface · tier 1 · PNQ→AMD', 410, 23),
    ]);

    expect(groups.find((g) => g.title === 'Surface rates · West')?.lanes).toBe(2);
  });

  test('a group carries the sharpest cut in it, so the worst case is not buried', () => {
    const groups = groupChanges([
      cell('grids.surface.tier1.PNQ.BOM', 'Surface · tier 1 · PNQ→BOM', 400, 380),
      cell('grids.surface.tier1.PNQ.AMD', 'Surface · tier 1 · PNQ→AMD', 400, 23),
    ]);

    expect(groups[0]?.steepestCut).toBeCloseTo(-94.25, 1);
  });

  test('everything that is not a lane or a rule groups by its tab', () => {
    const groups = groupChanges([
      { ...cell('charges.fuelSurface', 'Fuel · surface', 25, 30), sheet: 'Tax & Charges' },
      { ...cell('charges.gstAir', 'GST · air', 18, 5), sheet: 'Tax & Charges' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe('Tax & Charges');
  });

  test('every change survives grouping — a review cannot quietly drop one', () => {
    const changes = [
      ruleChange('r_a', 'tier1', 'Pune → Bangalore · district → district · tier 1'),
      cell('grids.surface.tier1.PNQ.BOM', 'Surface · tier 1 · PNQ→BOM', 410, 23),
      { ...cell('charges.fuelSurface', 'Fuel · surface', 25, 30), sheet: 'Tax & Charges' },
    ];

    const grouped = groupChanges(changes).flatMap((g) => g.changes);
    expect(grouped).toHaveLength(changes.length);
  });
});
