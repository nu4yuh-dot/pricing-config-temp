import { redirect } from 'next/navigation';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import { allSeries, reconcileSeries } from '../../../data/invoice-series';
import { financialYear } from '../../../billing/series';
import { db, COLLECTIONS } from '../../../data/mongo';
import type { Invoice } from '../../../billing/invoice';
import { listCustomers } from '../../../data/customers';
import BillRunForm from '../../../components/console/BillRunForm';
import CorrectionForm from '../../../components/console/CorrectionForm';

/**
 * Invoices, and the series they are numbered from.
 *
 * The reconciliation is the point of this screen. A tax invoice number is a position in a
 * consecutive series, and what an auditor asks is not "are there gaps" but "can you
 * account for every number". So each series shows how many it has issued, how many are on
 * a document, and how many were spent and explained — and names anything that is neither.
 */
export default async function InvoicesPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!can(user.role, 'record-money')) redirect('/console/model-1/rates');

  const [series, customers] = await Promise.all([allSeries(), listCustomers()]);
  const thisYear = financialYear(new Date());
  const database = await db();
  const invoices = await database
    .collection<Invoice>(COLLECTIONS.invoices)
    .find()
    .sort({ raisedAt: -1 })
    .limit(50)
    .toArray();

  const reconciliations = await Promise.all(
    series.map(async (entry) => ({
      entry,
      result: await reconcileSeries(entry.financialYear, entry.prefix),
    })),
  );

  const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Invoices</h2>
        <p className="lede">
          Documents raised, and the series they are numbered from. A number is a position in
          a consecutive run — every one has to be either on an invoice or explained.
        </p>

        <h3>Run a bill</h3>
        <p className="lede" style={{ marginTop: 0 }}>
          Closes a period and raises its invoices. Look at what it would bill first — a number
          taken from the series is never reused, so this is a decision rather than a discovery.
        </p>
        <BillRunForm
          customers={customers.map((customer) => ({ code: customer.code, name: customer.name }))}
        />

        <h3>Correct an invoice</h3>
        <p className="lede" style={{ marginTop: 0 }}>
          An issued invoice is never edited — it is what the customer was charged. A correction is
          a second numbered document against it: a credit note reduces what is owed, a debit note
          increases it. Which one applies is decided from the invoice&rsquo;s state, not chosen
          here.
        </p>
        <CorrectionForm
          invoices={invoices
            .filter((invoice) => invoice.number && invoice.status !== 'cancelled')
            .map((invoice) => ({
              number: invoice.number,
              customerCode: invoice.customerCode,
              total: rupees(invoice.totalPaise),
              status: invoice.status,
            }))}
        />

        <h3>The series</h3>
        {series.length === 0 ? (
          <p className="empty">
            Nothing issued yet. The series starts at 1 the first time an invoice is raised, and
            restarts each financial year.
          </p>
        ) : (
          <div className="gridscroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Series</th>
                  <th style={{ textAlign: 'right' }}>Issued</th>
                  <th style={{ textAlign: 'right' }}>On a document</th>
                  <th style={{ textAlign: 'right' }}>Explained</th>
                  <th>Accounted for</th>
                </tr>
              </thead>
              <tbody>
                {reconciliations.map(({ entry, result }) => (
                  <tr key={`${entry.prefix}-${entry.financialYear}`}>
                    <td>
                      <strong>
                        {entry.prefix}/{entry.financialYear}
                      </strong>
                      {entry.financialYear === thisYear && <div className="sub">current year</div>}
                    </td>
                    <td className="num">{result?.allocated ?? 0}</td>
                    <td className="num">{result?.onDocuments ?? 0}</td>
                    <td className="num">{result?.explained ?? 0}</td>
                    <td>
                      {result?.balanced ? (
                        <span className="chip live">all accounted for</span>
                      ) : (
                        <>
                          <span className="chip pending">
                            {result?.unaccounted.length} unaccounted
                          </span>
                          <div className="sub">
                            {result?.unaccounted.slice(0, 4).join(', ')}
                            {(result?.unaccounted.length ?? 0) > 4 ? ', …' : ''}
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {series.some((entry) => entry.gaps.length > 0) && (
          <>
            <h3>Numbers spent on nothing</h3>
            <p className="lede" style={{ marginTop: 0 }}>
              A number is taken before the document is written, so a failure in between spends
              one. It is never reused — that would put two documents at the same position — so
              it is recorded here with its reason.
            </p>
            <div className="gridscroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>When</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {series.flatMap((entry) =>
                    entry.gaps.map((gap) => (
                      <tr key={gap.number}>
                        <td className="ref">{gap.number}</td>
                        <td>{new Date(gap.at).toLocaleDateString('en-IN', { dateStyle: 'medium' })}</td>
                        <td>{gap.reason}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        <h3>Recent invoices ({invoices.length})</h3>
        {invoices.length === 0 ? (
          <p className="empty">None raised yet.</p>
        ) : (
          <div className="gridscroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Customer</th>
                  <th>Mode</th>
                  <th>Period</th>
                  <th style={{ textAlign: 'right' }}>Lines</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.number || invoice.naturalKey}>
                    <td className="ref">{invoice.number || <span className="muted">unnumbered</span>}</td>
                    <td>{invoice.customerCode}</td>
                    <td>
                      {invoice.mode}
                      <div className="sub">
                        SAC {invoice.sac} · {Math.round(invoice.gstRate * 100)}%
                        {invoice.rcm ? ' · reverse charge' : ''}
                      </div>
                    </td>
                    <td>
                      {invoice.periodFrom.toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                    </td>
                    <td className="num">{invoice.lines.length}</td>
                    <td className="num">{rupees(invoice.totalPaise)}</td>
                    <td>
                      <span className={`chip ${invoice.status === 'paid' ? 'live' : ''}`}>
                        {invoice.status}
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
