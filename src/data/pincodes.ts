import { cache } from 'react';
import { db, COLLECTIONS } from './mongo';
import { withCity } from '../domain/city';
import type { Pincode } from '../domain/types';

/**
 * Pincodes are shared across all three rate cards — they are operational data, not
 * pricing, and were identical in all three source workbooks.
 *
 * 19,494 rows is too many to scroll, so the UI searches rather than paginates
 * blindly, and bulk changes arrive by CSV with a diff preview.
 */

export interface PincodeQuery {
  /** Matches a pincode prefix or an area name. */
  search?: string;
  state?: string;
  zone?: string;
  /** Restrict to rows flagged out-of-delivery-area for the given mode. */
  odaOnly?: boolean;
  mode?: 'air' | 'surface' | 'rail';
  limit?: number;
  skip?: number;
}

async function collection() {
  return (await db()).collection<Pincode>(COLLECTIONS.pincodes);
}

/**
 * City is derived on the way out rather than stored.
 *
 * It comes from the district the Bluedart merge already carries, so writing it into the
 * collection would duplicate a value that is only ever as good as its source — and would
 * need a migration every time the district-to-city mapping is refined. Every read path
 * that hands out a `Pincode` goes through here, because a lane rule matching on city has
 * to see the same city everywhere.
 */
export async function findPincode(pincode: number): Promise<Pincode | null> {
  const row = await (await collection()).findOne({ pincode });
  return row === null ? null : withCity(row);
}

/** Both endpoints of a quote in one round trip. */
export async function findPincodePair(
  from: number,
  to: number,
): Promise<{ origin: Pincode | null; destination: Pincode | null }> {
  const rows = (await (await collection()).find({ pincode: { $in: [from, to] } }).toArray()).map(
    withCity,
  );
  return {
    origin: rows.find((row) => row.pincode === from) ?? null,
    destination: rows.find((row) => row.pincode === to) ?? null,
  };
}

export async function searchPincodes(
  query: PincodeQuery,
): Promise<{ rows: Pincode[]; total: number }> {
  const mode = query.mode ?? 'surface';
  const filter: Record<string, unknown> = {};

  if (query.search) {
    const trimmed = query.search.trim();
    if (/^\d+$/.test(trimmed)) {
      // Prefix match on the numeric pincode, done as a range so the index is used.
      const digits = trimmed.length;
      const lower = Number(trimmed.padEnd(6, '0'));
      const upper = Number(trimmed.padEnd(6, '9'));
      filter.pincode = digits >= 6 ? Number(trimmed) : { $gte: lower, $lte: upper };
    } else {
      filter.area = { $regex: escapeRegExp(trimmed), $options: 'i' };
    }
  }
  if (query.state) filter.state = query.state;
  if (query.zone) filter[`${mode}.zone`] = query.zone;
  if (query.odaOnly) filter[`${mode}.oda`] = true;

  const rows = await (await collection())
    .find(filter)
    .sort({ pincode: 1 })
    .skip(query.skip ?? 0)
    .limit(query.limit ?? 100)
    .toArray();
  const total = await (await collection()).countDocuments(filter);

  return { rows: rows.map(withCity), total };
}

export async function distinctStates(): Promise<string[]> {
  return ((await (await collection()).distinct('state')) as string[]).sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/**
 * Serviceability rolled up by state, then by area.
 *
 * Navigation goes state → area → pincodes. A city is now derived from district, so a
 * city level here is possible and is worth having — the redesign asks for it — but it is
 * a separate change: these are aggregations run in the database, and city exists only
 * after a row is read, so grouping by it means either storing city or moving the rollup
 * out of Mongo. Left as area until that is decided rather than half-done.
 */
export interface CoverageRow {
  name: string;
  total: number;
  serviceable: number;
  oda: number;
}

export async function coverageByState(
  mode: 'air' | 'surface' | 'rail' = 'surface',
): Promise<CoverageRow[]> {
  const rows = await (await collection())
    .aggregate<CoverageRow>([
      {
        $group: {
          _id: '$state',
          total: { $sum: 1 },
          serviceable: { $sum: { $cond: [`$${mode}.serviceable`, 1, 0] } },
          oda: { $sum: { $cond: [`$${mode}.oda`, 1, 0] } },
        },
      },
      { $project: { _id: 0, name: '$_id', total: 1, serviceable: 1, oda: 1 } },
      { $sort: { name: 1 } },
    ])
    .toArray();
  return rows;
}

/** Areas within one state, so a long state can still be navigated. */
export async function coverageByArea(
  state: string,
  mode: 'air' | 'surface' | 'rail' = 'surface',
  limit = 300,
): Promise<CoverageRow[]> {
  return (await collection())
    .aggregate<CoverageRow>([
      { $match: { state } },
      {
        $group: {
          _id: '$area',
          total: { $sum: 1 },
          serviceable: { $sum: { $cond: [`$${mode}.serviceable`, 1, 0] } },
          oda: { $sum: { $cond: [`$${mode}.oda`, 1, 0] } },
        },
      },
      { $project: { _id: 0, name: '$_id', total: 1, serviceable: 1, oda: 1 } },
      { $sort: { name: 1 } },
      { $limit: limit },
    ])
    .toArray();
}

/** Which zones a state's pincodes map to, and how many fall in each. */
export async function zonesInState(
  state: string,
  mode: 'air' | 'surface' | 'rail' = 'surface',
): Promise<{ zone: string; pincodes: number }[]> {
  return (await collection())
    .aggregate<{ zone: string; pincodes: number }>([
      { $match: { state } },
      { $group: { _id: `$${mode}.zone`, pincodes: { $sum: 1 } } },
      { $project: { _id: 0, zone: '$_id', pincodes: 1 } },
      { $sort: { pincodes: -1 } },
    ])
    .toArray();
}

/**
 * The whole master, for the geography search and coverage preview.
 *
 * 19,494 rows is a lot to hold, but both callers need to count across all of them —
 * "how many pincodes does Maharashtra cover" cannot be answered from a page of 100 —
 * and the collection is static operational data, so it is cached for the process.
 */
let cached: Pincode[] | null = null;

export async function allPincodes(): Promise<Pincode[]> {
  if (cached) return cached;
  const rows = await (await collection()).find({}).sort({ pincode: 1 }).toArray();
  cached = rows.map(withCity);
  return cached;
}

/**
 * Every zone we actually serve.
 *
 * Read from the pincode master rather than kept as a list, because a list would be a
 * second place for the truth to live and would go stale the first time a zone was added.
 * Memoised for the request, since it is asked on the quoting path.
 */
export const knownZones = cache(async (): Promise<string[]> => {
  const pincodes = await collection();
  const [surface, air, rail] = await Promise.all([
    pincodes.distinct('surface.zone'),
    pincodes.distinct('air.zone'),
    pincodes.distinct('rail.zone'),
  ]);
  return [...new Set([...surface, ...air, ...rail])].filter(
    (zone): zone is string => typeof zone === 'string' && zone !== '',
  );
});
