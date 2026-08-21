import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import { listCarriers } from '../../../data/carriers';
import { unpriceableReason, RATE_STRUCTURE_LABELS } from '../../../domain/carriers';
import CarrierForm from '../../../components/console/CarrierForm';
import { saveCarrierRecord, toggleCarrier } from '../../console-actions';
import RowAction from '../../../components/console/RowAction';

/**
 * Carriers — who actually moves the freight.
 *
 * Until recently a carrier was a value in the code, so taking one on meant a release. That
 * is the wrong shape for a commercial fact: carriers are signed and dropped by the
 * business. Here they are rows.
 *
 * The column that matters is how the carrier's tariff is shaped. A carrier that prices by
 * zone and weight — most of them — needs nothing but a rate card. One that prices by some
 * other question needs an engine, and saying so on the screen is better than quoting a
 * number nobody can honour.
 */
export default async function CarriersPage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  const carriers = await listCarriers();
  const editable = can(user.role, 'edit-draft');
  const blocked = carriers.filter((carrier) => unpriceableReason(carrier) !== null);

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Carriers</h2>
        <p className="lede">
          Who moves the freight, and whether we can price them. Adding a carrier is a row here
          plus a rate card — no release — unless their tariff asks a question this engine cannot
          answer yet.
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">Carriers</div>
            <div className="v">{carriers.length}</div>
          </div>
          <div className="stat">
            <div className="k">Quotable</div>
            <div className="v">{carriers.length - blocked.length}</div>
          </div>
          <div className="stat">
            <div className="k">Not quotable</div>
            <div className={blocked.length ? 'v' : 'v muted'}>{blocked.length}</div>
            <div className="sub">Switched off, no card, or no engine</div>
          </div>
        </div>

        <div className="gridscroll">
          <table className="data">
            <thead>
              <tr>
                <th>Carrier</th>
                <th>How they price</th>
                <th>Rate cards</th>
                <th style={{ textAlign: 'right' }}>Multiplier</th>
                <th>Cut-off</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {carriers.map((carrier) => {
                const reason = unpriceableReason(carrier);
                return (
                  <tr key={carrier.carrierId}>
                    <td>
                      <strong>{carrier.name}</strong>
                      <div className="sub">{carrier.carrierId}</div>
                    </td>
                    <td>
                      {RATE_STRUCTURE_LABELS[carrier.rateStructure]}
                      {carrier.dgCertified && <div className="sub">Carries dangerous goods</div>}
                    </td>
                    <td>
                      {carrier.cardKeys.length === 0 ? (
                        <span className="muted">none loaded</span>
                      ) : (
                        carrier.cardKeys.map((key) => (
                          <div key={key}>
                            <Link href={`/console/${key}/rates`}>{key}</Link>
                          </div>
                        ))
                      )}
                    </td>
                    <td className="num">
                      {carrier.rateMultiplier && carrier.rateMultiplier !== 1
                        ? `× ${carrier.rateMultiplier}`
                        : '—'}
                    </td>
                    <td>{carrier.cutoffTime ?? '—'}</td>
                    <td>
                      {reason ? (
                        <>
                          <span className="chip pending">not quotable</span>
                          <div className="sub">{reason}</div>
                        </>
                      ) : (
                        <span className="chip live">quotable</span>
                      )}
                    </td>
                    <td>
                      {editable && (
                        <RowAction
                          label={carrier.active ? 'Deactivate' : 'Reactivate'}
                          confirmLabel={`${carrier.active ? 'Deactivate' : 'Reactivate'} ${carrier.name}`}
                          run={() => toggleCarrier(carrier.carrierId, !carrier.active)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {editable ? (
          <>
            <h3>Add or edit a carrier</h3>
            <p className="lede" style={{ marginTop: 0 }}>
              Entering an existing code edits that carrier. Rate cards are attached by loading a
              card for the carrier, not typed here.
            </p>
            <CarrierForm action={saveCarrierRecord} />
          </>
        ) : (
          <p className="empty">Your role ({user.role}) is read-only here.</p>
        )}
      </div>
    </div>
  );
}
