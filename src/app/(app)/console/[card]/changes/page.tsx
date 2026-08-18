import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { draftVersion, liveVersion, findCard } from '../../../../../data/rate-cards';
import { diffCardData, type Change } from '../../../../../changes/diff';
import { validateChanges, validateCard } from '../../../../../changes/validate';
import { canEditDraft } from '../../../../../data/workflow';
import { quote } from '../../../../../pricing/quote';
import { findPincodePair } from '../../../../../data/pincodes';
import SubmitBar from '../../../../../components/console/SubmitBar';

/**
 * Review everything before submitting.
 *
 * The complaint this answers: you could edit dozens of cells across several tabs and
 * then press Submit with no single place showing what you were about to ask someone
 * to approve. This is that place — grouped by sheet, with the percentage movement,
 * the validation warnings, and the effect on a real quote.
 */

const money = (value: number) =>
  value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function groupBySheet(changes: Change[]): Map<string, Change[]> {
  const grouped = new Map<string, Change[]>();
  for (const change of changes) {
    if (!grouped.has(change.sheet)) grouped.set(change.sheet, []);
    grouped.get(change.sheet)?.push(change);
  }
  return grouped;
}

export default async function ChangesPage({ params }: { params: Promise<{ card: string }> }) {
  const { card: cardKey } = await params;
  const user = await currentUser();
  if (!user) notFound();
  const card = await findCard(cardKey);
  if (!card) notFound();

  const [draft, live] = await Promise.all([draftVersion(cardKey), liveVersion(cardKey)]);
  const frozen = !canEditDraft(draft.state);

  const changes = diffCardData(live.data, draft.data);
  const findings = validateChanges(changes);
  const cardFindings = validateCard(draft.data, card.freightMethod);

  // What this actually does to a real shipment, before and after.
  const { origin, destination } = await findPincodePair(411001, 110001);
  const sample = { mode: 'surface' as const, actualWeight: 200 };
  const before = quote(sample, { origin, destination }, { ...card, data: live.data });
  const after = quote(sample, { origin, destination }, { ...card, data: draft.data });
  const sampleMoved =
    before.available && after.available && before.breakdown.total !== after.breakdown.total;

  const bySheet = groupBySheet(changes);
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  const rises = changes.filter((c) => c.pctChange !== null && c.pctChange > 0);
  const falls = changes.filter((c) => c.pctChange !== null && c.pctChange < 0);
  const biggest = changes.reduce(
    (worst, c) => (c.pctChange !== null && Math.abs(c.pctChange) > Math.abs(worst) ? c.pctChange : worst),
    0,
  );
  const findingFor = (bind: string) =>
    findings.filter((finding) => finding.bind === bind).map((finding) => finding.message);

  return (
    <>
      <h2>Changes waiting to be submitted</h2>
      <p className="lede">
        Everything that differs from approved pricing on this card, in one place. Check it here
        before asking anyone to approve it.
      </p>

      {changes.length === 0 ? (
        <div className="panel">
          <div className="empty">
            Nothing has changed — this card matches approved pricing.
            <div style={{ marginTop: 12 }}>
              <Link className="btn" href={`/console/${cardKey}/rates`}>
                Go and edit some rates →
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <div className="k">Values changed</div>
              <div className="v">{changes.length}</div>
              <div className="sub">
                across {bySheet.size} {bySheet.size === 1 ? 'tab' : 'tabs'}
              </div>
            </div>
            <div className="stat">
              <div className="k">Going up</div>
              <div className={rises.length ? 'v' : 'v muted'} style={rises.length ? { color: 'var(--rejected)' } : {}}>
                {rises.length}
              </div>
            </div>
            <div className="stat">
              <div className="k">Coming down</div>
              <div className={falls.length ? 'v' : 'v muted'} style={falls.length ? { color: 'var(--approved)' } : {}}>
                {falls.length}
              </div>
            </div>
            <div className="stat">
              <div className="k">Biggest movement</div>
              <div className={biggest === 0 ? 'v muted' : 'v'}>
                {biggest === 0 ? '—' : `${biggest > 0 ? '+' : ''}${biggest.toFixed(1)}%`}
              </div>
            </div>
            <div className="stat">
              <div className="k">Warnings</div>
              <div className={warnings.length ? 'v' : 'v muted'} style={warnings.length ? { color: 'var(--pending)' } : {}}>
                {warnings.length}
              </div>
            </div>
          </div>

          {sampleMoved && before.available && after.available && (
            <div className="callout info">
              <strong>Effect on a real shipment</strong>
              Surface, Pune → Delhi-NCR, 200 kg:{' '}
              <strong>₹{money(before.breakdown.total)}</strong> →{' '}
              <strong>₹{money(after.breakdown.total)}</strong>{' '}
              <span
                className={`delta ${after.breakdown.total > before.breakdown.total ? 'up' : 'down'}`}
              >
                {after.breakdown.total > before.breakdown.total ? '+' : ''}
                {(
                  ((after.breakdown.total - before.breakdown.total) / before.breakdown.total) *
                  100
                ).toFixed(1)}
                %
              </span>
              <div style={{ marginTop: 4, color: 'var(--ink-soft)' }}>
                One sample lane, to make the size of the change concrete. Other lanes will differ.
              </div>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="callout">
              <strong>
                {warnings.length} {warnings.length === 1 ? 'thing' : 'things'} worth checking before
                you submit
              </strong>
              <ul>
                {warnings.slice(0, 6).map((finding, index) => (
                  <li key={index}>{finding.message}</li>
                ))}
                {warnings.length > 6 && <li>…and {warnings.length - 6} more, marked below.</li>}
              </ul>
            </div>
          )}

          {[...bySheet.entries()].map(([sheet, sheetChanges]) => (
            <div className="panel" key={sheet}>
              <header>
                <h3>{sheet}</h3>
                <span className="hint">
                  {sheetChanges.length} {sheetChanges.length === 1 ? 'value' : 'values'}
                </span>
              </header>
              <div className="body" style={{ padding: 0 }}>
                <table className="data" style={{ border: 0 }}>
                  <thead>
                    <tr>
                      <th>Cell</th>
                      <th>What it is</th>
                      <th style={{ textAlign: 'right' }}>Approved</th>
                      <th style={{ textAlign: 'right' }}>Yours</th>
                      <th style={{ textAlign: 'right' }}>Δ</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheetChanges.map((change) => {
                      const notes = findingFor(change.bind);
                      return (
                        <tr key={change.bind}>
                          <td className="ref">{change.cellRef}</td>
                          <td>{change.label}</td>
                          <td className="num" style={{ color: 'var(--ink-faint)' }}>
                            {change.oldValue === null ? 'not served' : String(change.oldValue)}
                          </td>
                          <td className="num">
                            <strong>
                              {change.newValue === null ? 'not served' : String(change.newValue)}
                            </strong>
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
                          <td style={{ whiteSpace: 'normal', maxWidth: 320 }}>
                            {notes.length > 0 ? (
                              <span style={{ color: 'var(--pending)' }}>⚠ {notes.join(' ')}</span>
                            ) : (
                              <span style={{ color: 'var(--ink-faint)' }}>—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {cardFindings.length > 0 && (
            <details style={{ marginBottom: 16 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--ink-soft)', fontSize: 12 }}>
                {cardFindings.length} pre-existing issue
                {cardFindings.length === 1 ? '' : 's'} on this card, not caused by your changes
              </summary>
              <ul style={{ color: 'var(--ink-soft)', fontSize: 11.5, marginTop: 8 }}>
                {cardFindings.slice(0, 10).map((finding, index) => (
                  <li key={index}>{finding.message}</li>
                ))}
                {cardFindings.length > 10 && <li>…and {cardFindings.length - 10} more.</li>}
              </ul>
            </details>
          )}

          <SubmitBar
            cardKey={cardKey}
            count={changes.length}
            warningCount={warnings.length}
            frozen={frozen}
            canSubmit={can(user.role, 'submit-for-approval') && !frozen}
          />
        </>
      )}
    </>
  );
}
