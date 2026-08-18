import { describe, expect, test } from 'vitest';
import { ZONE_GROUPS, zonesInGroup, lanesBetweenGroups } from './zone-groups';
import { AIR_ZONES, SURFACE_ZONES } from './zones';

describe('the groups themselves', () => {
  test('every group names only real zones', () => {
    for (const group of ZONE_GROUPS) {
      for (const zone of group.zones) {
        expect(SURFACE_ZONES, `${group.key} names unknown zone ${zone}`).toContain(zone);
      }
    }
  });

  test('PAN India covers every zone', () => {
    expect(zonesInGroup('pan-india', 'surface')).toHaveLength(SURFACE_ZONES.length);
  });

  test('metros and non-metros together are exactly PAN India', () => {
    const metros = zonesInGroup('metros', 'surface');
    const nonMetros = zonesInGroup('non-metros', 'surface');
    expect(metros.length + nonMetros.length).toBe(SURFACE_ZONES.length);
    expect(new Set([...metros, ...nonMetros]).size).toBe(SURFACE_ZONES.length);
  });

  test('metros and non-metros do not overlap', () => {
    const metros = new Set(zonesInGroup('metros', 'surface'));
    for (const zone of zonesInGroup('non-metros', 'surface')) {
      expect(metros.has(zone)).toBe(false);
    }
  });

  test('the regional groups between them cover every zone', () => {
    const covered = new Set(
      ['north', 'west', 'south', 'east'].flatMap((key) => zonesInGroup(key, 'surface')),
    );
    for (const zone of SURFACE_ZONES) {
      expect(covered, `${zone} is in no regional group`).toContain(zone);
    }
  });

  test('an unknown group yields nothing rather than throwing', () => {
    expect(zonesInGroup('nope', 'surface')).toEqual([]);
  });
});

describe('zonesInGroup — respecting the mode', () => {
  test('air only yields hubs that exist on the air network', () => {
    for (const zone of zonesInGroup('pan-india', 'air')) {
      expect(AIR_ZONES).toContain(zone);
    }
  });

  test('a surface-only cluster is dropped for air', () => {
    // PCMC, HSR and JSR are surface clusters with no air hub.
    expect(zonesInGroup('west', 'surface')).toContain('PCMC');
    expect(zonesInGroup('west', 'air')).not.toContain('PCMC');
  });

  test('rail uses the surface clusters', () => {
    expect(zonesInGroup('pan-india', 'rail')).toHaveLength(SURFACE_ZONES.length);
  });
});

describe('lanesBetweenGroups', () => {
  test('produces every combination across the two groups', () => {
    const lanes = lanesBetweenGroups('metros', 'metros', 'surface');
    const metros = zonesInGroup('metros', 'surface');
    // Every ordered pair except a zone with itself.
    expect(lanes).toHaveLength(metros.length * metros.length - metros.length);
  });

  test('excludes same-zone lanes by default, since those are local deliveries', () => {
    for (const lane of lanesBetweenGroups('metros', 'metros', 'surface')) {
      expect(lane.origin).not.toBe(lane.destination);
    }
  });

  test('includes them when explicitly asked', () => {
    const lanes = lanesBetweenGroups('metros', 'metros', 'surface', true);
    expect(lanes.some((lane) => lane.origin === lane.destination)).toBe(true);
  });

  test('is directional, so from-metros-to-east is not the reverse', () => {
    const outbound = lanesBetweenGroups('metros', 'east', 'surface');
    const inbound = lanesBetweenGroups('east', 'metros', 'surface');
    expect(outbound[0]?.origin).not.toBe(inbound[0]?.origin);
    expect(outbound).toHaveLength(inbound.length);
  });

  test('PAN India to PAN India is the whole surface matrix bar the diagonal', () => {
    const lanes = lanesBetweenGroups('pan-india', 'pan-india', 'surface');
    expect(lanes).toHaveLength(SURFACE_ZONES.length * SURFACE_ZONES.length - SURFACE_ZONES.length);
  });

  test('an unknown group yields no lanes', () => {
    expect(lanesBetweenGroups('nope', 'metros', 'surface')).toEqual([]);
  });
});
