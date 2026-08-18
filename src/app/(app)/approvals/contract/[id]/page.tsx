import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { proposalById, findCustomer } from '../../../../../data/customers';
import { describeScopeChange, describeLockChange } from '../../../../../customers/proposal';
import { decideContractProposal } from '../../../../../app/console-actions';

const when = (date?: Date) =>
  date ? new Date(date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default async function ContractProposalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [user, proposal] = await Promise.all([currentUser(), proposalById(id)]);
  if (!proposal) notFound();

  const customer = await findCustomer(proposal.customerCode);
  const reviewer = user ? can(user.role, 'review-change-request') : false;
  const isOwn = user?.id === proposal.submittedBy.id;
  const decidable = reviewer && proposal.status === 'pending';

  const discounts = proposal.changes.filter(
    (change) => change.pctChange !== null && change.pctChange < 0,
  );
  const increases = proposal.changes.filter(
    (change) => change.pctChange !== null && change.pctChange > 0,
  );
  const deepest = discounts.reduce(
    (worst, change) => Math.min(worst, change.pctChange as number),
    0,
  );

  return (
    <div className="page">
      <div className="page-inner">
        <p style={{ margin: 0 }}>
          <Link href="/approvals" style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
            ← Approvals
          </Link>
        </p>
        <h2>
          Contract proposal — {customer?.name ?? proposal.customerCode}{' '}
          <span
            className={`chip ${
              proposal.status === 'pending'
                ? 'pending'
                : proposal.status === 'approved'
                  ? 'live'
                  : proposal.status === 'rejected'
                    ? 'rejected'
                    : 'draft'
            }`}
          >
            {proposal.status.replace('-', ' ')}
          </span>
        </h2>
        <p className="lede">
          Proposed by <strong>{proposal.submittedBy.name}</strong> on {when(proposal.submittedAt)} ·{' '}
          {proposal.changes.length} negotiated rate{proposal.changes.length === 1 ? '' : 's'}
          {proposal.scopeChanges.length > 0 && ` · ${proposal.scopeChanges.length} coverage change`}
          {proposal.reviewedBy && (
            <>
              {' '}
              · reviewed by <strong>{proposal.reviewedBy.name}</strong> on{' '}
              {when(proposal.reviewedAt)}
            </>
          )}
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">Discounts</div>
            <div className="v" style={{ color: 'var(--approved)' }}>
              {discounts.length}
            </div>
            {discounts.length > 0 && (
              <div className="sub">Deepest {deepest.toFixed(1)}%</div>
            )}
          </div>
          <div className="stat">
            <div className="k">Increases</div>
            <div className={increases.length ? 'v' : 'v muted'} style={increases.length ? { color: 'var(--rejected)' } : {}}>
              {increases.length}
            </div>
          </div>
          <div className="stat">
            <div className="k">Cells stored if approved</div>
            <div className="v">
              {Object.keys(customer?.liveTerms.overrides ?? {}).length + proposal.changes.length}
            </div>
            <div className="sub">Rather than 4,104</div>
          </div>
        </div>

        {isOwn && proposal.status === 'pending' && (
          <div className="callout">
            <strong>You proposed this</strong>
            You can approve it yourself, but it will be recorded as{' '}
            <strong>self-approved</strong> in the audit log, because no second person has
            checked these rates.
          </div>
        )}
        {proposal.selfApproved && (
          <div className="callout">
            <strong>Self-approved</strong>
            {proposal.reviewedBy?.name} both proposed and approved this contract.
          </div>
        )}

        {proposal.scopeChanges.length > 0 && (
          <>
            <h3>Coverage</h3>
            <div className="callout info">
              <strong>Contract coverage would change</strong>
              <ul>
                {proposal.scopeChanges.map((change, index) => (
                  <li key={index}>{describeScopeChange(change)}</li>
                ))}
              </ul>
              Coverage is agreed as a whole rather than line by line — a partly-approved scope would
              leave a contract covering lanes nobody signed off.
            </div>
          </>
        )}

        {proposal.lockChange && (
          <>
            <h3>Price lock</h3>
            <div className="callout info">
              <strong>{describeLockChange(proposal.lockChange)}</strong>
              <p style={{ margin: '6px 0 0' }}>
                No price moves today — a locked rate is what the card already charges. What changes
                is the future: these lanes stop following base-card increases until the lock comes
                off. Agreed as a whole, like coverage.
              </p>
            </div>
          </>
        )}

        <form action={decideContractProposal.bind(null, id)}>
          <h3>Negotiated rates</h3>
          {proposal.changes.length === 0 ? (
            <p style={{ color: 'var(--ink-faint)' }}>
              No rate changes — this proposal only alters what the contract covers or locks.
            </p>
          ) : (
            <div className="scroll-x">
              <table className="data">
                <thead>
                  <tr>
                    <th>What</th>
                    <th style={{ textAlign: 'right' }}>Standard</th>
                    <th style={{ textAlign: 'right' }}>Proposed</th>
                    <th style={{ textAlign: 'right' }}>Δ</th>
                    {decidable ? <th>Decision</th> : <th>Outcome</th>}
                  </tr>
                </thead>
                <tbody>
                  {proposal.changes.map((change) => (
                    <tr key={change.bind}>
                      <td>
                        {change.label}
                        <div className="ref" style={{ fontSize: 10.5 }}>
                          {change.sheet} · {change.cellRef}
                        </div>
                      </td>
                      <td className="num">{change.oldValue ?? '—'}</td>
                      <td className="num">
                        <strong>{change.newValue === null ? 'not served' : change.newValue}</strong>
                      </td>
                      <td className="num">
                        {change.pctChange === null ? (
                          '—'
                        ) : (
                          <span className={`delta ${change.pctChange > 0 ? 'up' : 'down'}`}>
                            {change.pctChange > 0 ? '+' : ''}
                            {change.pctChange.toFixed(1)}%
                          </span>
                        )}
                      </td>
                      {decidable ? (
                        <td>
                          <select name={`decision:${change.bind}`} defaultValue="approved">
                            <option value="approved">Approve</option>
                            <option value="rejected">Reject</option>
                          </select>
                          <input
                            name={`comment:${change.bind}`}
                            placeholder="reason"
                            size={14}
                            style={{ marginLeft: 4 }}
                          />
                        </td>
                      ) : (
                        <td>
                          {change.decision ? (
                            <span
                              className={`chip ${change.decision === 'approved' ? 'live' : 'rejected'}`}
                            >
                              {change.decision}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--ink-faint)' }}>undecided</span>
                          )}
                          {change.comment && (
                            <div style={{ color: 'var(--rejected)', fontSize: 11 }}>
                              {change.comment}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {decidable && (
            <>
              <h3>Decide</h3>
              <div className="field" style={{ maxWidth: 560 }}>
                <label htmlFor="comment">Note for the team (optional)</label>
                <textarea id="comment" name="comment" rows={2} />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="approve" type="submit" name="intent" value="approve-all">
                  {isOwn ? 'Self-approve the contract' : 'Approve the contract'}
                </button>
                <button type="submit" name="intent" value="per-line">
                  Apply the decisions above
                </button>
                <button className="reject" type="submit" name="intent" value="reject-all">
                  Reject
                </button>
              </div>
              <p style={{ color: 'var(--ink-faint)', marginTop: 10, fontSize: 11.5 }}>
                Approved rates are stored as overrides on this customer only. Everything not
                negotiated keeps following the base card, including future changes to it.
              </p>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
