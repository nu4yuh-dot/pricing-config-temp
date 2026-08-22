'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { decideContractRequest } from '../../app/console-actions';
import { useActionToast } from '../Toasts';

/**
 * One customer negotiation request in the approvals queue.
 *
 * The accept button says what accepting does — it opens a negotiation, it does not agree a
 * price — because the alternative reading is the expensive one.
 */
export default function ContractRequestRow({
  reference,
  customer,
  code,
  asked,
  note,
  raisedBy,
  raisedAt,
  proposedCells,
  canReview,
}: {
  reference: string;
  customer: string;
  code: string;
  asked: string;
  note?: string;
  raisedBy: string;
  raisedAt: string;
  proposedCells: number;
  canReview: boolean;
}) {
  const [state, action, pending] = useActionState(decideContractRequest, null);
  useActionToast(state, { what: 'Decision', verb: 'record that decision' });
  const [declining, setDeclining] = useState(false);

  return (
    <tr>
      <td className="ref">{reference}</td>
      <td>
        <Link href={`/customers/${code}`}>{customer}</Link>
        <div className="sub">{raisedBy}</div>
      </td>
      <td>
        {asked || <span className="muted">Nothing specific</span>}
        {proposedCells > 0 && (
          <div className="sub">
            {proposedCells} rate{proposedCells === 1 ? '' : 's'} proposed by the customer
          </div>
        )}
        {note && <div className="sub" style={{ fontStyle: 'italic' }}>“{note}”</div>}
      </td>
      <td>{raisedAt}</td>
      <td style={{ minWidth: 280 }}>
        {!canReview && <span className="muted">Awaiting an admin</span>}

        {canReview && (
          <form action={action}>
            <input type="hidden" name="reference" value={reference} />
            {declining && (
              <textarea
                name="comment"
                rows={2}
                placeholder="Why — the customer sees this"
                required
                style={{ width: '100%', marginBottom: 6 }}
              />
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {!declining ? (
                <>
                  <button
                    className="primary"
                    type="submit"
                    name="verdict"
                    value="accept"
                    disabled={pending}
                  >
                    {pending ? 'Working…' : 'Accept into their draft'}
                  </button>
                  <button type="button" onClick={() => setDeclining(true)} disabled={pending}>
                    Decline
                  </button>
                </>
              ) : (
                <>
                  <button type="submit" name="verdict" value="decline" disabled={pending}>
                    {pending ? 'Working…' : 'Decline'}
                  </button>
                  <button type="button" onClick={() => setDeclining(false)} disabled={pending}>
                    Cancel
                  </button>
                </>
              )}
            </div>

            {state?.ok && (state.widened?.length ?? 0) > 0 && (
              <div className="callout info" style={{ marginTop: 6 }}>
                Added {state.widened?.join(', ')} to their draft. Rate it, then propose the
                contract — nothing is live until that is approved.
              </div>
            )}
            {state?.ok && state.widened?.length === 0 && (
              <div className="callout info" style={{ marginTop: 6 }}>
                Their contract already covered this, so nothing changed. Worth checking what
                they actually hit.
              </div>
            )}
            {state?.error && (
              <div className="callout warn" style={{ marginTop: 6 }}>{state.error}</div>
            )}
          </form>
        )}
      </td>
    </tr>
  );
}
