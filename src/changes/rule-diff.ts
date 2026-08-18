import { GRID_NAMES } from '../domain/types';
import { ruleBindPath, type StoredLaneRule } from '../domain/lane-rule-store';
import { ENDPOINT_LABEL, type Endpoint } from '../domain/lane-rules';
import type { RateCardData } from '../domain/types';
import type { Change, CellValue } from './diff';

/**
 * Lane rules in the approval diff.
 *
 * `diffCardData` finds changes by walking the sheet specs, which is right for everything
 * that lives at an A1 address and wrong for a rule, which lives at none. Without this a
 * rule added to a draft would price correctly and reach production without appearing in
 * a single review line — the one failure mode this system is built to prevent.
 *
 * Rules are reported per rate, at the same bind path the editor writes, so an approver
 * reads "Pune → Bangalore · district → district · tier 1 · 24 → 21", not a diff of JSON.
 * Every entry carries its rule id, which is what lets a review group hundreds of lines
 * back into the handful of decisions they actually represent.
 */

const SHEET = 'Smart geography';

const RATE_LABELS: Record<(typeof GRID_NAMES)[number], string> = {
  minCharge: 'minimum',
  tier1: 'tier 1',
  tier2: 'tier 2',
  tier3: 'tier 3',
};

function endpointText(endpoint: Endpoint): string {
  return endpoint.kind === 'any' ? 'Pan-India' : (endpoint.value ?? 'Pan-India');
}

/** `Pune → Bangalore · district → district` — named the way the cascade names it. */
export function ruleLabel(rule: StoredLaneRule): string {
  return (
    `${endpointText(rule.origin)} → ${endpointText(rule.destination)}` +
    ` · ${ENDPOINT_LABEL[rule.origin.kind]} → ${ENDPOINT_LABEL[rule.destination.kind]}`
  );
}

function percentChange(oldValue: CellValue, newValue: CellValue): number | null {
  if (typeof oldValue !== 'number' || typeof newValue !== 'number') return null;
  if (oldValue === 0) return null;
  return ((newValue - oldValue) / Math.abs(oldValue)) * 100;
}

function change(
  rule: StoredLaneRule,
  bind: string,
  what: string,
  oldValue: CellValue,
  newValue: CellValue,
): Change {
  return {
    bind,
    sheet: SHEET,
    // A rule has no A1 reference because it is not on a sheet. Its id goes here instead,
    // which is what a review groups by.
    cellRef: rule.id,
    label: `${ruleLabel(rule)} · ${what}`,
    oldValue,
    newValue,
    pctChange: percentChange(oldValue, newValue),
  };
}

export function diffLaneRules(before: RateCardData, after: RateCardData): Change[] {
  const was = before.laneRules ?? {};
  const now = after.laneRules ?? {};
  const changes: Change[] = [];

  for (const id of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const previous = was[id];
    const current = now[id];

    if (!previous && current) {
      for (const rate of GRID_NAMES) {
        if (current.rates[rate] === null) continue;
        changes.push(
          change(current, ruleBindPath(id, rate), RATE_LABELS[rate], null, current.rates[rate]),
        );
      }
      continue;
    }

    if (previous && !current) {
      for (const rate of GRID_NAMES) {
        if (previous.rates[rate] === null) continue;
        changes.push(
          change(previous, ruleBindPath(id, rate), RATE_LABELS[rate], previous.rates[rate], null),
        );
      }
      continue;
    }

    if (!previous || !current) continue;

    // Repointing a rule reprices every lane it covers without any rate moving, so the
    // endpoints are diffed in their own right rather than inferred from the rates.
    const wasWhere = ruleLabel(previous);
    const nowWhere = ruleLabel(current);
    if (wasWhere !== nowWhere) {
      changes.push(change(current, `laneRules.${id}.endpoints`, 'lane', wasWhere, nowWhere));
    }

    for (const rate of GRID_NAMES) {
      if (previous.rates[rate] === current.rates[rate]) continue;
      changes.push(
        change(
          current,
          ruleBindPath(id, rate),
          RATE_LABELS[rate],
          previous.rates[rate],
          current.rates[rate],
        ),
      );
    }
  }

  return changes;
}
