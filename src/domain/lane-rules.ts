import { zonesInGroup } from './zone-groups';
import { GRID_NAMES } from './types';
import type { Pincode, StoredMode } from './types';

/**
 * Lane rules — pricing an endpoint more or less specifically than a zone.
 *
 * Today a rate is read at one shape, `zone → zone`. A rule generalises both ends so a
 * lane can be priced city to city, state to state, pincode to group and every mix, with the
 * most specific matching rule winning. The zone × zone grid is exactly the case where
 * both endpoints are `zone`, which is what makes this additive rather than a migration.
 *
 * Design: docs/superpowers/specs/2026-08-08-lane-granularity-design.md
 */

export type EndpointKind = 'pincode' | 'city' | 'zone' | 'state' | 'group' | 'any';

export interface Endpoint {
  kind: EndpointKind;
  /** Absent only for `any`, which names nothing. */
  value?: string;
}

/**
 * How narrowly a kind selects. The numbers themselves carry no meaning beyond their
 * order, but they are fixed and written down so two rules can never silently disagree
 * about which of them is the more specific.
 */
const SPECIFICITY: Record<EndpointKind, number> = {
  pincode: 5,
  city: 4,
  zone: 3,
  state: 2,
  group: 1,
  any: 0,
};

export function endpointSpecificity(kind: EndpointKind): number {
  return SPECIFICITY[kind];
}

function sameText(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Does one end of a shipment satisfy one end of a rule?
 *
 * Everything is read for the mode being quoted, because a pincode's zone is a property
 * of the mode and not of the pincode — Bhiwandi is BOM by road and PNQ by air.
 */
export function matchesEndpoint(
  endpoint: Endpoint,
  pincode: Pincode,
  mode: StoredMode,
): boolean {
  switch (endpoint.kind) {
    case 'any':
      return true;
    case 'pincode':
      return endpoint.value?.trim() === String(pincode.pincode);
    case 'city':
      // Derived from district on the way out of the data layer, so it is present for
      // every pincode on file. Still optional on the type: a pincode built without one
      // matches no city rule rather than every city rule.
      return sameText(endpoint.value, pincode.city);
    case 'zone':
      return sameText(endpoint.value, pincode[mode].zone);
    case 'state':
      return sameText(endpoint.value, pincode.state);
    case 'group': {
      if (!endpoint.value) return false;
      const zones = zonesInGroup(endpoint.value, mode);
      return zones.some((zone) => sameText(zone, pincode[mode].zone));
    }
  }
}

/** Which set of rules supplied a price. Ordered: a later layer overrides an earlier one. */
export type RuleLayer = 'base' | 'contract';

export interface LaneRule<R> {
  mode: StoredMode;
  origin: Endpoint;
  destination: Endpoint;
  rates: R;
  layer: RuleLayer;
  /** Epoch ms. Breaks a tie between rules that are otherwise indistinguishable. */
  updatedAt?: number;
}

export interface LaneResolution<R> {
  rule: LaneRule<R>;
  /** `PNQ → Delhi · zone → state · contract`, for the quote to show. */
  trace: string;
  /** The pair sum, kept so a caller can compare two resolutions. */
  specificity: number;
  /**
   * Two rules in the winning layer were equally specific at both ends, so the winner
   * was decided by edit time alone. Surfaced because at that point somebody should
   * collapse them rather than rely on which was touched last.
   */
  ambiguous: boolean;
}

interface Scored<R> {
  rule: LaneRule<R>;
  total: number;
  originSpecificity: number;
}

/** A rule's specificity is the pair sum — one sharp end does not make a rule specific. */
function specificityOf<R>(rule: LaneRule<R>): number {
  return endpointSpecificity(rule.origin.kind) + endpointSpecificity(rule.destination.kind);
}

/**
 * The order rules are considered in, defined once.
 *
 * Both the resolver and the cascade a person reads sort with this, so the list on screen
 * cannot tell a different story from the price that was charged.
 */
function compareRules<R>(a: LaneRule<R>, b: LaneRule<R>): number {
  return (
    specificityOf(b) - specificityOf(a) ||
    endpointSpecificity(b.origin.kind) - endpointSpecificity(a.origin.kind) ||
    (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  );
}

/** Every rule, most specific first — the order the resolver checks in. */
export function orderRules<R>(rules: readonly LaneRule<R>[]): LaneRule<R>[] {
  return [...rules].sort(compareRules);
}

/**
 * What each kind is called wherever a person reads it.
 *
 * `city` reads as **district**, because that is what currently populates it: city is
 * derived from the revenue district on the pincode master, and a district is much bigger
 * than the city that shares its name — `Pune` is 149 pincodes including rural Pune, where
 * somebody negotiating "Pune" means about a dozen. Labelling it "City" invites a rule to
 * be pointed at twelve times more territory than intended, which is a mispricing, not a
 * wording preference.
 *
 * The *kind* stays `city`: it is the level between pincode and zone, and the day real
 * cities are curated the data improves underneath without the model changing. Only the
 * word tracks what actually fills it.
 */
export const ENDPOINT_LABEL: Record<EndpointKind, string> = {
  pincode: 'pincode',
  city: 'district',
  zone: 'zone',
  state: 'state',
  group: 'group',
  any: 'any',
};

function endpointLabel(endpoint: Endpoint): string {
  return endpoint.kind === 'any' ? 'any' : (endpoint.value ?? 'any');
}

function traceOf<R>(rule: LaneRule<R>): string {
  return (
    `${endpointLabel(rule.origin)} → ${endpointLabel(rule.destination)}` +
    ` · ${ENDPOINT_LABEL[rule.origin.kind]} → ${ENDPOINT_LABEL[rule.destination.kind]}` +
    ` · ${rule.layer}`
  );
}

/**
 * The rule that prices this shipment, or null when none does.
 *
 * Null is the important case: it is what every card returns today, and it means the
 * caller falls through to the zone × zone grid exactly as before. Rules are additive,
 * so a card with none behaves as it always has.
 *
 * Layers are resolved as complete sets rather than pooled — every contract rule is
 * considered first, and the base card is consulted only when no contract rule matches
 * at all. Specificity orders rules *within* a layer, never across them, so a standard
 * rule somebody adds later can never displace a price a customer negotiated.
 */
export function resolveLaneRule<R>(
  rules: readonly LaneRule<R>[],
  shipment: { mode: StoredMode; origin: Pincode; destination: Pincode },
): LaneResolution<R> | null {
  const { mode, origin, destination } = shipment;

  const matched: Scored<R>[] = [];
  for (const rule of rules) {
    if (rule.mode !== mode) continue;
    if (!matchesEndpoint(rule.origin, origin, mode)) continue;
    if (!matchesEndpoint(rule.destination, destination, mode)) continue;

    const originSpecificity = endpointSpecificity(rule.origin.kind);
    matched.push({
      rule,
      originSpecificity,
      total: originSpecificity + endpointSpecificity(rule.destination.kind),
    });
  }

  if (matched.length === 0) return null;

  const contract = matched.filter((entry) => entry.rule.layer === 'contract');
  const layer = contract.length > 0 ? contract : matched;

  layer.sort((a, b) => compareRules(a.rule, b.rule));

  const winner = layer[0];
  if (!winner) return null;
  const runnerUp = layer[1];

  const ambiguous =
    runnerUp !== undefined &&
    runnerUp.total === winner.total &&
    runnerUp.originSpecificity === winner.originSpecificity;

  return {
    rule: winner.rule,
    trace: traceOf(winner.rule),
    specificity: winner.total,
    ambiguous,
  };
}

/** `grids.surface.minCharge.PNQ.NCR` — the path the sheet, the diff and an override share. */
export function gridBindPath(
  mode: StoredMode,
  rate: (typeof GRID_NAMES)[number],
  origin: string,
  destination: string,
): string {
  return `grids.${mode}.${rate}.${origin}.${destination}`;
}

export interface LaneProvenance {
  layer: RuleLayer;
  /** Which of the four lane rates the contract supplied. Empty on a base-card quote. */
  negotiated: string[];
  /** `PNQ → NCR · zone → zone · contract`, for the quote to show. */
  trace: string;
}

/**
 * Where this lane's rates came from, for the zone × zone grid.
 *
 * The grid is the case where both endpoints are zones, so it traces exactly like any
 * other rule. Layer is read from the override map rather than from the card, because
 * applying a contract folds its cells into a plain card and the distinction is gone by
 * the time anything prices a shipment.
 *
 * A negotiated `null` counts as negotiated: it means the customer's lane is deliberately
 * not carried, which is a different act from never having priced it, so presence is
 * tested by key and never by value.
 */
export function gridLaneProvenance(lane: {
  mode: StoredMode;
  originZone: string;
  destinationZone: string;
  overrides?: Record<string, unknown>;
}): LaneProvenance {
  const { mode, originZone, destinationZone, overrides } = lane;

  const negotiated = overrides
    ? GRID_NAMES.filter((rate) =>
        Object.hasOwn(overrides, gridBindPath(mode, rate, originZone, destinationZone)),
      )
    : [];

  const layer: RuleLayer = negotiated.length > 0 ? 'contract' : 'base';

  return {
    layer,
    negotiated: [...negotiated],
    trace: `${originZone} → ${destinationZone} · zone → zone · ${layer}`,
  };
}

/**
 * The cascade for one shipment, for somebody who wants to see why.
 *
 * Every rule for the mode is listed in resolution order, each saying whether it matched,
 * and the winner is the one `resolveLaneRule` actually returns rather than a second
 * opinion computed alongside it. A rule that did not match is shown as not matching
 * instead of being hidden, because "why did my rule not apply" is the question this is
 * usually opened to answer.
 */
export function explainResolution<R>(
  rules: readonly LaneRule<R>[],
  shipment: { mode: StoredMode; origin: Pincode; destination: Pincode },
): { steps: { trace: string; matched: boolean; rates: R }[]; winner: LaneResolution<R> | null } {
  const forMode = rules.filter((rule) => rule.mode === shipment.mode);

  return {
    steps: orderRules(forMode).map((rule) => ({
      trace: traceOf(rule),
      matched:
        matchesEndpoint(rule.origin, shipment.origin, shipment.mode) &&
        matchesEndpoint(rule.destination, shipment.destination, shipment.mode),
      rates: rule.rates,
    })),
    winner: resolveLaneRule(rules, shipment),
  };
}
