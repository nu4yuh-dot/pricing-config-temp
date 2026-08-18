import { zonesInGroup } from './zone-groups';
import { AIR_ZONES, SURFACE_ZONES } from './zones';
import type { Endpoint } from './lane-rules';
import type { RuleRates } from './lane-rule-store';
import type { ModeGrids, StoredMode } from './types';

/**
 * Lane by lane, what a rule would do to the prices on the card today.
 *
 * A group rule is one stored row that moves the price of every lane underneath it, and
 * the count of those lanes is not obvious from the rule — "PNQ → west" reads like one
 * change and is seven. Nobody should approve that without seeing the list, and nobody
 * should author it without seeing it either.
 *
 * Only zone-shaped endpoints can be previewed this way. A city or state rule does not map
 * onto the zone grid at all — that is the point of it — so it returns nothing here rather
 * than inventing a comparison, and its blast radius is shown as pincode coverage instead.
 */

export interface PreviewRow {
  origin: string;
  destination: string;
  /** Tier 1 on the card today. Null when the card does not carry this lane. */
  standard: number | null;
  /** Tier 1 the rule would apply. Null closes the lane. */
  proposed: number | null;
  pctChange: number | null;
  /** The card does not price this lane today, so the rule would open it. */
  opensLane: boolean;
  /** The card prices it today and the rule would stop carrying it. */
  closesLane: boolean;
}

/** The zone codes one endpoint resolves to, or none if it is not zone-shaped. */
function zonesFor(endpoint: Endpoint, mode: StoredMode): string[] {
  const all: readonly string[] = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
  if (endpoint.kind === 'zone') return endpoint.value ? [endpoint.value] : [];
  if (endpoint.kind === 'group') return endpoint.value ? zonesInGroup(endpoint.value, mode) : [];
  if (endpoint.kind === 'any') return [...all];
  return [];
}

export function previewRule(
  origin: Endpoint,
  destination: Endpoint,
  rates: RuleRates,
  grids: ModeGrids,
  mode: StoredMode,
): PreviewRow[] {
  const origins = zonesFor(origin, mode);
  const destinations = zonesFor(destination, mode);
  const rows: PreviewRow[] = [];

  for (const from of origins) {
    for (const to of destinations) {
      const standard = grids.tier1[from]?.[to] ?? null;
      const proposed = rates.tier1;

      rows.push({
        origin: from,
        destination: to,
        standard,
        proposed,
        // A percentage needs two numbers. Opening or closing a lane is a different kind
        // of act from repricing one, and reporting it as a fall to zero would hide that.
        pctChange:
          standard === null || proposed === null || standard === 0
            ? null
            : ((proposed - standard) / Math.abs(standard)) * 100,
        opensLane: standard === null && proposed !== null,
        closesLane: standard !== null && proposed === null,
      });
    }
  }

  return rows;
}
