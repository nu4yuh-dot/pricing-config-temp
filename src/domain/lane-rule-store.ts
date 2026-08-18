import { GRID_NAMES } from './types';
import type { Endpoint, LaneRule, RuleLayer } from './lane-rules';
import type { RateCardData, StoredMode } from './types';

/**
 * Storing lane rules.
 *
 * Rules are held keyed by a stable id rather than in an array, and that is the whole
 * point of this module. Every value in this system is edited, diffed and approved
 * through a dotted bind path, so `laneRules.r_7f3a.rates.tier1` makes a rule's rate an
 * ordinary cell as far as the override map, the diff and the approval queue are
 * concerned. An array index would look like a path and behave like a trap: inserting a
 * rule renumbers everything after it, and an override keyed on `laneRules.3.rates.tier1`
 * would silently retarget to a different rule.
 *
 * A record has no order, which costs nothing — resolution sorts by specificity and
 * breaks ties on `updatedAt`, so storage order is never consulted.
 */

/** The four rates a rule carries. Same shape as a lane's, held here so domain owns it. */
export type RuleRates = Record<(typeof GRID_NAMES)[number], number | null>;

/**
 * A rule as it is stored.
 *
 * There is deliberately no `layer` field. A rule's layer is where it was found — on the
 * base card, or in a customer's contract — not something it declares about itself, which
 * makes it impossible for a contract to hold a rule claiming to be a standard one.
 */
export interface StoredLaneRule {
  id: string;
  mode: StoredMode;
  origin: Endpoint;
  destination: Endpoint;
  rates: RuleRates;
  /** Epoch ms, for the resolver's last tie-break. */
  updatedAt?: number;
}

export function newRuleId(): string {
  return `r_${Math.random().toString(36).slice(2, 10)}`;
}

/** `laneRules.r_7f3a.rates.tier1` — a real path, so getByPath and setByPath work. */
export function ruleBindPath(id: string, rate: keyof RuleRates): string {
  return `laneRules.${id}.rates.${rate}`;
}

/**
 * Every rule in a stored set, stamped with the layer it was read from.
 *
 * Takes the record rather than the card because the two layers live in different places
 * — a card's `data.laneRules`, and a contract's own — and a function that demanded a
 * whole card would force one of the callers to fabricate one.
 */
export function rulesFrom(
  stored: Record<string, StoredLaneRule> | undefined,
  layer: RuleLayer,
): LaneRule<RuleRates>[] {
  return Object.values(stored ?? {}).map((rule) => ({
    mode: rule.mode,
    origin: rule.origin,
    destination: rule.destination,
    rates: rule.rates,
    layer,
    ...(rule.updatedAt === undefined ? {} : { updatedAt: rule.updatedAt }),
  }));
}

export function upsertRule(data: RateCardData, rule: StoredLaneRule): RateCardData {
  return { ...data, laneRules: { ...data.laneRules, [rule.id]: rule } };
}

export function removeRule(data: RateCardData, id: string): RateCardData {
  const { [id]: _removed, ...rest } = data.laneRules ?? {};
  return { ...data, laneRules: rest };
}
