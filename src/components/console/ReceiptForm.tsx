'use client';

import { useActionState } from 'react';
import type { ActionResult } from '../../app/console-actions';

/**
 * Recording money that has arrived.
 *
 * Typed by hand because nothing tells us: the core's only payment path is a demo button.
 * When a real gateway is wired there, this becomes the exception rather than the rule —
 * the money event happens where the payment is taken.
 *
 * Allocation is offered but not forced. A clerk who knows this transfer is for one
 * particular invoice should not have to undo an automatic guess first.
 */
export default function ReceiptForm({
  action,
  customers,
}: {
  action: (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;
  customers: { code: string; name: string }[];
}) {
  const [state, submit, pending] = useActionState(action, null);

  return (
    <form action={submit} className="panel">
      <div className="body">
        <div className="inline-form">
          <div className="field" style={{ minWidth: 240 }}>
            <label htmlFor="r-customer">Customer</label>
            <select id="r-customer" name="customerCode" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {customers.map((customer) => (
                <option key={customer.code} value={customer.code}>
                  {customer.name} ({customer.code})
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 140 }}>
            <label htmlFor="r-amount">Amount (₹)</label>
            <input id="r-amount" name="amount" type="number" min="0.01" step="0.01" required />
            <span className="hint">What the bank shows, not what it settles.</span>
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="r-date">Received</label>
            <input id="r-date" name="receivedAt" type="date" />
            <span className="hint">Blank means today.</span>
          </div>
          <div className="field" style={{ minWidth: 180 }}>
            <label htmlFor="r-instrument">Bank reference</label>
            <input id="r-instrument" name="instrument" placeholder="UTR / cheque no." />
            <span className="hint">What you would match against a statement.</span>
          </div>
        </div>

        <div className="inline-form">
          <div className="field" style={{ minWidth: 320 }}>
            <label htmlFor="r-note">Note</label>
            <input id="r-note" name="note" />
          </div>
          <label className="check">
            <input type="checkbox" name="autoAllocate" defaultChecked /> Apply to the oldest
            invoices first
          </label>
        </div>

        <div className="callout info">
          Recorded as a draft. Nothing is applied to an invoice until it is posted, and the
          allocation can be changed freely until then.
        </div>

        {state?.error && <div className="callout warn">{state.error}</div>}
        {state?.ok && <div className="callout info">Receipt recorded.</div>}
      </div>

      <div className="actionbar">
        <span className="spacer" />
        <button className="primary" type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record receipt'}
        </button>
      </div>
    </form>
  );
}
