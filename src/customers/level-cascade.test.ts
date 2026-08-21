import { describe, expect, test } from 'vitest';
import {
  CORE_CASCADE,
  divergences,
  ties,
  ourSpecificity,
  hasOurEquivalent,
} from './level-cascade';

describe('the core’s cascade as we understand it', () => {
  test('eleven levels, in the order their engine executes them', () => {
    expect(CORE_CASCADE).toHaveLength(11);
    expect(CORE_CASCADE.map((level) => level.step)).toEqual([
      'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11',
    ]);
  });

  test('the four metro levels have no equivalent here, and are dormant there', () => {
    // Their engine marks each one `skipped` when a pincode has no metro mapped, and their
    // seed data maps none. Substituting something for metro would invent a match.
    const metro = CORE_CASCADE.filter((level) => !hasOurEquivalent(level));
    expect(metro.map((level) => level.level)).toEqual([
      'CITY_METRO', 'METRO', 'STATE_METRO', 'METRO_ZONE',
    ]);
    for (const level of metro) expect(ourSpecificity(level)).toBeNull();
  });

  test('every other level maps onto endpoint kinds we already match on', () => {
    for (const level of CORE_CASCADE.filter(hasOurEquivalent)) {
      expect(ourSpecificity(level)).toBeGreaterThan(0);
    }
  });

  test('both engines agree that city↔city is the most specific', () => {
    const cityCity = CORE_CASCADE.find((level) => level.level === 'CITY')!;
    expect(cityCity.step).toBe('A1');
    expect(ourSpecificity(cityCity)).toBe(8);
  });
});

describe('where the two engines would charge differently', () => {
  test('there are exactly six disagreements, and they are these', () => {
    // Pinned deliberately. If this number changes, either their cascade was re-read or our
    // specificity table moved — and both are things somebody has to decide, not discover.
    expect(divergences().map((item) => item.coreOrder)).toEqual([
      'A2 before A8',
      'A5 before A8',
      'A7 before A8',
      'A7 before A10',
      'A7 before A11',
      'A10 before A11',
    ]);
  });

  test('the sharpest one: they prefer state↔state over city↔zone', () => {
    // Ours scores city↔zone at 7 and state↔state at 4 — a wide gap in the other
    // direction. On a lane where a customer holds both, the two engines pick different
    // rates and neither looks wrong from the inside.
    const sharp = divergences().find((item) => item.coreOrder === 'A7 before A8')!;
    expect(sharp.preferredByCore.level).toBe('STATE');
    expect(sharp.preferredByUs.level).toBe('CITY_ZONE');
    expect(sharp.ourScores).toBe('STATE=4, CITY_ZONE=7');
  });

  test('every divergence names both levels, so it can be acted on', () => {
    for (const item of divergences()) {
      expect(item.preferredByCore.level).not.toBe(item.preferredByUs.level);
      expect(item.ourScores).toMatch(/=\d+, .+=\d+/);
    }
  });
});

describe('whether our resolver ever decides a lane by coin toss', () => {
  test('it does not — every level pair is settled before recency is reached', () => {
    // An earlier reading of this compared only the pair sum and reported three ties. Our
    // comparator has three stages — sum, then the origin's own specificity, then recency —
    // and the second settles every pair that the first leaves level. Recency is never
    // reached, so no lane's price depends on which rule somebody last touched.
    expect(ties()).toEqual([]);
  });

  test('the sum alone would have left three pairs level, which is why the second stage exists', () => {
    const bySum = CORE_CASCADE.filter(hasOurEquivalent).filter(
      (level) => ourSpecificity(level) === 6,
    );
    expect(bySum.map((level) => level.level)).toEqual(['HUB', 'CITY_STATE', 'ZONE']);
    // HUB and ZONE are the same endpoint pair here — one rule with two of their names,
    // not two rules that tie.
    expect(bySum.filter((level) => level.origin === 'zone')).toHaveLength(2);
  });
});
