import Link from 'next/link';
import { pendingRequests, requestHistory, listCards } from '../../../data/rate-cards';
import {
  pendingProposals,
  proposalHistory,
  pendingBookingExceptions,
  bookingExceptionHistory,
  listCustomers,
} from '../../../data/customers';
import { pendingProfileChanges } from '../../../data/customer-profile-changes';
import { pendingContractRequests } from '../../../data/contract-requests';
import ContractRequestRow from '../../../components/console/ContractRequestRow';
import { pushBacklog } from '../../../data/core-push';
import { coreIsConfigured } from '../../../core/client';
import ProfileChangeRow from '../../../components/console/ProfileChangeRow';
import SendToCoreButton from '../../../components/console/SendToCoreButton';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';

const when = (date?: Date) =>
  date ? new Date(date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default async function ApprovalsPage() {
  const user = await currentUser();
  const [
    queue, history, cards, contracts, contractsDone, exceptions, exceptionsDone, customers,
    profileChanges, backlog, customerRequests,
  ] = await Promise.all([
      pendingRequests(),
      requestHistory(30),
      listCards(),
      pendingProposals(),
      proposalHistory(20),
      pendingBookingExceptions(),
      bookingExceptionHistory(20),
      listCustomers(),
      pendingProfileChanges(),
      pushBacklog(),
      pendingContractRequests(),
    ]);
  const cardName = (id: string) =>
    cards.find((card) => card._id.toHexString() === id)?.name ?? 'Unknown card';
  const customerName = (code: string) =>
    customers.find((customer) => customer.code === code)?.name ?? code;

  const reviewer = user ? can(user.role, 'review-change-request') : false;
  const total =
    queue.length + contracts.length + exceptions.length + profileChanges.length +
    customerRequests.length;

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Approvals</h2>
        <p className="lede">
          {reviewer
            ? 'Everything waiting on you: base-card changes, customer contracts, and bookings that fall outside a contract. Nothing here affects a quote or a booking until you decide.'
            : 'What your team has submitted. An admin reviews each one before it takes effect.'}
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">Waiting on you</div>
            <div className={total ? 'v' : 'v muted'}>{total}</div>
          </div>
          <div className="stat">
            <div className="k">Rate card changes</div>
            <div className={queue.length ? 'v' : 'v muted'}>{queue.length}</div>
          </div>
          <div className="stat">
            <div className="k">Contract proposals</div>
            <div className={contracts.length ? 'v' : 'v muted'}>{contracts.length}</div>
          </div>
          <div className="stat">
            <div className="k">Booking exceptions</div>
            <div className={exceptions.length ? 'v' : 'v muted'}>{exceptions.length}</div>
            <div className="sub">Blocking a booking right now</div>
          </div>
          <div className="stat">
            <div className="k">Customer requests</div>
            <div className={customerRequests.length ? 'v' : 'v muted'}>{customerRequests.length}</div>
            <div className="sub">Raised from the enterprise portal</div>
          </div>
          <div className="stat">
            <div className="k">Customer details</div>
            <div className={profileChanges.length ? 'v' : 'v muted'}>{profileChanges.length}</div>
            <div className="sub">Approving also sends them to the core</div>
          </div>
        </div>

        {backlog.queued > 0 && (
          <div className="callout warn">
            <strong>
              {backlog.queued} customer {backlog.queued === 1 ? 'change is' : 'changes are'} waiting
              to reach the SameX core.
            </strong>{' '}
            {coreIsConfigured()
              ? 'Nothing is lost while they wait.'
              : 'The core connection is not configured yet, so they are being held. Nothing is lost — they will send once it is.'}
            {coreIsConfigured() && <SendToCoreButton queued={backlog.queued} />}
          </div>
        )}

        {customerRequests.length > 0 && (
          <>
            <h3>Customer requests ({customerRequests.length})</h3>
            <p className="lede" style={{ marginTop: 0 }}>
              What customers have asked for from the enterprise portal. Accepting one puts the ask
              into their <strong>draft</strong> contract for someone to rate — it does not agree a
              price and nothing reaches a quote until that contract is approved in the ordinary way.
            </p>
            <table className="data">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Customer</th>
                  <th>Asked for</th>
                  <th>Raised</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {customerRequests.map((request) => {
                  const parts: string[] = [];
                  if (request.ask.modes?.length) parts.push(request.ask.modes.join(', '));
                  if (request.ask.lanes?.length)
                    parts.push(
                      `${request.ask.lanes.length} lane${request.ask.lanes.length === 1 ? '' : 's'}`,
                    );
                  if (request.ask.weightBands?.length)
                    parts.push(
                      request.ask.weightBands
                        .map((band) => `${band.from}–${band.to ?? 'no limit'} kg`)
                        .join(', '),
                    );
                  return (
                    <ContractRequestRow
                      key={request.reference}
                      reference={request.reference}
                      customer={customerName(request.customerCode)}
                      code={request.customerCode}
                      asked={parts.join(' · ')}
                      {...(request.note ? { note: request.note } : {})}
                      raisedBy={request.raisedBy}
                      raisedAt={when(request.raisedAt)}
                      proposedCells={request.proposedRates?.length ?? 0}
                      canReview={reviewer}
                    />
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        {profileChanges.length > 0 && (
          <>
            <h3>Customer details ({profileChanges.length})</h3>
            <p className="lede" style={{ marginTop: 0 }}>
              Company master data. Approving one changes what prints on that customer&rsquo;s tax
              invoices, and sends it to the core, where it decides who can sign in to the
              enterprise portal.
            </p>
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>What changed</th>
                  <th>Submitted by</th>
                  <th>Asked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {profileChanges.map((change) => (
                  <ProfileChangeRow
                    key={change._id.toHexString()}
                    id={change._id.toHexString()}
                    customer={customerName(change.customerCode)}
                    code={change.customerCode}
                    changed={change.changed}
                    submittedBy={change.submittedBy.name}
                    submittedAt={when(change.submittedAt)}
                    canReview={reviewer}
                  />
                ))}
              </tbody>
            </table>
          </>
        )}

        {exceptions.length > 0 && (
          <>
            <h3>Booking exceptions ({exceptions.length}) — someone is waiting</h3>
            <table className="data">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Customer</th>
                  <th>Shipment</th>
                  <th style={{ textAlign: 'right' }}>Quoted</th>
                  <th>Asked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {exceptions.map((request) => (
                  <tr key={request.reference}>
                    <td className="ref">{request.reference}</td>
                    <td>
                      <strong>{customerName(request.customerCode)}</strong>
                    </td>
                    <td>
                      {request.mode} · {request.fromPincode} → {request.toPincode} ·{' '}
                      {request.weight} kg
                    </td>
                    <td className="num">
                      ₹{request.quotedTotal.toLocaleString('en-IN')}
                      {request.customerAccepted && (
                        <div className="sub">
                          {request.customerAccepted.total === request.quotedTotal ? (
                            <>customer accepted</>
                          ) : (
                            // Worth seeing: they agreed to a different number from the one
                            // this would bill at, and somebody has to decide which stands.
                            <>
                              accepted ₹
                              {request.customerAccepted.total.toLocaleString('en-IN')} — differs
                            </>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      {when(request.requestedAt)}
                      {request.customerAccepted && (
                        <div className="sub">by {request.customerAccepted.by}</div>
                      )}
                    </td>
                    <td>
                      <Link className="btn" href={`/approvals/exception/${request.reference}`}>
                        {reviewer ? 'Decide' : 'View'}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {contracts.length > 0 && (
          <>
            <h3>Contract proposals ({contracts.length})</h3>
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Proposed by</th>
                  <th>When</th>
                  <th style={{ textAlign: 'right' }}>Rates</th>
                  <th>Coverage</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {contracts.map((proposal) => (
                  <tr key={proposal._id.toHexString()}>
                    <td>
                      <strong>{customerName(proposal.customerCode)}</strong>{' '}
                      <span className="ref">{proposal.customerCode}</span>
                    </td>
                    <td>{proposal.submittedBy.name}</td>
                    <td>{when(proposal.submittedAt)}</td>
                    <td className="num">{proposal.changes.length}</td>
                    <td>
                      {proposal.scopeChanges.length > 0 ? (
                        <span className="chip draft count">
                          {proposal.scopeChanges.length} change
                          {proposal.scopeChanges.length === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--ink-faint)' }}>unchanged</span>
                      )}
                    </td>
                    <td>
                      <Link className="btn" href={`/approvals/contract/${proposal._id.toHexString()}`}>
                        {reviewer ? 'Review' : 'View'}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <h3>Rate card changes ({queue.length})</h3>
        {queue.length === 0 ? (
          <p style={{ color: 'var(--ink-faint)' }}>Nothing is waiting for review.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Card</th>
                <th>Submitted by</th>
                <th>When</th>
                <th>Cells</th>
                <th>Flags</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {queue.map((request) => {
                const warnings = request.findings.filter((f) => f.severity === 'warning').length;
                return (
                  <tr key={request._id.toHexString()}>
                    <td>
                      <strong>{cardName(request.rateCardId)}</strong>
                    </td>
                    <td>{request.submittedBy.name}</td>
                    <td>{when(request.submittedAt)}</td>
                    <td className="num">{request.changes.length}</td>
                    <td>
                      {warnings > 0 ? (
                        <span className="chip pending count">⚠ {warnings}</span>
                      ) : (
                        <span style={{ color: 'var(--ink-faint)' }}>none</span>
                      )}
                    </td>
                    <td>
                      <Link className="btn" href={`/approvals/${request._id.toHexString()}`}>
                        {reviewer ? 'Review' : 'View'}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <h3>Decided — contracts &amp; exceptions</h3>
        {contractsDone.length === 0 && exceptionsDone.length === 0 ? (
          <p style={{ color: 'var(--ink-faint)' }}>Nothing decided yet.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Type</th>
                <th>Subject</th>
                <th>Outcome</th>
                <th>Decided by</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {contractsDone.map((proposal) => (
                <tr key={proposal._id.toHexString()}>
                  <td>Contract</td>
                  <td>{customerName(proposal.customerCode)}</td>
                  <td>
                    <span
                      className={`chip ${
                        proposal.status === 'approved'
                          ? 'live'
                          : proposal.status === 'rejected'
                            ? 'rejected'
                            : 'pending'
                      }`}
                    >
                      {proposal.status.replace('-', ' ')}
                    </span>
                  </td>
                  <td>{proposal.reviewedBy?.name ?? '—'}</td>
                  <td>{when(proposal.reviewedAt)}</td>
                  <td>
                    <Link className="btn" href={`/approvals/contract/${proposal._id.toHexString()}`}>
                      View
                    </Link>
                  </td>
                </tr>
              ))}
              {exceptionsDone.map((request) => (
                <tr key={request.reference}>
                  <td>Booking</td>
                  <td>
                    {customerName(request.customerCode)}{' '}
                    <span className="ref">{request.reference}</span>
                  </td>
                  <td>
                    <span className={`chip ${request.status === 'approved' ? 'live' : 'rejected'}`}>
                      {request.status}
                    </span>
                  </td>
                  <td>{request.decidedBy ?? '—'}</td>
                  <td>{when(request.decidedAt)}</td>
                  <td>
                    <Link className="btn" href={`/approvals/exception/${request.reference}`}>
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3>Decided — rate card changes</h3>
        {history.length === 0 ? (
          <p style={{ color: 'var(--ink-faint)' }}>No decisions recorded yet.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Card</th>
                <th>Outcome</th>
                <th>Submitted by</th>
                <th>Reviewed by</th>
                <th>When</th>
                <th>Cells</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.map((request) => {
                const approved = request.changes.filter((c) => c.decision === 'approved').length;
                const rejected = request.changes.filter((c) => c.decision === 'rejected').length;
                return (
                  <tr key={request._id.toHexString()}>
                    <td>{cardName(request.rateCardId)}</td>
                    <td>
                      <span
                        className={`chip ${
                          request.status === 'approved'
                            ? 'live'
                            : request.status === 'rejected'
                              ? 'rejected'
                              : 'pending'
                        }`}
                      >
                        {request.status.replace('-', ' ')}
                      </span>
                    </td>
                    <td>{request.submittedBy.name}</td>
                    <td>{request.reviewedBy?.name ?? '—'}</td>
                    <td>{when(request.reviewedAt)}</td>
                    <td className="num">
                      {approved} in · {rejected} out
                    </td>
                    <td>
                      <Link className="btn" href={`/approvals/${request._id.toHexString()}`}>
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
