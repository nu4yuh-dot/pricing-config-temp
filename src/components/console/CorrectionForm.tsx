'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { correctInvoice, correctionOptions, type ActionResult } from '../../app/console-actions';

/** What may be done to the selected invoice, unwrapped from the action's outcome. */
type Options = Extract<Awaited<ReturnType<typeof correctionOptions>>, { ok: true }>['options'];

/**
 * Correcting an issued invoice.
 *
 * An invoice is a numbered document in a series and is never edited. A correction is a
 * second document referencing it, taking its own number from the same series — so this
 * screen is not an edit form, and is deliberately shaped to make that obvious.
 *
 * The route is **decided, not chosen**. Asking to withdraw an invoice money has been
 * received against produces a full-value credit note instead, because cancelling would
 * leave a payment attached to a document that no longer exists. So the options are fetched
 * for whichever invoice is selected and shown with their reasons *before* anything is
 * issued: finding out afterwards is how somebody raises a document they did not mean to.
 */
export default function CorrectionForm({
  invoices,
}: {
  invoices: { number: string; customerCode: string; total: string; status: string }[];
}) {
  const [state, submit, pending] = useActionState<
    (ActionResult & { route?: string; noteNumber?: string }) | null,
    FormData
  >(correctInvoice, null);

  const [selected, setSelected] = useState(invoices[0]?.number ?? '');
  const [withdraw, setWithdraw] = useState(false);
  const [options, setOptions] = useState<Options>(null);
  const [loading, startLoading] = useTransition();
  const [optionsError, setOptionsError] = useState<string | null>(null);

  // Refetched whenever the invoice changes, and again after a correction lands — issuing a
  // note can close a route that was open a moment ago.
  useEffect(() => {
    if (!selected) {
      setOptions(null);
      return;
    }
    startLoading(async () => {
      const outcome = await correctionOptions(selected);
      // A refusal here means the invoice could not be read at all, which is worth saying
      // rather than showing an empty set of routes as though nothing were possible.
      setOptions('error' in outcome ? null : outcome.options);
      setOptionsError('error' in outcome ? outcome.error : null);
    });
  }, [selected, state?.ok]);

  if (invoices.length === 0) {
    return (
      <p className="empty">
        Nothing to correct — no invoice has been raised yet. Run a bill first.
      </p>
    );
  }

  const routeFor = (route: string) => options?.options.find((entry) => entry.route === route);
  const cancelRoute = routeFor('cancel');
  const creditRoute = routeFor('credit-note');

  return (
    <form action={submit} className="panel">
      <div className="body">
        <div className="inline-form">
          <div className="field" style={{ maxWidth: 320 }}>
            <label htmlFor="corr-invoice">Invoice</label>
            <select
              id="corr-invoice"
              name="invoiceNumber"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {invoices.map((invoice) => (
                <option key={invoice.number} value={invoice.number}>
                  {invoice.number} · {invoice.customerCode} · {invoice.total} · {invoice.status}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ maxWidth: 190 }}>
            <label htmlFor="corr-delta">Change by (₹)</label>
            <input
              id="corr-delta"
              name="delta"
              inputMode="decimal"
              placeholder="-500 or 500"
              disabled={withdraw}
            />
          </div>
        </div>

        <label style={{ display: 'flex', gap: 7, alignItems: 'center', margin: '2px 0 10px' }}>
          <input
            type="checkbox"
            name="withdraw"
            checked={withdraw}
            onChange={(event) => setWithdraw(event.target.checked)}
          />
          <span>Withdraw the invoice entirely</span>
        </label>

        <div className="field">
          <label htmlFor="corr-reason">Why</label>
          <input
            id="corr-reason"
            name="reason"
            required
            placeholder="Weight billed at 25 kg, shipped 18 kg"
          />
          <span className="hint">
            Printed on the note. It is the whole explanation anybody gets later.
          </span>
        </div>

        {loading && <p className="sub">Checking what is open on this invoice…</p>}
        {optionsError && <div className="error">{optionsError}</div>}

        {options && !loading && (
          <div className="callout" style={{ marginTop: 10 }}>
            <strong>What will happen</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {withdraw ? (
                cancelRoute?.available ? (
                  <li>
                    The invoice is <strong>cancelled</strong>
                    {cancelRoute.needsApproval ? ' once somebody approves it' : ''}. No money has
                    moved against it.
                  </li>
                ) : (
                  <li>
                    Cancelling is closed{cancelRoute?.reason ? ` — ${cancelRoute.reason}` : ''}. A{' '}
                    <strong>credit note for the full {options.invoice.totalPaise / 100}</strong> is
                    raised instead. Same commercial effect, by the route that is open.
                  </li>
                )
              ) : (
                <li>
                  A negative amount raises a <strong>credit note</strong> and reduces what is owed;
                  a positive one raises a <strong>debit note</strong> and increases it. The invoice
                  keeps its original total either way — that is what the customer was charged.
                </li>
              )}
              {!withdraw && creditRoute && !creditRoute.available && creditRoute.reason && (
                <li>{creditRoute.reason}</li>
              )}
            </ul>
          </div>
        )}

        {state?.error && <div className="error">{state.error}</div>}
        {state?.ok && (
          <div className="callout ok">
            <strong>
              {state.route === 'cancel'
                ? 'Invoice cancelled.'
                : `${state.route === 'debit-note' ? 'Debit' : 'Credit'} note ${state.noteNumber} raised.`}
            </strong>{' '}
            {state.route === 'cancel'
              ? 'It carries no value and its number is recorded as spent.'
              : 'It takes its number from the same series as the invoice, and posts to the ledger.'}
          </div>
        )}

        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Issuing…' : withdraw ? 'Withdraw the invoice' : 'Issue the correction'}
        </button>
      </div>
    </form>
  );
}
