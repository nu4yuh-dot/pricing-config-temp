import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import { listReceipts } from '../../../data/collections';
import { listCustomers } from '../../../data/customers';
import { ageingFor } from '../../../data/collections';
import { unallocatedPaise, overduePaise } from '../../../billing/collections';
import { DEFAULT_COMMERCIAL_TERMS } from '../../../domain/customers';
import ReceiptForm from '../../../components/console/ReceiptForm';
import { recordReceiptAction } from '../../console-actions';

/**
 * Collections — money in, and what it settled.
 *
 * A receipt is money in the bank, not a payment against an invoice. One transfer often
 * covers four invoices and part of a fifth, and a system that can only record payments
 * cannot hold that. So a receipt is recorded when it arrives, allocated afterwards, and
 * stays changeable until somebody posts it.
 *
 * Ageing is measured against each invoice's own due date rather than one date for the
 * account: a customer on 45-day terms with one invoice raised late is not uniformly 45
 * days old, and a band computed from the terms would say they were.
 */
export default async function CollectionsPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!can(user.role, 'record-money')) redirect('/console/model-1/rates');

  const [receipts, customers] = await Promise.all([listReceipts(), listCustomers()]);

  const withAgeing = await Promise.all(
    customers.map(async (customer) => {
      const terms = customer.commercial ?? DEFAULT_COMMERCIAL_TERMS;
      const bands = await ageingFor(customer.code, terms.paymentTermsDays);
      return { customer, bands, overdue: overduePaise(bands) };
    }),
  );

  const owing = withAgeing
    .filter((row) => row.bands.some((band) => band.paise > 0))
    .sort((a, b) => b.overdue - a.overdue);

  const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
  const drafts = receipts.filter((receipt) => receipt.status === 'draft');

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Collections</h2>
        <p className="lede">
          Money received, what it was applied to, and what is still owed. A receipt is
          recorded when it arrives — deciding which invoices it settles comes after, and can
          be changed until it is posted.
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">Receipts</div>
            <div className="v">{receipts.length}</div>
          </div>
          <div className="stat">
            <div className="k">Awaiting posting</div>
            <div className={drafts.length ? 'v' : 'v muted'}>{drafts.length}</div>
            <div className="sub">Still changeable</div>
          </div>
          <div className="stat">
            <div className="k">Overdue</div>
            <div className={owing.length ? 'v' : 'v muted'}>
              {rupees(owing.reduce((total, row) => total + row.overdue, 0))}
            </div>
            <div className="sub">Across {owing.length} customer(s)</div>
          </div>
        </div>

        <h3>Record a receipt</h3>
        <p className="lede" style={{ marginTop: 0 }}>
          Money arriving. Typed by hand because nothing tells us — the core&rsquo;s only payment
          path is a demo button, so a real transfer reaches this system when somebody enters it.
        </p>
        <ReceiptForm
          action={recordReceiptAction}
          customers={customers.map((customer) => ({ code: customer.code, name: customer.name }))}
        />

        <h3>What is owed, by age</h3>
        {owing.length === 0 ? (
          <p className="empty">Nothing outstanding. Every raised invoice is settled.</p>
        ) : (
          <div className="gridscroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th>
                  {owing[0]!.bands.map((band) => (
                    <th key={band.label} style={{ textAlign: 'right' }}>
                      {band.label}
                    </th>
                  ))}
                  <th style={{ textAlign: 'right' }}>Overdue</th>
                </tr>
              </thead>
              <tbody>
                {owing.map((row) => (
                  <tr key={row.customer.code}>
                    <td>
                      <Link href={`/customers/${row.customer.code}`}>{row.customer.name}</Link>
                      <div className="sub">
                        {(row.customer.commercial ?? DEFAULT_COMMERCIAL_TERMS).paymentTermsDays}-day
                        terms
                      </div>
                    </td>
                    {row.bands.map((band) => (
                      <td key={band.label} className="num">
                        {band.paise > 0 ? rupees(band.paise) : '—'}
                      </td>
                    ))}
                    <td className="num">
                      <strong>{row.overdue > 0 ? rupees(row.overdue) : '—'}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3>Receipts ({receipts.length})</h3>
        {receipts.length === 0 ? (
          <p className="empty">
            None recorded. A receipt is money arriving — record it first, decide what it
            settles after.
          </p>
        ) : (
          <div className="gridscroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Customer</th>
                  <th>Received</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Applied to</th>
                  <th style={{ textAlign: 'right' }}>On account</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((receipt) => (
                  <tr key={receipt.reference}>
                    <td className="ref">{receipt.reference}</td>
                    <td>{receipt.customerCode}</td>
                    <td>
                      {receipt.receivedAt.toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                      {receipt.instrument && <div className="sub">{receipt.instrument}</div>}
                    </td>
                    <td className="num">{rupees(receipt.amountPaise)}</td>
                    <td>
                      {receipt.allocations.length === 0 ? (
                        <span className="muted">nothing yet</span>
                      ) : (
                        receipt.allocations.map((allocation) => (
                          <div key={allocation.invoiceNumber} className="sub">
                            {allocation.invoiceNumber} · {rupees(allocation.paise)}
                          </div>
                        ))
                      )}
                    </td>
                    <td className="num">
                      {unallocatedPaise(receipt) > 0 ? (
                        rupees(unallocatedPaise(receipt))
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`chip ${receipt.status === 'finalised' ? 'live' : 'draft'}`}>
                        {receipt.status === 'finalised' ? 'posted' : 'draft'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
