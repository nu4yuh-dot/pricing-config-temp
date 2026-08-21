import type { Mode, RateCard, RateCardData, StoredMode } from '../domain/types';
import {
  laneKey,
  type ContractCheck,
  type ContractScope,
  type ContractTerms,
  type OutOfContractReason,
  type Overrides,
} from '../domain/customers';
import { getByPath, setByPath } from '../sheets/resolve';
import { allEditableCells } from '../changes/diff';
import type { BindPath } from '../sheets/types';

/**
 * Resolving a contract customer's prices.
 *
 * A contract is the base card plus a sparse override map. Applying it is a fold of
 * `setByPath`, which means every existing tool — the sheet resolver, the diff, the
 * validators — works on a customer card unchanged.
 */

/**
 * The base card with the customer's negotiated cells applied over it.
 *
 * Three layers, in this order: the card, then any prices frozen by a lock, then what was
 * negotiated. A lock never outranks an agreement — it is a promise that *unnegotiated*
 * prices will not drift, so a cell somebody actually bargained for goes on top of it.
 */
/**
 * Whether an override entry can be applied without destroying the card.
 *
 * An override is a **leaf** — one negotiated number or string at one path. It is stored as a
 * flat map of dotted paths precisely so that `charges.docket` means the docket and nothing
 * else.
 *
 * A value that is itself an object is not that. Applied, `setByPath` puts the object *at*
 * the path, so an entry keyed `charges` holding `{docket: 777}` replaces the whole charges
 * block — taking `minWeightSurface`, `fuelSurface` and `gstSurface` with it. The card then
 * prices to NaN, which surfaces as a weight error a long way from the cause. That happened,
 * from a single write that used a nested key where a dotted one was meant.
 *
 * Refused rather than repaired: this cannot tell which leaf was intended, and guessing one
 * would silently negotiate a rate nobody agreed.
 */
export function malformedOverrides(overrides: Overrides): string[] {
  return Object.entries(overrides)
    .filter(([, value]) => value !== null && typeof value === 'object')
    .map(([path]) => path);
}

export function effectiveCard(base: RateCard, terms: ContractTerms): RateCard {
  const locked = Object.entries(terms.priceLock?.rates ?? {}).reduce<RateCardData>(
    (acc, [path, value]) => setByPath(acc, path, value),
    base.data,
  );
  /**
   * Fail closed. A malformed override would replace a whole block of the card and price the
   * customer at NaN — a wrong number that reaches an invoice is worse than a refusal that
   * reaches somebody who can fix it, and this service fails closed everywhere else too.
   */
  const malformed = malformedOverrides(terms.overrides);
  if (malformed.length > 0) {
    throw new Error(
      `This contract has ${malformed.length} override(s) that name a group rather than a ` +
        `single rate: ${malformed.join(', ')}. Each override must be one value at one path, ` +
        `such as charges.docket. Nothing can be priced until they are corrected.`,
    );
  }

  const data = Object.entries(terms.overrides).reduce<RateCardData>(
    (acc, [path, value]) => setByPath(acc, path, value),
    locked,
  );
  return { ...base, data };
}

/**
 * The cells in `edited` that differ from `base`.
 *
 * Only editable cells are considered, so a structural difference can never be
 * mistaken for a negotiated price.
 */
export function overridesFrom(base: RateCardData, edited: RateCardData): Overrides {
  const overrides: Overrides = {};
  for (const cell of allEditableCells(base, edited)) {
    const before = (getByPath(base, cell.bind) ?? null) as string | number | null;
    const after = (getByPath(edited, cell.bind) ?? null) as string | number | null;
    if (before !== after) overrides[cell.bind] = after;
  }
  return overrides;
}

/**
 * Drop overrides that no longer differ from the base.
 *
 * When a base rate moves to meet a negotiated price, keeping the override would
 * freeze that customer at a value everyone else now gets anyway — and would quietly
 * stop them tracking future base changes on that cell.
 */
export function pruneOverrides(
  base: RateCardData,
  overrides: Overrides,
): { overrides: Overrides; removed: BindPath[] } {
  const kept: Overrides = {};
  const removed: BindPath[] = [];

  for (const [path, value] of Object.entries(overrides)) {
    const baseValue = (getByPath(base, path) ?? null) as string | number | null;
    if (baseValue === value) removed.push(path);
    else kept[path] = value;
  }

  return { overrides: kept, removed };
}

export interface OverrideSummary {
  total: number;
  /** Counts by top-level area: a mode name, `charges`, `pickupDelivery`, and so on. */
  byArea: Record<string, number>;
}

/** How far a contract has drifted from its base card. */
export function overrideCount(overrides: Overrides): OverrideSummary {
  const byArea: Record<string, number> = {};

  for (const path of Object.keys(overrides)) {
    const segments = path.split('.');
    // `grids.surface.…` is reported as `surface`; everything else by its root.
    const area = segments[0] === 'grids' ? (segments[1] ?? 'grids') : (segments[0] ?? 'other');
    byArea[area] = (byArea[area] ?? 0) + 1;
  }

  return { total: Object.keys(overrides).length, byArea };
}

/** NFO flies on the air network, so it is scoped against air lanes. */
function networkFor(mode: Mode): StoredMode {
  return mode === 'nfo' ? 'air' : mode;
}

export interface ContractQuery {
  mode: Mode;
  origin: string;
  destination: string;
  chargeableWeight: number;
}

/**
 * Is this shipment inside the customer's contract?
 *
 * Every restriction is checked, not just the first failure — a booking operator
 * needs to see everything wrong at once rather than fixing one problem to be told
 * about the next.
 */
export function checkContract(scope: ContractScope, query: ContractQuery): ContractCheck {
  const reasons: OutOfContractReason[] = [];
  const messages: string[] = [];

  if (scope.modes !== null && !scope.modes.includes(query.mode)) {
    reasons.push('mode-not-in-contract');
    messages.push(
      `This contract does not cover ${query.mode}. Covered: ${scope.modes.join(', ') || 'none'}.`,
    );
  }

  if (scope.lanes !== null) {
    const key = laneKey(networkFor(query.mode), query.origin, query.destination);
    if (!scope.lanes.includes(key)) {
      reasons.push('lane-not-in-contract');
      messages.push(
        `${query.origin} → ${query.destination} is not a contracted lane for ${query.mode}.`,
      );
    }
  }

  if (scope.weightBands !== null) {
    const covered = scope.weightBands.some(
      (band) =>
        query.chargeableWeight >= band.from &&
        (band.to === null || query.chargeableWeight < band.to),
    );
    if (!covered) {
      const bands = scope.weightBands
        .map((band) => (band.to === null ? `${band.from} kg and above` : `${band.from}–${band.to} kg`))
        .join(', ');
      reasons.push('weight-not-in-contract');
      messages.push(
        `${query.chargeableWeight} kg falls outside the contracted weight bands (${bands}).`,
      );
    }
  }

  return { inContract: reasons.length === 0, reasons, messages };
}

/** Add a lane to a scope, used when an admin folds an exception into the contract. */
export function withLane(
  scope: ContractScope,
  mode: Mode,
  origin: string,
  destination: string,
): ContractScope {
  if (scope.lanes === null) return scope;
  const key = laneKey(networkFor(mode), origin, destination);
  if (scope.lanes.includes(key)) return scope;
  return { ...scope, lanes: [...scope.lanes, key].sort() };
}

/** Add a mode to a scope. */
export function withMode(scope: ContractScope, mode: Mode): ContractScope {
  if (scope.modes === null || scope.modes.includes(mode)) return scope;
  return { ...scope, modes: [...scope.modes, mode] };
}
