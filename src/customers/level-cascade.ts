import { endpointSpecificity, type EndpointKind } from '../domain/lane-rules';

/**
 * The core's rate-resolution cascade, written down so ours can be compared with it.
 *
 * Their engine tries eleven named levels in a fixed order and takes the first that
 * matches, most specific first. Ours computes a specificity from the pair of endpoints —
 * `pincode 5, city 4, zone 3, state 2, group 1, any 0` — and takes the highest sum.
 *
 * Both are "most specific wins". They do not always agree on which is more specific, and
 * that is the whole reason this file exists: on a lane where a customer holds two
 * contracted rates, the two engines can pick different ones, and the difference shows up
 * as a price, not as an error.
 *
 * Nothing here changes how we price. It exists to make the divergence enumerable, so the
 * cutover's run-both-and-compare step has something to compare against rather than a
 * hunch.
 */

/** One rung of their cascade, in their order. */
export interface CoreLevel {
  /** Their step id, as it appears in their resolution trace. */
  step: string;
  /** Their `level` value on a rate card row. */
  level: string;
  /** What the two ends match on, in our vocabulary. */
  origin: EndpointKind | 'metro';
  destination: EndpointKind | 'metro';
}

/**
 * Tier A — the customer's own contract, tried in full before any lane rate.
 *
 * Taken from their `pricingEngineService`, in the order the code executes them. The order
 * is the specification: it is not derivable from the names.
 */
export const CORE_CASCADE: CoreLevel[] = [
  { step: 'A1', level: 'CITY', origin: 'city', destination: 'city' },
  { step: 'A2', level: 'HUB', origin: 'zone', destination: 'zone' },
  { step: 'A3', level: 'CITY_METRO', origin: 'city', destination: 'metro' },
  { step: 'A4', level: 'METRO', origin: 'metro', destination: 'metro' },
  { step: 'A5', level: 'CITY_STATE', origin: 'city', destination: 'state' },
  { step: 'A6', level: 'STATE_METRO', origin: 'state', destination: 'metro' },
  { step: 'A7', level: 'STATE', origin: 'state', destination: 'state' },
  { step: 'A8', level: 'CITY_ZONE', origin: 'city', destination: 'zone' },
  { step: 'A9', level: 'METRO_ZONE', origin: 'metro', destination: 'zone' },
  { step: 'A10', level: 'STATE_ZONE', origin: 'state', destination: 'zone' },
  { step: 'A11', level: 'ZONE', origin: 'zone', destination: 'zone' },
];

/**
 * Metro has no equivalent here, and is dormant there.
 *
 * Their engine marks every metro rung `skipped` when a pincode has no metro mapped, and
 * their seed data maps none. So a metro level cannot currently be reached on either side —
 * which is why this returns null rather than guessing a substitute.
 */
export function hasOurEquivalent(level: CoreLevel): boolean {
  return level.origin !== 'metro' && level.destination !== 'metro';
}

/** Where our specificity rule would rank a level. Higher wins, as in the resolver. */
export function ourSpecificity(level: CoreLevel): number | null {
  if (!hasOurEquivalent(level)) return null;
  return (
    endpointSpecificity(level.origin as EndpointKind) +
    endpointSpecificity(level.destination as EndpointKind)
  );
}

export interface Divergence {
  /** The level their engine prefers. */
  preferredByCore: CoreLevel;
  /** The level ours would prefer instead. */
  preferredByUs: CoreLevel;
  /** Why: our sums, which disagree with their order. */
  coreOrder: string;
  ourScores: string;
}

/**
 * Every pair of levels the two engines rank differently.
 *
 * A pair only matters when a customer actually holds a rate at both levels on one lane —
 * then the two engines charge different amounts for the same consignment, and neither
 * looks wrong from the inside.
 */
export function divergences(): Divergence[] {
  const comparable = CORE_CASCADE.filter(hasOurEquivalent);
  const found: Divergence[] = [];

  for (let earlier = 0; earlier < comparable.length; earlier++) {
    for (let later = earlier + 1; later < comparable.length; later++) {
      const first = comparable[earlier]!;
      const second = comparable[later]!;
      const firstScore = ourSpecificity(first)!;
      const secondScore = ourSpecificity(second)!;

      // Their order prefers `first`. Ours prefers `second` only if it scores strictly
      // higher — an equal score is a tie we break elsewhere, not a disagreement.
      if (secondScore > firstScore) {
        found.push({
          preferredByCore: first,
          preferredByUs: second,
          coreOrder: `${first.step} before ${second.step}`,
          ourScores: `${first.level}=${firstScore}, ${second.level}=${secondScore}`,
        });
      }
    }
  }

  return found;
}

/**
 * Level pairs our resolver would decide by recency — that is, a genuine coin toss.
 *
 * The sum alone does not settle this, and an earlier reading of it said so wrongly. Our
 * comparator has three stages: the pair sum, then the *origin's* specificity, then how
 * recently the rule was edited. Two levels only reach that third stage when both earlier
 * stages tie — and then the price depends on which rule somebody last touched, which is
 * not a commercial rule anybody agreed to.
 *
 * Levels whose endpoint pair is identical are excluded. Their HUB and ZONE both mean
 * zone-to-zone here, so they are not two rules that tie; they are one rule with two names
 * on their side.
 */
export function ties(): { levels: string; score: number }[] {
  const comparable = CORE_CASCADE.filter(hasOurEquivalent);
  const found: { levels: string; score: number }[] = [];

  for (let earlier = 0; earlier < comparable.length; earlier++) {
    for (let later = earlier + 1; later < comparable.length; later++) {
      const first = comparable[earlier]!;
      const second = comparable[later]!;

      // The same endpoint pair under two of their names is not a tie between two rules.
      if (first.origin === second.origin && first.destination === second.destination) continue;

      const sumTies = ourSpecificity(first) === ourSpecificity(second);
      const originTies =
        endpointSpecificity(first.origin as EndpointKind) ===
        endpointSpecificity(second.origin as EndpointKind);

      if (sumTies && originTies) {
        found.push({
          levels: `${first.level} vs ${second.level}`,
          score: ourSpecificity(first)!,
        });
      }
    }
  }

  return found;
}
