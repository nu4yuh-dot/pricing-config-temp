'use client';

import { useActionState, useState } from 'react';
import type { ActionResult } from '../../app/console-actions';

/**
 * Reopening a billed period, or closing a reopened one.
 *
 * The reason field is required and pre-filled when a customer dispute prompted it — their
 * words, because that is what somebody reads a year later when the restatement is
 * questioned. It stays editable: whoever reopens the period may know something better.
 */
export default function ReopenPeriodForm({
  reopen,
  relock,
  customerCode,
  from,
  state,
  suggestedReason,
  asBilled,
}: {
  reopen: (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;
  relock: (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;
  customerCode: string;
  from: string;
  state: string;
  suggestedReason?: string;
  asBilled?: number;
}) {
  const [reopenState, submitReopen, reopening] = useActionState(reopen, null);
  const [relockState, submitRelock, relocking] = useActionState(relock, null);
  const [open, setOpen] = useState(false);

  if (state === 'reopened') {
    return (
      <form action={submitRelock}>
        <input type="hidden" name="customerCode" value={customerCode} />
        <input type="hidden" name="from" value={from} />
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor={`c-${from}`}>Corrected total (₹)</label>
            <input
              id={`c-${from}`}
              name="asCorrected"
              type="number"
              min="0"
              step="0.01"
              required
              defaultValue={asBilled !== undefined ? asBilled / 100 : undefined}
            />
          </div>
          <button className="primary" type="submit" disabled={relocking} style={{ marginTop: 18 }}>
            {relocking ? 'Closing…' : 'Close the period'}
          </button>
        </div>
        {relockState?.error && (
          <div className="callout warn" style={{ marginTop: 6 }}>{relockState.error}</div>
        )}
      </form>
    );
  }

  if (state === 'open') return <span className="muted">Still open</span>;

  return (
    <>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)}>
          Reopen…
        </button>
      ) : (
        <form action={submitReopen}>
          <input type="hidden" name="customerCode" value={customerCode} />
          <input type="hidden" name="from" value={from} />
          <textarea
            name="reason"
            rows={2}
            required
            defaultValue={suggestedReason ?? ''}
            placeholder="Why is this period being reopened?"
            style={{ width: '100%', marginBottom: 6 }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="primary" type="submit" disabled={reopening}>
              {reopening ? 'Reopening…' : 'Reopen'}
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={reopening}>
              Cancel
            </button>
          </div>
          {reopenState?.error && (
            <div className="callout warn" style={{ marginTop: 6 }}>{reopenState.error}</div>
          )}
        </form>
      )}
    </>
  );
}
