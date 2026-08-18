import { AIR_ZONES, SURFACE_ZONES } from './zones';
import type { StoredMode } from './types';

/**
 * Named groups of zones, so a rate can be set for "all metros" or "PAN India"
 * instead of clicking through 441 lanes.
 *
 * The groupings are geographic and commercial judgements rather than facts, so they
 * are defined here in one place where they can be argued with, and every screen that
 * offers them reads from this list.
 */

export interface ZoneGroup {
  key: string;
  name: string;
  description: string;
  /** Zone codes. Filtered against the mode's own zone list when used. */
  zones: readonly string[];
}

/**
 * The eight cities that carry most B2B volume and have the densest networks, so they
 * are usually priced as one tier.
 */
const METRO_ZONES = ['BOM', 'NCR', 'BLR', 'MAA', 'HYD', 'CCU', 'PNQ', 'AMD'] as const;

export const ZONE_GROUPS: ZoneGroup[] = [
  {
    key: 'pan-india',
    name: 'PAN India',
    description: 'Every zone the mode serves.',
    zones: SURFACE_ZONES,
  },
  {
    key: 'metros',
    name: 'Metros',
    description: 'The eight highest-volume cities, usually priced as one tier.',
    zones: METRO_ZONES,
  },
  {
    key: 'non-metros',
    name: 'Non-metros',
    description: 'Everything outside the metros — regional and spread clusters.',
    zones: SURFACE_ZONES.filter((zone) => !METRO_ZONES.includes(zone as never)),
  },
  {
    key: 'north',
    name: 'North',
    description: 'Delhi-NCR, Bhiwadi-Jaipur, Uttarakhand, Punjab, rest of UP.',
    zones: ['NCR', 'BWR', 'UTR', 'LDH', 'UPX'],
  },
  {
    key: 'west',
    name: 'West',
    description: 'Maharashtra, Gujarat and Madhya Pradesh clusters.',
    zones: ['PNQ', 'PCMC', 'KSK', 'CSN', 'BOM', 'AMD', 'IDR', 'NAG'],
  },
  {
    key: 'south',
    name: 'South',
    description: 'Karnataka, Tamil Nadu, Kerala and the Telugu states.',
    zones: ['BLR', 'HSR', 'MAA', 'CJB', 'HYD'],
  },
  {
    key: 'east',
    name: 'East and North East',
    description: 'Kolkata, Jharkhand and the North East. Usually the longest lanes.',
    zones: ['CCU', 'JSR', 'GAU'],
  },
];

export const ZONE_GROUPS_BY_KEY = new Map(ZONE_GROUPS.map((group) => [group.key, group]));

/**
 * The zones in a group that the given mode actually has.
 *
 * Air runs on 12 hubs rather than the 21 surface clusters, so a group naming a
 * surface-only cluster must not produce a lane that cannot exist.
 */
export function zonesInGroup(groupKey: string, mode: StoredMode): string[] {
  const group = ZONE_GROUPS_BY_KEY.get(groupKey);
  if (!group) return [];
  const available: readonly string[] = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
  return group.zones.filter((zone) => available.includes(zone));
}

export interface LaneRef {
  origin: string;
  destination: string;
}

/**
 * Every lane from one group to another, for a mode.
 *
 * `includeIntraZone` is off by default: a lane from a zone to itself is a local
 * delivery priced quite differently from line-haul, so sweeping it up in a
 * group-to-group change is almost never what someone means.
 */
export function lanesBetweenGroups(
  fromGroupKey: string,
  toGroupKey: string,
  mode: StoredMode,
  includeIntraZone = false,
): LaneRef[] {
  const origins = zonesInGroup(fromGroupKey, mode);
  const destinations = zonesInGroup(toGroupKey, mode);

  const lanes: LaneRef[] = [];
  for (const origin of origins) {
    for (const destination of destinations) {
      if (!includeIntraZone && origin === destination) continue;
      lanes.push({ origin, destination });
    }
  }
  return lanes;
}
