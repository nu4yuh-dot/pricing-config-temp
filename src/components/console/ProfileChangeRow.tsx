'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { decideProfileChange } from '../../app/console-actions';

/**
 * One proposed change to a customer's company details, in the approvals queue.
 *
 * The reject box only appears once reject is chosen. A comment field sitting open next to
 * an approve button invites a reviewer to type a note and then approve, and that note goes
 * nowhere useful — whereas a rejection without a reason leaves the person who submitted it
 * with nothing to act on, so that one is required.
 */
export default function ProfileChangeRow({
  id,
  customer,
  code,
  changed,
  submittedBy,
  submittedAt,
  canReview,
}: {
  id: string;
  customer: string;
  code: string;
  changed: string[];
  submittedBy: string;
  submittedAt: string;
  canReview: boolean;
}) {
  const [state, action, pending] = useActionState(decideProfileChange, null);
  const [rejecting, setRejecting] = useState(false);

  const readable: Record<string, string> = {
    legalName: 'legal name',
    tradeName: 'trade name',
    gstin: 'GSTIN',
    pan: 'PAN',
    msmeNumber: 'MSME number',
    registeredAddress: 'registered address',
    billingAddress: 'billing address',
    contacts: 'contacts',
    plants: 'plants',
  };

  return (
    <tr>
      <td>
        <Link href={`/customers/${code}`}>{customer}</Link>
        <div className="sub">{code}</div>
      </td>
      <td>{changed.map((field) => readable[field] ?? field).join(', ')}</td>
      <td>{submittedBy}</td>
      <td>{submittedAt}</td>
      <td style={{ minWidth: 260 }}>
        {!canReview && <span className="muted">Awaiting an admin</span>}

        {canReview && (
          <form action={action}>
            <input type="hidden" name="id" value={id} />
            {rejecting && (
              <textarea
                name="comment"
                rows={2}
                placeholder="Why is this being sent back?"
                required
                style={{ width: '100%', marginBottom: 6 }}
              />
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {!rejecting && (
                <>
                  <button
                    className="primary"
                    type="submit"
                    name="verdict"
                    value="approve"
                    disabled={pending}
                  >
                    {pending ? 'Working…' : 'Approve & send to core'}
                  </button>
                  <button type="button" onClick={() => setRejecting(true)} disabled={pending}>
                    Reject
                  </button>
                </>
              )}
              {rejecting && (
                <>
                  <button type="submit" name="verdict" value="reject" disabled={pending}>
                    {pending ? 'Working…' : 'Send it back'}
                  </button>
                  <button type="button" onClick={() => setRejecting(false)} disabled={pending}>
                    Cancel
                  </button>
                </>
              )}
            </div>
            {state?.error && <div className="callout warn" style={{ marginTop: 6 }}>{state.error}</div>}
          </form>
        )}
      </td>
    </tr>
  );
}
