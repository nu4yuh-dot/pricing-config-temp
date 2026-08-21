'use client';

import { useActionState, useState, useTransition } from 'react';
import { previewBill, runBillingAction } from '../../app/console-actions';
import type { ActionResult } from '../../app/console-actions';

type Preview = Awaited<ReturnType<typeof previewBill>>;

/**
 * Running the monthly bill.
 *
 * Preview first, deliberately. Raising an invoice takes a number from a series that can
 * never reuse it, so the shape of the bill is shown before anything is spent — and held
 * lines are shown with their reason, because "the bill is smaller than expected" is
 * otherwise unanswerable.
 */
export default function BillRunForm({
  customers,
}: {
  customers: { code: string; name: string }[];
}) {
  const [state, submit, running] = useActionState(
    runBillingAction as (p: ActionResult | null, f: FormData) => Promise<ActionResult>,
    null,
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();

  const [customerCode, setCustomerCode] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const ready = customerCode !== '' && from !== '' && to !== '';

  const look = () => {
    setPreviewError(null);
    startChecking(async () => {
      try {
        setPreview(await previewBill(customerCode, from, to));
      } catch (cause) {
        setPreview(null);
        setPreviewError(cause instanceof Error ? cause.message : 'Could not read that period.');
      }
    });
  };

  const rupees = (value: number) => `₹${value.toLocaleString('en-IN')}`;
  const result = state as (ActionResult & { invoices?: string[]; total?: number; held?: number }) | null;

  return (
    <form action={submit} className="panel">
      <input type="hidden" name="customerCode" value={customerCode} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />

      <div className="body">
        <div className="inline-form">
          <div className="field" style={{ minWidth: 240 }}>
            <label htmlFor="b-customer">Customer</label>
            <select
              id="b-customer"
              value={customerCode}
              onChange={(event) => {
                setCustomerCode(event.target.value);
                setPreview(null);
              }}
            >
              <option value="">Choose…</option>
              {customers.map((customer) => (
                <option key={customer.code} value={customer.code}>
                  {customer.name} ({customer.code})
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="b-from">Period from</label>
            <input
              id="b-from"
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setPreview(null);
              }}
            />
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="b-to">Period to</label>
            <input
              id="b-to"
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPreview(null);
              }}
            />
          </div>
          <button type="button" onClick={look} disabled={!ready || checking} style={{ marginTop: 18 }}>
            {checking ? 'Looking…' : 'Show me what this would bill'}
          </button>
        </div>

        {previewError && <div className="callout warn">{previewError}</div>}

        {preview && (
          <>
            {preview.refusal && <div className="callout warn">{preview.refusal}</div>}
            <div className="stats" style={{ marginTop: 10 }}>
              <div className="stat">
                <div className="k">Would bill</div>
                <div className="v">{rupees(preview.totalToBill)}</div>
                <div className="sub">{preview.billable.length} shipment(s)</div>
              </div>
              <div className="stat">
                <div className="k">Held back</div>
                <div className={preview.held.length ? 'v' : 'v muted'}>
                  {preview.held.length ? rupees(preview.heldTotal) : '—'}
                </div>
                <div className="sub">{preview.held.length} shipment(s)</div>
              </div>
              <div className="stat">
                <div className="k">Billing basis</div>
                <div className="v" style={{ fontSize: 15 }}>{preview.basis}</div>
              </div>
            </div>

            {preview.held.length > 0 && (
              <>
                <h4>Why these are held</h4>
                <table className="data">
                  <thead>
                    <tr><th>AWB</th><th>Mode</th><th style={{ textAlign: 'right' }}>Value</th><th>Reason</th></tr>
                  </thead>
                  <tbody>
                    {preview.held.slice(0, 12).map((line) => (
                      <tr key={line.awb}>
                        <td className="ref">{line.awb}</td>
                        <td>{line.mode}</td>
                        <td className="num">{rupees(line.total)}</td>
                        <td>{line.heldBecause}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}

        {result?.error && <div className="callout warn">{result.error}</div>}
        {result?.ok && (
          <div className="callout info">
            <strong>
              Raised {result.invoices?.length} invoice
              {result.invoices?.length === 1 ? '' : 's'} for {rupees(result.total ?? 0)}.
            </strong>
            <div className="sub">
              {result.invoices?.join(', ')}
              {result.held ? ` · ${result.held} shipment(s) held back` : ''}
            </div>
          </div>
        )}
      </div>

      <div className="actionbar">
        <span className="hint">
          Numbers are taken from the series when this runs, and are never reused.
        </span>
        <span className="spacer" />
        <button
          className="primary"
          type="submit"
          disabled={running || !preview || preview.billable.length === 0 || Boolean(preview.refusal)}
        >
          {running ? 'Raising…' : 'Raise the bill'}
        </button>
      </div>
    </form>
  );
}
