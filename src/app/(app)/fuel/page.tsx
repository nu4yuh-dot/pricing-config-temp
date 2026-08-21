import { redirect } from 'next/navigation';
import { currentUser } from '../../../auth/session';
import { fuelHistory, fuelMovements } from '../../../data/fuel-history';

/**
 * The fuel index, read out of the card versions that already hold it.
 *
 * Fuel is a percentage on a rate card, and every approved change writes a version. So the
 * history of what fuel was actually charged is already in the database — it has simply
 * never been read this way.
 *
 * Derived rather than logged on purpose. A log written beside the change can disagree with
 * the change; a reading taken from the version is the number the engine priced from, so it
 * cannot.
 */
export default async function FuelPage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  const readings = await fuelHistory();
  const movements = fuelMovements(readings);
  const current = new Map<string, (typeof readings)[number]>();
  for (const reading of readings) {
    if (!current.has(reading.cardKey)) current.set(reading.cardKey, reading);
  }

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Fuel index</h2>
        <p className="lede">
          What fuel is on each card now, and every time it moved. Read from the card versions
          themselves, so it is the surcharge that was actually charged rather than a note
          somebody made alongside.
        </p>

        <h3>Where fuel stands</h3>
        <div className="gridscroll">
          <table className="data">
            <thead>
              <tr>
                <th>Card</th>
                <th style={{ textAlign: 'right' }}>Surface</th>
                <th style={{ textAlign: 'right' }}>Air</th>
                <th style={{ textAlign: 'right' }}>Rail</th>
                <th>Since</th>
                <th>Approved by</th>
              </tr>
            </thead>
            <tbody>
              {[...current.values()].map((reading) => (
                <tr key={reading.cardKey}>
                  <td>
                    <strong>{reading.cardName}</strong>
                    <div className="sub">version {reading.version}</div>
                  </td>
                  <td className="num">{reading.surface}%</td>
                  <td className="num">{reading.air}%</td>
                  <td className="num">{reading.rail}%</td>
                  <td>{reading.at.toLocaleDateString('en-IN', { dateStyle: 'medium' })}</td>
                  <td>{reading.approvedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>When it moved ({movements.length})</h3>
        <p className="lede" style={{ marginTop: 0 }}>
          Only the versions where fuel actually changed. Most approvals move a rate, not the
          index — listing every version would bury the ones that matter.
        </p>
        {movements.length === 0 ? (
          <p className="empty">
            Fuel has not changed since these cards were first approved.
          </p>
        ) : (
          <div className="gridscroll">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Mode</th>
                  <th style={{ textAlign: 'right' }}>From</th>
                  <th style={{ textAlign: 'right' }}>To</th>
                  <th style={{ textAlign: 'right' }}>Change</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((movement, at) => (
                  <tr key={`${movement.version}-${movement.mode}-${at}`}>
                    <td>{movement.at.toLocaleDateString('en-IN', { dateStyle: 'medium' })}</td>
                    <td>{movement.mode}</td>
                    <td className="num">{movement.from}%</td>
                    <td className="num">{movement.to}%</td>
                    <td className="num">
                      {movement.change > 0 ? '+' : ''}
                      {movement.change} pts
                    </td>
                    <td className="ref">v{movement.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
