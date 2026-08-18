import { notFound } from 'next/navigation';
import { requestById, listCards } from '../../../../data/rate-cards';
import { currentUser } from '../../../../auth/session';
import { can } from '../../../../auth/roles';
import { decideRequest } from '../../../actions';
import { groupChanges } from '../../../../changes/grouping';

const when = (date?: Date) =>
  date ? new Date(date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

function show(value: string | number | null): string {
  if (value === null) return '—';
  return typeof value === 'number' ? value.toLocaleString('en-IN') : value;
}

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [user, request, cards] = await Promise.all([currentUser(), requestById(id), listCards()]);
  if (!request) notFound();

  const card = cards.find((entry) => entry._id.toHexString() === request.rateCardId);
  const reviewer = user ? can(user.role, 'review-change-request') : false;
  const isOwn = user?.id === request.submittedBy.id;
  // Self-approval is allowed; the warning below makes the missing second opinion plain.
  const decidable = reviewer && request.status === 'pending';

  const findingsByBind = new Map<string, string[]>();
  for (const finding of request.findings) {
    if (!finding.bind) continue;
    if (!findingsByBind.has(finding.bind)) findingsByBind.set(finding.bind, []);
    findingsByBind.get(finding.bind)?.push(finding.message);
  }

  /*
   * Grouped by what somebody was trying to do, not by which tab it landed on.
   *
   * One zone-group edit lands as hundreds of cells, and a reviewer facing that many
   * Approve buttons approves them on trust — which looks like review and is not. The
   * grouping puts the count of lanes and the steepest cut on the heading, so a decision
   * can be taken without opening it, and every underlying change is still listed inside.
   */
  const groups = groupChanges(request.changes);

  const warnings = request.findings.filter((finding) => finding.severity === 'warning');

  return (
    <div className="page">
      <div className="page-inner">
        <h2>
          {card?.name ?? 'Change request'}{' '}
          <span
            className={`chip ${
              request.status === 'pending'
                ? 'pending'
                : request.status === 'approved'
                  ? 'live'
                  : request.status === 'rejected'
                    ? 'rejected'
                    : 'draft'
            }`}
          >
            {request.status.replace('-', ' ')}
          </span>
        </h2>
        <p className="lede">
          Submitted by <strong>{request.submittedBy.name}</strong> on{' '}
          {when(request.submittedAt)} · {groups.length}{' '}
          {groups.length === 1 ? 'decision' : 'decisions'} · {request.changes.length}{' '}
          {request.changes.length === 1 ? 'change' : 'changes'}
          {request.reviewedBy && (
            <>
              {' '}
              · reviewed by <strong>{request.reviewedBy.name}</strong> on {when(request.reviewedAt)}
            </>
          )}
        </p>

        {isOwn && request.status === 'pending' && (
          <div className="callout">
            <strong>You submitted this request</strong>
            Someone else has to approve it. That is what makes the approval step a real second pair
            of eyes rather than a formality.
          </div>
        )}

        {warnings.length > 0 && (
          <div className="callout">
            <strong>
              {warnings.length} {warnings.length === 1 ? 'thing' : 'things'} worth a second look
            </strong>
            <ul>
              {warnings.slice(0, 8).map((finding, index) => (
                <li key={index}>{finding.message}</li>
              ))}
              {warnings.length > 8 && <li>…and {warnings.length - 8} more, marked below.</li>}
            </ul>
          </div>
        )}

        {request.reviewComment && (
          <div className="callout info">
            <strong>Reviewer&rsquo;s note</strong>
            {request.reviewComment}
          </div>
        )}

        <form action={decideRequest.bind(null, id)}>
          {groups.map(({ key, title, lanes, steepestCut, changes }) => (
            <div key={key}>
              <h3>
                {title} — {changes.length} {changes.length === 1 ? 'change' : 'changes'}
                {lanes > 0 && <> · {lanes} {lanes === 1 ? 'lane' : 'lanes'}</>}
                {steepestCut !== null && (
                  <span className="delta down"> steepest {steepestCut.toFixed(1)}%</span>
                )}
              </h3>
              <div className="scroll-x">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Cell</th>
                      <th>What</th>
                      <th style={{ textAlign: 'right' }}>Live</th>
                      <th style={{ textAlign: 'right' }}>Proposed</th>
                      <th style={{ textAlign: 'right' }}>Δ</th>
                      <th>Notes</th>
                      {decidable && <th>Decision</th>}
                      {!decidable && <th>Outcome</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {changes.map((change) => {
                      const notes = findingsByBind.get(change.bind) ?? [];
                      return (
                        <tr key={change.bind}>
                          <td className="ref">{change.cellRef}</td>
                          <td>{change.label}</td>
                          <td className="num">{show(change.oldValue)}</td>
                          <td className="num">
                            <strong>{show(change.newValue)}</strong>
                          </td>
                          <td className="num">
                            {change.pctChange === null ? (
                              <span style={{ color: 'var(--ink-faint)' }}>—</span>
                            ) : (
                              <span className={`delta ${change.pctChange > 0 ? 'up' : 'down'}`}>
                                {change.pctChange > 0 ? '+' : ''}
                                {change.pctChange.toFixed(1)}%
                              </span>
                            )}
                          </td>
                          <td style={{ maxWidth: 300, whiteSpace: 'normal' }}>
                            {notes.length > 0 ? (
                              <span style={{ color: 'var(--pending)' }}>⚠ {notes.join(' ')}</span>
                            ) : (
                              <span style={{ color: 'var(--ink-faint)' }}>—</span>
                            )}
                            {change.comment && (
                              <div style={{ color: 'var(--rejected)', marginTop: 3 }}>
                                {change.comment}
                              </div>
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
                                placeholder="reason (if rejecting)"
                                size={16}
                                style={{ marginLeft: 4 }}
                              />
                            </td>
                          ) : (
                            <td>
                              {change.decision ? (
                                <span
                                  className={`chip ${
                                    change.decision === 'approved' ? 'live' : 'rejected'
                                  }`}
                                >
                                  {change.decision}
                                </span>
                              ) : (
                                <span style={{ color: 'var(--ink-faint)' }}>undecided</span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {decidable && (
            <>
              <h3>Decide</h3>
              <div className="field" style={{ maxWidth: 560 }}>
                <label htmlFor="comment">Note for the team (optional)</label>
                <textarea id="comment" name="comment" rows={2} />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="approve" type="submit" name="intent" value="approve-all">
                  {isOwn
                    ? `Self-approve all ${request.changes.length}`
                    : `Approve all ${request.changes.length}`}
                </button>
                <button type="submit" name="intent" value="per-line">
                  Apply the decisions above
                </button>
                <button className="reject" type="submit" name="intent" value="reject-all">
                  Reject all
                </button>
              </div>
              <p style={{ color: 'var(--ink-faint)', marginTop: 10, fontSize: 11.5 }}>
                Approved cells become the new live version immediately and the previous one is
                archived. Rejected cells stay out of live pricing but go back to the team&rsquo;s
                draft with your comment, so nothing has to be retyped.
              </p>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
