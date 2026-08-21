import Link from 'next/link';
import ActionForm from '../../../../../components/console/ActionForm';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { findBookingException, findCustomer } from '../../../../../data/customers';
import { decideException } from '../../../../../app/console-actions';

const REASON_TEXT: Record<string, string> = {
  'mode-not-in-contract': 'The mode is not covered by this contract.',
  'lane-not-in-contract': 'The lane is not a contracted lane.',
  'weight-not-in-contract': 'The weight falls outside the contracted bands.',
};

const when = (date?: Date) =>
  date ? new Date(date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default async function ExceptionPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const [user, request] = await Promise.all([currentUser(), findBookingException(ref)]);
  if (!request) notFound();

  const customer = await findCustomer(request.customerCode);
  const reviewer = user ? can(user.role, 'review-change-request') : false;
  const decidable = reviewer && request.status === 'pending';
  const laneRestricted = customer?.liveTerms.scope.lanes !== null;

  return (
    <div className="page">
      <div className="page-inner">
        <p style={{ margin: 0 }}>
          <Link href="/approvals" style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
            ← Approvals
          </Link>
        </p>
        <h2>
          Booking exception{' '}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15 }}>{request.reference}</span>{' '}
          <span
            className={`chip ${
              request.status === 'pending'
                ? 'pending'
                : request.status === 'approved'
                  ? 'live'
                  : 'rejected'
            }`}
          >
            {request.status}
          </span>
        </h2>
        <p className="lede">
          {customer?.name ?? request.customerCode} wants to book a shipment their contract does not
          cover. Until this is approved the booking site will not let it through.
        </p>

        <table className="data" style={{ marginBottom: 18 }}>
          <tbody>
            <tr>
              <td style={{ width: 200 }}>Customer</td>
              <td>
                <strong>{customer?.name ?? request.customerCode}</strong>{' '}
                <span className="ref">{request.customerCode}</span>
              </td>
            </tr>
            <tr>
              <td>Shipment</td>
              <td>
                {request.mode} · {request.fromPincode} → {request.toPincode} · {request.weight} kg
              </td>
            </tr>
            <tr>
              <td>Price quoted to the operator</td>
              <td>
                <strong>
                  ₹
                  {request.quotedTotal.toLocaleString('en-IN', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </strong>{' '}
                <span style={{ color: 'var(--ink-faint)' }}>standard prices, not contracted</span>
              </td>
            </tr>
            <tr>
              <td>Requested by</td>
              <td>
                {request.requestedBy} · {when(request.requestedAt)}
              </td>
            </tr>
            {request.decidedBy && (
              <tr>
                <td>Decided</td>
                <td>
                  {request.decidedBy} · {when(request.decidedAt)}
                  {request.decisionComment && <> — {request.decisionComment}</>}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="callout">
          <strong>Why it fell outside the contract</strong>
          <ul>
            {request.reasons.map((reason) => (
              <li key={reason}>{REASON_TEXT[reason] ?? reason}</li>
            ))}
          </ul>
        </div>

        {decidable ? (
          <ActionForm what="record that decision" action={async (_previous: unknown, form: FormData) => {
          'use server';
          return decideException(request.reference, form);
        }}>
            <h3>Decide</h3>
            <div className="field" style={{ maxWidth: 560 }}>
              <label htmlFor="comment">Note (optional)</label>
              <textarea id="comment" name="comment" rows={2} />
            </div>

            {laneRestricted && (
              <div className="field" style={{ maxWidth: 560 }}>
                <label htmlFor="addToContract">
                  <input id="addToContract" name="addToContract" type="checkbox" /> Also add this
                  lane and mode to the contract permanently
                </label>
                <p style={{ fontSize: 11.5, color: 'var(--ink-faint)', margin: '4px 0 0' }}>
                  Without this, the same booking will need approving again next time. Rates stay at
                  standard until someone negotiates them.
                </p>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="approve" type="submit" name="intent" value="approve">
                Approve this booking
              </button>
              <button className="reject" type="submit" name="intent" value="reject">
                Reject
              </button>
            </div>
          </ActionForm>
        ) : (
          request.status === 'pending' && (
            <p style={{ color: 'var(--ink-faint)' }}>
              Waiting for an admin. Only an admin can decide a booking exception.
            </p>
          )
        )}
      </div>
    </div>
  );
}
