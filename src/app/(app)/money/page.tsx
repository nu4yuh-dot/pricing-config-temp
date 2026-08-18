import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../auth/session';
import { listCustomers } from '../../../data/customers';
import { billingFor } from '../../../data/billing';
import { formatRupees } from '../../../billing/ledger';
import { DEFAULT_COMMERCIAL_TERMS } from '../../../domain/customers';

/**
 * Money — wallets, credit and invoices, read from the one ledger.
 *
 * Parts 11 and 12 of the redesign describe wallet balances, credit ageing and invoices as
 * three screens. They are three views of the same append-only ledger that already exists:
 * a balance is a replay of a customer's entries, an ageing bucket is the same replay
 * grouped by date, and an invoice is an entry with a document attached. Nothing here
 * recomputes a price — billing only decides when what was already charged gets collected.
 */
export default async function MoneyPage() {
  const user = await currentUser();
  if (!user) notFound();

  const customers = await listCustomers();
  const positions = await Promise.all(
    customers.map(async (customer) => {
      const terms = customer.commercial ?? DEFAULT_COMMERCIAL_TERMS;
      const billing = await billingFor(customer.code, {
        creditLimit: terms.creditLimit,
        paymentTermsDays: terms.paymentTermsDays,
      });
      return { customer, terms, billing };
    }),
  );

  const active = positions.filter(
    (entry) =>
      entry.billing.balancePaise !== 0 ||
      entry.billing.position.outstanding !== 0 ||
      entry.billing.invoices.length > 0,
  );

  const totalOwed = active.reduce((sum, entry) => sum + entry.billing.position.owed, 0);
  const totalOverdue = active.reduce((sum, entry) => sum + entry.billing.position.overdue, 0);
  const prepaid = active.filter((entry) => entry.billing.balancePaise > 0);

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Money</h2>
        <p className="lede">
          Wallets, credit and invoices are three views of one append-only ledger. A balance is a
          replay of a customer&rsquo;s entries, an ageing bucket is the same replay grouped by
          date, and an invoice is an entry with a document attached — so marking one paid moves
          the ageing on its own, because there is nothing else to update.
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">Owed to DNS</div>
            <div className={totalOwed ? 'v' : 'v muted'}>₹{formatRupees(totalOwed)}</div>
            <div className="sub">Net of money already paid in</div>
          </div>
          <div className="stat">
            <div className="k">Overdue</div>
            <div className={totalOverdue ? 'v' : 'v muted'}>₹{formatRupees(totalOverdue)}</div>
          </div>
          <div className="stat">
            <div className="k">Prepaid wallets in credit</div>
            <div className={prepaid.length ? 'v' : 'v muted'}>{prepaid.length}</div>
          </div>
        </div>

        {active.length === 0 ? (
          <div className="panel">
            <div className="empty">
              Nothing on the ledger yet. Entries arrive when a booking is billed, a recharge is
              recorded, or an invoice is raised.
            </div>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Terms</th>
                  <th style={{ textAlign: 'right' }}>Wallet</th>
                  <th style={{ textAlign: 'right' }}>Owed</th>
                  <th style={{ textAlign: 'right' }}>0 – 15</th>
                  <th style={{ textAlign: 'right' }}>16 – 30</th>
                  <th style={{ textAlign: 'right' }}>31+</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {active.map(({ customer, terms, billing }) => (
                  <tr key={customer.code}>
                    <td>
                      <Link href={`/customers/${encodeURIComponent(customer.code)}`}>
                        {customer.name}
                      </Link>
                      <div style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                        {billing.invoices.length} invoice
                        {billing.invoices.length === 1 ? '' : 's'}
                      </div>
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {terms.creditLimit === null ? (
                        'prepaid — no credit facility'
                      ) : (
                        <>
                          ₹{formatRupees(billing.position.limit)} limit · {terms.paymentTermsDays}{' '}
                          days
                        </>
                      )}
                    </td>
                    <td
                      className="num"
                      style={{
                        color: billing.balancePaise < 0 ? 'var(--rejected)' : 'var(--ink)',
                      }}
                    >
                      ₹{formatRupees(billing.balancePaise)}
                    </td>
                    <td className="num">₹{formatRupees(billing.position.owed)}</td>
                    {billing.ageing.map((bucket) => (
                      <td
                        key={bucket.label}
                        className="num"
                        style={{ color: bucket.overdue ? 'var(--rejected)' : 'var(--ink-soft)' }}
                      >
                        {bucket.amountPaise === 0 ? '—' : `₹${formatRupees(bucket.amountPaise)}`}
                      </td>
                    ))}
                    <td>
                      {billing.position.overLimit ? (
                        <span className="chip rejected">over limit</span>
                      ) : billing.position.overdue > 0 ? (
                        <span className="chip pending">
                          overdue {billing.position.oldestOverdueDays}d
                        </span>
                      ) : (
                        <span className="chip live">clear</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="two-col" style={{ marginTop: '1.4rem' }}>
          <div className="panel">
            <h3>Prepaid</h3>
            <p>
              The balance is debited as the booking is priced. At zero, a new booking is refused
              at quote time with a 402 rather than allowed and billed later — a shipment already
              in transit is never affected by a balance running out behind it.
            </p>
          </div>
          <div className="panel">
            <h3>Credit</h3>
            <p>
              Bookings accumulate against a limit and are invoiced per period, one invoice per
              mode — because GST differs by mode and a single document cannot carry a surface leg
              at 5% reverse charge and an air leg at 18%.
            </p>
          </div>
        </div>

        <div className="panel">
          <h3>One policy question this screen cannot settle</h3>
          <p>
            The engine refuses a new booking while <em>anything</em> is overdue. The mockup says
            the block should trigger only on a limit breach — &ldquo;new bookings are still
            allowed today because total outstanding is under the limit&rdquo; — and describes that
            as how it is decided today. Both are defensible and they are not the same rule. It is
            left as the engine has it, because loosening a funds gate on the strength of a
            caption is not a change to make quietly, and it is flagged here so somebody can
            decide it deliberately.
          </p>
        </div>

        <div className="panel">
          <h3>Invoice cadence and auto-generation</h3>
          <p>
            Invoices are raised for a period on request, and the numbers are deterministic, so
            running a period twice collides rather than billing twice. Per-shipment, weekly and
            monthly cadences with automatic drafts need something to run on a schedule, which
            this service does not have — a cadence stored with nothing to act on it would read
            as a promise the system is not keeping.
          </p>
        </div>
      </div>
    </div>
  );
}
