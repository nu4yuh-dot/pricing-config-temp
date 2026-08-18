import { AIR_ZONES, SURFACE_ZONES } from './zones';
import { ZONE_GROUPS } from './zone-groups';
import { endpointSpecificity, type EndpointKind } from './lane-rules';
import type { Pincode, StoredMode } from './types';

/**
 * One search box across every level of geography.
 *
 * The zone picker it replaces understood 21 fixed codes, which is not how anyone
 * negotiates — the ask is "all of Maharashtra", "Pune to Bangalore only", "any metro to
 * any metro". Each of those is a level this returns, and each becomes one rule rather
 * than the hundreds of cells it would otherwise expand to.
 *
 * Results are ordered most specific first, which is also the order the resolver checks
 * in: somebody reading this list is reading the cascade they are about to add to.
 */

export interface GeoResult {
  kind: EndpointKind;
  /** What goes into the endpoint. Empty for `any`, which names nothing. */
  value: string;
  /** What the person reads. */
  label: string;
  /** The grey line to its right — how many pincodes, which state, which zone. */
  meta: string;
}

const startsWith = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().startsWith(needle);

export function searchGeography(
  query: string,
  master: readonly Pincode[],
  mode: StoredMode,
  limit = 8,
): GeoResult[] {
  const q = query.trim().toLowerCase();
  const results: GeoResult[] = [];

  if (q) {
    // Capped rather than paginated. A prefix of "4" matches thousands of pincodes and a
    // list that long is not a result, it is a refusal to answer.
    let pincodes = 0;
    for (const p of master) {
      if (pincodes >= limit) break;
      if (!String(p.pincode).startsWith(q)) continue;
      pincodes += 1;
      results.push({
        kind: 'pincode',
        value: String(p.pincode),
        label: String(p.pincode),
        meta: `${p.area} · ${p.state} · ${p[mode].zone}`,
      });
    }

    const cities = new Map<string, { count: number; state: string; zone: string }>();
    for (const p of master) {
      if (!p.city) continue;
      const seen = cities.get(p.city);
      if (seen) seen.count += 1;
      else cities.set(p.city, { count: 1, state: p.state, zone: p[mode].zone });
    }
    for (const [city, info] of cities) {
      if (!startsWith(city, q)) continue;
      results.push({
        kind: 'city',
        value: city,
        label: city,
        meta: `${info.count} pincode${info.count === 1 ? '' : 's'} · ${info.state} · ${info.zone}`,
      });
    }

    const states = new Map<string, number>();
    for (const p of master) states.set(p.state, (states.get(p.state) ?? 0) + 1);
    for (const [state, count] of states) {
      if (!startsWith(state, q)) continue;
      results.push({
        kind: 'state',
        value: state,
        label: state,
        meta: `${count} pincode${count === 1 ? '' : 's'}`,
      });
    }

    // Only the zones this mode actually runs. Air is twelve hubs against surface's 21
    // clusters, and offering a zone the mode does not serve invents an unquotable lane.
    const zones: readonly string[] = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
    for (const zone of zones) {
      if (!startsWith(zone, q)) continue;
      results.push({ kind: 'zone', value: zone, label: zone, meta: `Zone · ${mode}` });
    }

    for (const group of ZONE_GROUPS) {
      if (!startsWith(group.name, q) && !startsWith(group.key, q)) continue;
      results.push({
        kind: 'group',
        value: group.key,
        label: group.name,
        meta: group.description,
      });
    }
  }

  if (!q || startsWith('pan-india', q) || startsWith('any', q)) {
    results.push({
      kind: 'any',
      value: '',
      label: 'Pan-India',
      meta: 'Anything not covered by a more specific rule',
    });
  }

  return results.sort((a, b) => endpointSpecificity(b.kind) - endpointSpecificity(a.kind));
}
