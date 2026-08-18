import { describe, test, expect } from 'vitest';
import { diffLaneRules } from './rule-diff';
import { upsertRule, removeRule } from '../domain/lane-rule-store';
import type { RateCardData } from '../domain/types';

const empty = { grids: { air: {}, surface: {}, rail: {} } } as unknown as RateCardData;

const puneAnywhere = {
  id: 'r_pune',
  mode: 'surface' as const,
  origin: { kind: 'city' as const, value: 'Pune' },
  destination: { kind: 'any' as const },
  rates: { minCharge: 500, tier1: 21, tier2: 20, tier3: 19 },
};

describe('rule changes reaching the approval diff', () => {
  test('no rules on either side is no change', () => {
    expect(diffLaneRules(empty, empty)).toEqual([]);
  });

  test('an added rule is reported once per rate it carries', () => {
    const changes = diffLaneRules(empty, upsertRule(empty, puneAnywhere));

    expect(changes.map((c) => c.bind)).toEqual([
      'laneRules.r_pune.rates.minCharge',
      'laneRules.r_pune.rates.tier1',
      'laneRules.r_pune.rates.tier2',
      'laneRules.r_pune.rates.tier3',
    ]);
    expect(changes[0]?.oldValue).toBeNull();
    expect(changes[0]?.newValue).toBe(500);
  });

  test('an added rule reads as what it is, not as a bind path', () => {
    const [first] = diffLaneRules(empty, upsertRule(empty, puneAnywhere));
    expect(first?.label).toBe('Pune → Pan-India · district → any · minimum');
  });

  test('a removed rule is reported as every rate going away', () => {
    const before = upsertRule(empty, puneAnywhere);
    const changes = diffLaneRules(before, removeRule(before, 'r_pune'));

    expect(changes).toHaveLength(4);
    expect(changes[1]?.oldValue).toBe(21);
    expect(changes[1]?.newValue).toBeNull();
  });

  test('a changed rate on an existing rule is the only thing reported', () => {
    const before = upsertRule(empty, puneAnywhere);
    const after = upsertRule(before, { ...puneAnywhere, rates: { ...puneAnywhere.rates, tier1: 18 } });
    const changes = diffLaneRules(before, after);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.bind).toBe('laneRules.r_pune.rates.tier1');
    expect(changes[0]?.oldValue).toBe(21);
    expect(changes[0]?.newValue).toBe(18);
  });

  test('a rate cut reports how far it fell, the way a cell change does', () => {
    const before = upsertRule(empty, puneAnywhere);
    const after = upsertRule(before, { ...puneAnywhere, rates: { ...puneAnywhere.rates, tier1: 18 } });

    expect(diffLaneRules(before, after)[0]?.pctChange).toBeCloseTo(-14.29, 1);
  });

  test('closing a lane on a rule is a change, not an absence', () => {
    const before = upsertRule(empty, puneAnywhere);
    const after = upsertRule(before, {
      ...puneAnywhere,
      rates: { ...puneAnywhere.rates, tier1: null },
    });
    const changes = diffLaneRules(before, after);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.newValue).toBeNull();
    expect(changes[0]?.pctChange).toBeNull();
  });

  test('moving a rule to a different lane is reported, not silently repriced', () => {
    const before = upsertRule(empty, puneAnywhere);
    const after = upsertRule(before, {
      ...puneAnywhere,
      destination: { kind: 'city', value: 'Bangalore' },
    });
    const changes = diffLaneRules(before, after);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.bind).toBe('laneRules.r_pune.endpoints');
    expect(changes[0]?.oldValue).toBe('Pune → Pan-India · district → any');
    expect(changes[0]?.newValue).toBe('Pune → Bangalore · district → district');
  });

  test('every change names the rule it belongs to, so a review can group by it', () => {
    const changes = diffLaneRules(empty, upsertRule(empty, puneAnywhere));
    expect(new Set(changes.map((c) => c.cellRef))).toEqual(new Set(['r_pune']));
  });
});
