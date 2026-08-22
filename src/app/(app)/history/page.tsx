import { redirect } from 'next/navigation';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import { recentAudit } from '../../../data/audit';
import { listCards, versionHistory } from '../../../data/rate-cards';

const when = (date: Date) =>
  new Date(date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

const ACTION_LABELS: Record<string, string> = {
  submitted: 'submitted for approval',
  approved: 'approved',
  rejected: 'rejected',
  'partially-approved': 'partially approved',
  'draft-reset': 'discarded a draft',
  'pincodes-imported': 'imported pincodes',
  'user-created': 'created a user',
  'user-role-changed': 'changed a role',
  'signed-in': 'signed in',
};

export default async function HistoryPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!can(user.role, 'view-audit-log')) redirect('/console/model-1/rates');

  const [entries, cards] = await Promise.all([recentAudit(150), listCards()]);
  const histories = await Promise.all(
    cards.map(async (card) => ({ card, versions: await versionHistory(card.key, 12) })),
  );

  return (
    <div className="page">
      <div className="page-inner">
        <h2>History</h2>
        <p className="lede">
          Every version is kept, so &ldquo;what did we quote in June?&rdquo; has an exact answer.
          The audit log is append-only — never updated, never deleted.
        </p>

        <h3>Rate card versions</h3>
        {histories.map(({ card, versions }) => (
          <div key={card.key} style={{ marginBottom: 22 }}>
            <p style={{ margin: '0 0 6px' }}>
              <strong>{card.name}</strong>{' '}
              <span style={{ color: 'var(--ink-faint)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {card.freightMethod}
              </span>
            </p>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>Version</th>
                  <th style={{ width: 100 }}>State</th>
                  <th>Created by</th>
                  <th>Created</th>
                  <th>Approved by</th>
                  <th>Approved</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version._id.toHexString()}>
                    <td className="num">{version.version}</td>
                    <td>
                      <span
                        className={`chip ${
                          version.state === 'live'
                            ? 'live'
                            : version.state === 'pending'
                              ? 'pending'
                              : version.state === 'draft'
                                ? 'draft'
                                : 'count'
                        }`}
                      >
                        {version.state}
                      </span>
                    </td>
                    <td>{version.createdBy?.name ?? 'unknown'}</td>
                    <td>{when(version.createdAt)}</td>
                    <td>{version.approvedBy?.name ?? '—'}</td>
                    <td>{version.approvedAt ? when(version.approvedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        <h3>Audit log</h3>
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 170 }}>When</th>
              <th>Who</th>
              <th>Did what</th>
              <th>Card</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={index}>
                <td style={{ whiteSpace: 'nowrap', color: 'var(--ink-soft)' }}>{when(entry.at)}</td>
                {/*
                  Guarded, like `approvedBy` beside it.

                  One audit row with no actor took this whole page down with a 500 — and the
                  audit log is append-only and written from dozens of paths over years, so a
                  malformed row is a question of when. This page is where somebody goes to
                  find out what happened; it is the last page that should be unavailable
                  because one of the things that happened was recorded badly.
                */}
                <td>{entry.actor?.name ?? 'unknown'}</td>
                <td>{ACTION_LABELS[entry.action] ?? entry.action}</td>
                <td>{entry.rateCardKey ?? '—'}</td>
                <td className="ref" style={{ whiteSpace: 'normal' }}>
                  {entry.detail
                    ? Object.entries(entry.detail)
                        .map(([key, value]) => `${key}=${String(value)}`)
                        .join(' · ')
                    : '—'}
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: 'var(--ink-faint)' }}>
                  Nothing recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
