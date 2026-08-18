import { ZONE_GROUPS } from '../domain/zone-groups';
import type { Change } from './diff';

/**
 * A proposal, grouped by what somebody was actually trying to do.
 *
 * The queue reports one row per changed cell, which is correct and unreviewable: a
 * zone-group edit across a contract lands as four figures of rows, and a human faced
 * with 1,681 Approve/Reject buttons approves them all on trust. That is worse than no
 * review, because it looks like one.
 *
 * The grouping is by intent rather than by storage. Sixteen instructions produced those
 * 1,681 rows, so sixteen is roughly the number of decisions there really are, and each
 * group carries what an approver needs to judge it without opening it: how many lanes it
 * moved, and the steepest cut hiding inside.
 */

/**
 * Generic over the change type so a caller keeps whatever it added.
 *
 * The approval queue carries a per-cell decision and comment on top of a `Change`, and a
 * grouping that narrowed to the base type would strip a reviewer's own verdict off the
 * rows it returned.
 */
export interface ChangeGroup<T extends Change = Change> {
  key: string;
  title: string;
  /** Distinct lanes touched. A lane edited on all four rates is one lane, not four. */
  lanes: number;
  /** The sharpest fall in the group, so the worst case is never buried behind an average. */
  steepestCut: number | null;
  changes: T[];
}

const LANE_BIND = /^grids\.(air|surface|rail)\.(minCharge|tier1|tier2|tier3)\.([^.]+)\.([^.]+)$/;
const RULE_BIND = /^laneRules\.([^.]+)\./;

const MODE_LABEL: Record<string, string> = {
  air: 'Air',
  surface: 'Surface',
  rail: 'Rail',
};

/**
 * The region a zone falls in.
 *
 * Only the four geographic regions are used as headings, because they partition the
 * network — every zone is in exactly one. The commercial groups overlap them (BOM is a
 * metro *and* west), so grouping by "first group that contains this zone" would file
 * half a regional change under Metros and make a proposal look like two decisions when
 * it was one. Pan-India and non-metros are worse still: they contain everything, so they
 * would swallow a proposal into a heading that says nothing.
 */
const REGION_KEYS = ['north', 'west', 'south', 'east'];

function regionOfZone(zone: string): string | null {
  const region = ZONE_GROUPS.filter((group) => REGION_KEYS.includes(group.key)).find((group) =>
    group.zones.includes(zone),
  );
  return region?.name ?? null;
}

interface Bucket<T> {
  title: string;
  lanes: Set<string>;
  changes: T[];
}

export function groupChanges<T extends Change>(changes: readonly T[]): ChangeGroup<T>[] {
  const buckets = new Map<string, Bucket<T>>();

  const add = (key: string, title: string, change: T, lane?: string) => {
    const bucket = buckets.get(key) ?? { title, lanes: new Set<string>(), changes: [] };
    bucket.changes.push(change);
    if (lane) bucket.lanes.add(lane);
    buckets.set(key, bucket);
  };

  for (const change of changes) {
    const rule = RULE_BIND.exec(change.bind);
    if (rule) {
      // A rule's own label already reads as the decision — "Pune → Bangalore · city →
      // city" — with the rate appended, so the heading is that label without the rate.
      const id = rule[1] ?? change.cellRef;
      add(`rule:${id}`, change.label.split(' · ').slice(0, 2).join(' · '), change);
      continue;
    }

    const lane = LANE_BIND.exec(change.bind);
    if (lane) {
      const [, mode = '', , origin = '', destination = ''] = lane;
      const named = regionOfZone(destination) ?? destination;
      add(
        `lane:${mode}:${named}`,
        `${MODE_LABEL[mode] ?? mode} rates · ${named}`,
        change,
        `${origin}>${destination}`,
      );
      continue;
    }

    add(`sheet:${change.sheet}`, change.sheet, change);
  }

  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    title: bucket.title,
    lanes: bucket.lanes.size,
    steepestCut: bucket.changes.reduce<number | null>((worst, change) => {
      if (change.pctChange === null || change.pctChange >= 0) return worst;
      return worst === null ? change.pctChange : Math.min(worst, change.pctChange);
    }, null),
    changes: bucket.changes,
  }));
}
