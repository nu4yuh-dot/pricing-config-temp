import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { draftVersion, liveVersion, findCard } from '../../../../../data/rate-cards';
import { AIR_ZONES, SURFACE_ZONES } from '../../../../../domain/zones';
import type { StoredMode } from '../../../../../domain/types';

/**
 * Network coverage: which lanes each mode actually serves.
 *
 * Serviceability is edited per lane on the rates page (Served / Not served); this is
 * the overview that shows where the gaps are, per mode, at a glance.
 */
export default async function NetworkPage({ params }: { params: Promise<{ card: string }> }) {
  const { card: cardKey } = await params;
  const user = await currentUser();
  if (!user) notFound();
  const card = await findCard(cardKey);
  if (!card) notFound();

  const [draft, live] = await Promise.all([draftVersion(cardKey), liveVersion(cardKey)]);

  const modes: StoredMode[] = ['surface', 'air', 'rail'];

  const coverage = modes.map((mode) => {
    const zones = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
    const grid = draft.data.grids[mode].minCharge;
    const liveGrid = live.data.grids[mode].minCharge;

    let served = 0;
    let total = 0;
    let opened = 0;
    let closed = 0;

    for (const origin of zones) {
      for (const destination of zones) {
        total++;
        const now = grid[origin]?.[destination] ?? null;
        const before = liveGrid[origin]?.[destination] ?? null;
        if (now !== null) served++;
        if (now !== null && before === null) opened++;
        if (now === null && before !== null) closed++;
      }
    }

    return { mode, zones, served, total, opened, closed, grid };
  });

  return (
    <>
      <h2>Network &amp; serviceability</h2>
      <p className="lede">
        Which lanes we actually carry, per mode. A lane we do not carry cannot be quoted at all —
        the calculator declines and the booking site refuses it, which is different from pricing it
        high. Open or close a lane on the <a href={`/console/${cardKey}/rates`}>Lane rates</a> page.
      </p>

      <div className="stats">
        {coverage.map((entry) => (
          <div className="stat" key={entry.mode}>
            <div className="k">{entry.mode}</div>
            <div className="v">
              {entry.served}
              <span style={{ fontSize: 13, color: 'var(--ink-faint)' }}> / {entry.total}</span>
            </div>
            <div className="sub">
              {Math.round((entry.served / entry.total) * 100)}% of lanes carried
              {entry.opened > 0 && ` · ${entry.opened} opening`}
              {entry.closed > 0 && ` · ${entry.closed} closing`}
            </div>
          </div>
        ))}
      </div>

      {coverage.map((entry) => (
        <div className="panel" key={entry.mode}>
          <header>
            <h3>
              {entry.mode === 'air' ? 'Air' : entry.mode === 'rail' ? 'Rail' : 'Surface'} coverage
            </h3>
            <span className="hint">
              {entry.zones.length} zones · ● we carry it · · we do not
            </span>
          </header>
          <div className="body" style={{ overflowX: 'auto' }}>
            <table className="lanes">
              <thead>
                <tr>
                  <th className="left">From \ To</th>
                  {entry.zones.map((zone) => (
                    <th key={zone}>{zone}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entry.zones.map((origin) => (
                  <tr key={origin}>
                    <td className="left">
                      <strong>{origin}</strong>
                    </td>
                    {entry.zones.map((destination) => {
                      const served = (entry.grid[origin]?.[destination] ?? null) !== null;
                      return (
                        <td
                          key={destination}
                          title={`${origin} → ${destination}: ${served ? 'carried' : 'not carried — quotes declined'}`}
                          style={{ color: served ? 'var(--approved)' : 'var(--rule-strong)' }}
                        >
                          {served ? '●' : '·'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="panel">
        <header>
          <h3>Zones</h3>
          <span className="hint">Renaming is a normal edit; adding or removing is a migration</span>
        </header>
        <div className="body">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Industrial belt</th>
                <th>Air hub</th>
              </tr>
            </thead>
            <tbody>
              {SURFACE_ZONES.map((zone) => (
                <tr key={zone}>
                  <td>
                    <strong>{zone}</strong>
                  </td>
                  <td>{draft.data.zones.surface[zone]?.belt ?? '—'}</td>
                  <td style={{ color: 'var(--ink-faint)' }}>
                    {AIR_ZONES.includes(zone as never)
                      ? (draft.data.zones.air[zone]?.city ?? '—')
                      : 'no air hub'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ color: 'var(--ink-faint)', fontSize: 11.5, marginBottom: 0 }}>
            Adding or removing a zone reshapes every matrix — {SURFACE_ZONES.length}×
            {SURFACE_ZONES.length} per grid — so it is handled as an explicit migration rather than
            an edit here.
          </p>
        </div>
      </div>
    </>
  );
}
