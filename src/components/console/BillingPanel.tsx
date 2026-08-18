'use client';

import { useActionState } from 'react';
import { rechargeWallet, payInvoice, type MoneyResult } from '../../app/console-actions';

/**
 * A customer's money: what they hold, what they owe, and what has moved.
 *
 * Every figure comes in as paise and is only formatted here. Nothing on this screen adds
 * anything up — the arithmetic is in `billing/ledger.ts`, where it is tested — because a
 * total computed in a component is a total nobody can reproduce.
 */

export interface BillingPanelProps {
  code: string;
  canRecord: boolean;
  position: {
    limit: number;
    outstanding: number;
    owed: number;
    overdue: number;
    oldestOverdueDays: number;
    walletBalance: number;
    available: number;
    overLimit: boolean;
  };
  paymentTermsDays: number;
  statement: {
    id: string;
    kind: string;
    reference: string;
    against?: string;
    note?: string;
    at: string;
    amountPaise: number;
    balanceAfter: number;
  }[];
  invoices: {
    number: string;
    mode: string;
    raisedAt: string;
    lines: number;
    taxableValuePaise: number;
    gstPaise: number;
    totalPaise: number;
    paidPaise: number;
    status: string;
    sac: string;
    gstRate: number;
    rcm: boolean;
    note?: string;
  }[];
}

const money = (amountInPaise: number) =>
  `₹${(amountInPaise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Money in reads as a credit; money out as a debit. Reversal takes the original's place. */
const DIRECTION: Record<string, 'in' | 'out' | 'none'> = {
  recharge: 'in',
  payment: 'in',
  adjustment: 'in',
  invoice: 'out',
  refund: 'out',
  reversal: 'none',
};

export default function BillingPanel(props: BillingPanelProps) {
  const [recharge, rechargeAction, recharging] = useActionState<MoneyResult | null, FormData>(
    rechargeWallet,
    null,
  );
  const [payment, paymentAction, paying] = useActionState<MoneyResult | null, FormData>(
    payInvoice,
    null,
  );

  const { position } = props;
  const unpaid = props.invoices.filter((invoice) => invoice.status !== 'paid');

  return (
    <>
      <div className="panel">
        <header>
          <h3>Account</h3>
          <span className="hint">
            {position.limit === 0
              ? 'Prepaid: bookings come out of the balance.'
              : `On credit: ${money(position.limit)} limit, ${props.paymentTermsDays}-day terms.`}
          </span>
        </header>
        <div className="body">
          <table className="data">
            <tbody>
              <tr>
                <td style={{ width: 220 }}>Balance</td>
                <td className="num">
                  <strong style={{ color: position.walletBalance < 0 ? 'var(--rejected)' : undefined }}>
                    {money(position.walletBalance)}
                  </strong>
                  <span style={{ color: 'var(--ink-faint)' }}>
                    {position.walletBalance < 0 ? ' owed to DNS' : ' on account'}
                  </span>
                </td>
              </tr>
              {position.limit > 0 && (
                <>
                  <tr>
                    <td>Credit used</td>
                    <td className="num">
                      {money(position.owed)} of {money(position.limit)}
                      {position.overLimit && (
                        <span style={{ color: 'var(--rejected)' }}> · over the limit</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td>Credit available</td>
                    <td className="num">{money(position.available)}</td>
                  </tr>
                </>
              )}
              <tr>
                <td>Invoiced, unsettled</td>
                <td className="num">{money(position.outstanding)}</td>
              </tr>
              {position.overdue > 0 && (
                <tr>
                  <td>Overdue</td>
                  <td className="num" style={{ color: 'var(--rejected)' }}>
                    <strong>{money(position.overdue)}</strong> · oldest{' '}
                    {position.oldestOverdueDays} days
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {position.overdue > 0 && (
            <div className="callout bad" style={{ marginTop: 10 }}>
              <strong>Bookings are held</strong>
              Overdue money blocks further booking whatever the credit limit says, because a
              customer this far behind does not have headroom — that is how a receivable turns
              into a bad debt.
            </div>
          )}
        </div>
      </div>

      {props.canRecord && (
        <div className="panel">
          <header>
            <h3>Record money in</h3>
            <span className="hint">
              The reference is the UTR or gateway id. Recording the same one twice records it
              once.
            </span>
          </header>
          <div className="body">
            <form action={rechargeAction} className="inline-form">
              <input type="hidden" name="code" value={props.code} />
              <div className="field">
                <label htmlFor="amount">Amount ₹</label>
                <input id="amount" name="amount" inputMode="decimal" size={10} required />
              </div>
              <div className="field">
                <label htmlFor="reference">Reference</label>
                <input id="reference" name="reference" size={16} required />
              </div>
              <div className="field">
                <label htmlFor="note">Note</label>
                <input id="note" name="note" size={20} />
              </div>
              <button className="primary" type="submit" disabled={recharging}>
                {recharging ? 'Recording…' : 'Record recharge'}
              </button>
            </form>
            {recharge && (
              <p className={recharge.ok ? 'hint' : 'error'} style={{ marginTop: 8 }}>
                {recharge.message}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="panel">
        <header>
          <h3>Invoices</h3>
          <span className="hint">
            One per mode per period — road and air are taxed differently and cannot share a
            document.
          </span>
        </header>
        <div className="body">
          {props.invoices.length === 0 ? (
            <p className="hint">Nothing invoiced yet.</p>
          ) : (
            <div className="scroll-x">
              <table className="data">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Mode</th>
                    <th>SAC</th>
                    <th className="num">Taxable</th>
                    <th className="num">GST</th>
                    <th className="num">Total</th>
                    <th className="num">Paid</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {props.invoices.map((invoice) => (
                    <tr key={invoice.number}>
                      <td>
                        {invoice.number}
                        <span style={{ color: 'var(--ink-faint)' }}> · {invoice.lines} line(s)</span>
                      </td>
                      <td>{invoice.mode}</td>
                      <td>
                        {invoice.sac}
                        <span style={{ color: 'var(--ink-faint)' }}>
                          {' '}
                          {(invoice.gstRate * 100).toFixed(0)}%{invoice.rcm ? ' RCM' : ''}
                        </span>
                      </td>
                      <td className="num">{money(invoice.taxableValuePaise)}</td>
                      <td className="num">{money(invoice.gstPaise)}</td>
                      <td className="num">
                        <strong>{money(invoice.totalPaise)}</strong>
                      </td>
                      <td className="num">{money(invoice.paidPaise)}</td>
                      <td>
                        <span
                          className={`chip ${
                            invoice.status === 'paid'
                              ? 'live'
                              : invoice.status === 'part-paid'
                                ? 'draft'
                                : ''
                          }`}
                        >
                          {invoice.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {props.canRecord && unpaid.length > 0 && (
            <>
              <form action={paymentAction} className="inline-form" style={{ marginTop: 12 }}>
                <input type="hidden" name="code" value={props.code} />
                <div className="field">
                  <label htmlFor="invoice">Settle</label>
                  <select id="invoice" name="invoice">
                    {unpaid.map((invoice) => (
                      <option key={invoice.number} value={invoice.number}>
                        {invoice.number} · {money(invoice.totalPaise - invoice.paidPaise)} left
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pay-amount">Amount ₹</label>
                  <input id="pay-amount" name="amount" inputMode="decimal" size={10} required />
                </div>
                <div className="field">
                  <label htmlFor="pay-reference">UTR</label>
                  <input id="pay-reference" name="reference" size={16} required />
                </div>
                <button className="primary" type="submit" disabled={paying}>
                  {paying ? 'Recording…' : 'Record payment'}
                </button>
              </form>
              <p className="hint" style={{ marginTop: 6 }}>
                Part payments are fine — each one releases exactly what it settles.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <header>
          <h3>Statement</h3>
          <span className="hint">
            Append-only. A mistake is corrected by a reversing entry, never by editing one.
          </span>
        </header>
        <div className="body">
          {props.statement.length === 0 ? (
            <p className="hint">No movements yet.</p>
          ) : (
            <div className="scroll-x">
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Entry</th>
                    <th>Reference</th>
                    <th className="num">In</th>
                    <th className="num">Out</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {props.statement.map((row) => {
                    const direction = DIRECTION[row.kind] ?? 'none';
                    return (
                      <tr key={row.id}>
                        <td>{row.at}</td>
                        <td>
                          {row.kind}
                          {row.note && (
                            <span style={{ color: 'var(--ink-faint)' }}> · {row.note}</span>
                          )}
                        </td>
                        <td>
                          {row.reference}
                          {row.against && (
                            <span style={{ color: 'var(--ink-faint)' }}> → {row.against}</span>
                          )}
                        </td>
                        <td className="num">{direction === 'in' ? money(row.amountPaise) : ''}</td>
                        <td className="num">{direction === 'out' ? money(row.amountPaise) : ''}</td>
                        <td className="num">{money(row.balanceAfter)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
