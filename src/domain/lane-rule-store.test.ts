import { describe, test, expect } from 'vitest';
import { newRuleId, ruleBindPath, rulesFrom, upsertRule, removeRule } from './lane-rule-store';
import type { StoredLaneRule } from './lane-rule-store';
import type { RateCardData } from './types';

const rule: StoredLaneRule = {
  id: 'r_test',
  mode: 'surface',
  origin: { kind: 'city', value: 'Pune' },
  destination: { kind: 'city', value: 'Bangalore' },
  rates: { minCharge: 0, tier1: 21, tier2: 21, tier3: 21 },
  updatedAt: 1_000,
};

const emptyCard = {
  grids: { air: {}, surface: {}, rail: {} },
} as unknown as RateCardData;

describe('rule identity', () => {
  test('a new id is prefixed and unique', () => {
    const a = newRuleId();
    const b = newRuleId();
    expect(a).toMatch(/^r_[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });

  test('every rate on a rule has its own bind path', () => {
    expect(ruleBindPath('r_test', 'tier1')).toBe('laneRules.r_test.rates.tier1');
    expect(ruleBindPath('r_test', 'minCharge')).toBe('laneRules.r_test.rates.minCharge');
  });
});

describe('reading rules off a card', () => {
  test('a card with no rules yields none, so it prices exactly as today', () => {
    expect(rulesFrom(emptyCard.laneRules, 'base')).toEqual([]);
  });

  test('stored rules are returned stamped with the layer that held them', () => {
    const card = upsertRule(emptyCard, rule);

    expect(rulesFrom(card.laneRules, 'contract')[0]?.layer).toBe('contract');
    expect(rulesFrom(card.laneRules, 'base')[0]?.layer).toBe('base');
  });

  test('the rates and endpoints survive the round trip', () => {
    const read = rulesFrom(upsertRule(emptyCard, rule).laneRules, 'base')[0];

    expect(read?.rates.tier1).toBe(21);
    expect(read?.origin).toEqual({ kind: 'city', value: 'Pune' });
    expect(read?.updatedAt).toBe(1_000);
  });
});

describe('writing rules', () => {
  test('upsert adds a rule without touching the grids', () => {
    const card = upsertRule(emptyCard, rule);

    expect(Object.keys(card.laneRules ?? {})).toEqual(['r_test']);
    expect(card.grids).toEqual(emptyCard.grids);
  });

  test('upsert on an existing id replaces it rather than adding a second', () => {
    const once = upsertRule(emptyCard, rule);
    const twice = upsertRule(once, { ...rule, rates: { ...rule.rates, tier1: 19 } });

    expect(Object.keys(twice.laneRules ?? {})).toHaveLength(1);
    expect(twice.laneRules?.r_test?.rates.tier1).toBe(19);
  });

  test('upsert does not mutate the card it was given', () => {
    upsertRule(emptyCard, rule);
    expect(emptyCard.laneRules).toBeUndefined();
  });

  test('removing a rule leaves the rest alone', () => {
    const card = upsertRule(upsertRule(emptyCard, rule), { ...rule, id: 'r_other' });
    const after = removeRule(card, 'r_test');

    expect(Object.keys(after.laneRules ?? {})).toEqual(['r_other']);
  });

  test('removing a rule that is not there is not an error', () => {
    expect(removeRule(emptyCard, 'r_missing').laneRules).toEqual({});
  });

  test('a rule carrying a null rate keeps it — a closed lane is a value', () => {
    const closed = upsertRule(emptyCard, {
      ...rule,
      rates: { minCharge: null, tier1: null, tier2: null, tier3: null },
    });

    expect(rulesFrom(closed.laneRules, 'base')[0]?.rates.minCharge).toBeNull();
  });
});
