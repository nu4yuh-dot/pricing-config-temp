import Link from 'next/link';
import {
  searchPincodes,
  distinctStates,
  coverageByState,
  coverageByArea,
  zonesInState,
} from '../../../data/pincodes';
import { SURFACE_ZONES, AIR_ZONES } from '../../../domain/zones';

/**
 * 19,494 rows is too many to scroll, so this searches rather than paginating
 * blindly. The other tabs are grids because a rate matrix is small and spatial;
 * this is a database table and is treated as one.
 */
export default async function PincodesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    state?: string;
    zone?: string;
    mode?: string;
    oda?: string;
    page?: string;
    view?: string;
  }>;
}) {
  const params = await searchParams;
  const mode = (params.mode === 'air' || params.mode === 'rail' ? params.mode : 'surface') as
    | 'air'
    | 'surface'
    | 'rail';
  const page = Math.max(1, Number(params.page ?? 1));
  const perPage = 100;

  const view = params.view === 'browse' ? 'browse' : 'search';

  // Browsing is state -> area -> pincodes, which is the grain the data actually has:
  // the master holds `area` and `state`, not a city.
  const [byState, byArea, zoneSpread] =
    view === 'browse'
      ? await Promise.all([
          coverageByState(mode),
          params.state ? coverageByArea(params.state, mode) : Promise.resolve([]),
          params.state ? zonesInState(params.state, mode) : Promise.resolve([]),
        ])
      : [[], [], []];

  const [{ rows, total }, states] = await Promise.all([
    searchPincodes({
      ...(params.q ? { search: params.q } : {}),
      ...(params.state ? { state: params.state } : {}),
      ...(params.zone ? { zone: params.zone } : {}),
      ...(params.oda === 'on' ? { odaOnly: true } : {}),
      mode,
      limit: perPage,
      skip: (page - 1) * perPage,
    }),
    distinctStates(),
  ]);

  const zones = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
  const pages = Math.ceil(total / perPage);

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Pincode Master</h2>
        <p className="lede">
          Every serviceable pincode with its zone, hub and ODA distance for each mode. Shared by all
          three rate cards — this is operational data, not pricing, and it was identical in all three
          source workbooks.
        </p>

        <div className="pill-list" style={{ marginTop: 0, marginBottom: 16 }}>
          <Link
            className={`pill${view === 'search' ? ' on' : ''}`}
            href={`/pincodes?mode=${mode}`}
          >
            Search
          </Link>
          <Link
            className={`pill${view === 'browse' ? ' on' : ''}`}
            href={`/pincodes?view=browse&mode=${mode}`}
          >
            Browse by state
          </Link>
        </div>

        {view === 'browse' && (
          <>
            {params.state && (
              <>
                <h3 style={{ marginTop: 0 }}>
                  {params.state} — zones it prices from{' '}
                  <Link
                    href={`/pincodes?view=browse&mode=${mode}`}
                    style={{ fontWeight: 400, fontSize: 12 }}
                  >
                    ← all states
                  </Link>
                </h3>
                <div className="pill-list" style={{ marginTop: 0, marginBottom: 16 }}>
                  {zoneSpread.map((entry) => (
                    <span className="pill" key={entry.zone ?? 'none'}>
                      {entry.zone ?? 'unmapped'} · {entry.pincodes.toLocaleString('en-IN')}
                    </span>
                  ))}
                </div>

                <h3>{params.state} — areas ({byArea.length})</h3>
                <div className="scroll-x">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Area</th>
                        <th style={{ textAlign: 'right' }}>Pincodes</th>
                        <th style={{ textAlign: 'right' }}>Serviceable</th>
                        <th style={{ textAlign: 'right' }}>ODA</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {byArea.map((row) => (
                        <tr key={row.name}>
                          <td>{row.name}</td>
                          <td className="num">{row.total}</td>
                          <td className="num">
                            {row.serviceable === row.total ? (
                              <span className="chip live">all</span>
                            ) : row.serviceable === 0 ? (
                              <span className="chip rejected">none</span>
                            ) : (
                              `${row.serviceable} of ${row.total}`
                            )}
                          </td>
                          <td className="num" style={{ color: row.oda ? 'var(--pending)' : 'var(--ink-faint)' }}>
                            {row.oda || '—'}
                          </td>
                          <td>
                            <Link
                              className="btn"
                              href={`/pincodes?mode=${mode}&q=${encodeURIComponent(row.name)}`}
                            >
                              Pincodes →
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="scroll-x" style={{ marginBottom: 18 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>State</th>
                    <th style={{ textAlign: 'right' }}>Pincodes</th>
                    <th style={{ textAlign: 'right' }}>Serviceable</th>
                    <th style={{ textAlign: 'right' }}>ODA</th>
                    <th>Coverage</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {byState.map((row) => {
                    const pct = row.total === 0 ? 0 : Math.round((row.serviceable / row.total) * 100);
                    return (
                      <tr
                        key={row.name}
                        // The chosen state stays marked, so the list still shows where you are.
                        className={row.name === params.state ? 'selected' : undefined}
                      >
                        <td>
                          <strong>{row.name}</strong>
                        </td>
                        <td className="num">{row.total.toLocaleString('en-IN')}</td>
                        <td className="num">{row.serviceable.toLocaleString('en-IN')}</td>
                        <td className="num" style={{ color: row.oda ? 'var(--pending)' : 'var(--ink-faint)' }}>
                          {row.oda.toLocaleString('en-IN')}
                        </td>
                        <td>
                          <span
                            style={{
                              display: 'inline-block',
                              width: 90,
                              height: 8,
                              background: 'var(--band-strong)',
                              borderRadius: 4,
                              overflow: 'hidden',
                              verticalAlign: 'middle',
                            }}
                          >
                            <span
                              style={{
                                display: 'block',
                                width: `${pct}%`,
                                height: '100%',
                                background: pct > 80 ? 'var(--approved)' : pct > 40 ? 'var(--pending)' : 'var(--rejected)',
                              }}
                            />
                          </span>{' '}
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{pct}%</span>
                        </td>
                        <td>
                          <Link
                            className="btn"
                            href={`/pincodes?view=browse&mode=${mode}&state=${encodeURIComponent(row.name)}`}
                          >
                            Areas →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

          </>
        )}

        {view === 'search' && (
        <>
        <form className="inline-form" method="get">
          <div className="field">
            <label htmlFor="q">Pincode or area</label>
            <input id="q" name="q" defaultValue={params.q ?? ''} placeholder="411 or Hinjewadi" />
          </div>
          <div className="field">
            <label htmlFor="mode">Mode</label>
            <select id="mode" name="mode" defaultValue={mode}>
              <option value="surface">Surface</option>
              <option value="air">Air</option>
              <option value="rail">Rail</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="state">State</label>
            <select id="state" name="state" defaultValue={params.state ?? ''}>
              <option value="">any</option>
              {states.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="zone">Zone</label>
            <select id="zone" name="zone" defaultValue={params.zone ?? ''}>
              <option value="">any</option>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="oda">ODA only</label>
            <input id="oda" name="oda" type="checkbox" defaultChecked={params.oda === 'on'} />
          </div>
          <button className="primary" type="submit">
            Search
          </button>
        </form>

        <h3>
          {total.toLocaleString('en-IN')} matching · showing {rows.length}
          {pages > 1 && ` · page ${page} of ${pages}`}
        </h3>

        <div className="scroll-x">
          <table className="data">
            <thead>
              <tr>
                <th>Pincode</th>
                <th>Area</th>
                <th>State</th>
                <th>Serviceable</th>
                <th>Hub</th>
                <th>Zone</th>
                <th style={{ textAlign: 'right' }}>EDL km</th>
                <th>ODA</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const info = row[mode];
                return (
                  <tr key={row.pincode}>
                    <td className="ref">{row.pincode}</td>
                    <td>{row.area}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>{row.state}</td>
                    <td>
                      {info.serviceable ? (
                        <span className="chip live">yes</span>
                      ) : (
                        <span className="chip rejected">no</span>
                      )}
                    </td>
                    <td>{info.hub}</td>
                    <td>
                      <strong>{info.zone}</strong>
                    </td>
                    <td className="num">{info.edlKm}</td>
                    <td>
                      {info.oda ? (
                        <span className="chip pending count">{info.odaCategory}</span>
                      ) : (
                        <span style={{ color: 'var(--ink-faint)' }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ color: 'var(--ink-faint)' }}>
                    Nothing matched that search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {pages > 1 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            {page > 1 && (
              <a
                className="btn"
                href={`?${new URLSearchParams({ ...params, page: String(page - 1) } as Record<string, string>)}`}
              >
                ← Previous
              </a>
            )}
            {page < pages && (
              <a
                className="btn"
                href={`?${new URLSearchParams({ ...params, page: String(page + 1) } as Record<string, string>)}`}
              >
                Next →
              </a>
            )}
          </div>
        )}

        </>
        )}

        <h3>Bulk changes</h3>
        <p style={{ color: 'var(--ink-soft)', maxWidth: '66ch' }}>
          Editing thousands of rows by hand is where mistakes come from. Export the filtered set,
          change it in Excel, and import it back — the import shows a diff of every affected row for
          approval before anything is written.
        </p>
      </div>
    </div>
  );
}
