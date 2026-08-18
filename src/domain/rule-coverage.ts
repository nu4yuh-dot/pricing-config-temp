import { matchesEndpoint, type Endpoint } from './lane-rules';
import type { Pincode, StoredMode } from './types';

/**
 * Every pincode one end of a rule selects, grouped by city.
 *
 * This is the number that makes the case for rules over cells: a state endpoint is one
 * stored rule and four figures of pincodes, where the cell model needed a row for each
 * lane it touched. Somebody adding a broad rule should see its blast radius before they
 * add it, not after an approver asks why a proposal has 1,681 lines.
 *
 * Computed with the same matcher that prices, so the preview cannot drift into promising
 * coverage the resolver would not actually give.
 */

export interface CoverageSummary {
  pincodes: number;
  /** Largest city first — the count is mostly a statement about the biggest ones. */
  cities: { city: string; pincodes: number[] }[];
}

export function coverageOf(
  endpoint: Endpoint,
  master: readonly Pincode[],
  mode: StoredMode,
): CoverageSummary {
  const byCity = new Map<string, number[]>();
  let total = 0;

  for (const pincode of master) {
    if (!matchesEndpoint(endpoint, pincode, mode)) continue;
    total += 1;
    // A pincode whose district never resolved still ships, so it is counted and named
    // rather than quietly dropped from a total somebody is about to trust.
    const city = pincode.city ?? 'Unknown city';
    const list = byCity.get(city);
    if (list) list.push(pincode.pincode);
    else byCity.set(city, [pincode.pincode]);
  }

  return {
    pincodes: total,
    cities: [...byCity.entries()]
      .map(([city, pincodes]) => ({ city, pincodes }))
      .sort((a, b) => b.pincodes.length - a.pincodes.length || a.city.localeCompare(b.city)),
  };
}
