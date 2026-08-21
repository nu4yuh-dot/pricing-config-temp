import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '../../../auth/session';
import { recentQuotes } from '../../../data/quotes';

/**
 * Rate audit — why a shipment was charged what it was.
 *
 * Every quote we answer is already stored with the card version that priced it, a
 * fingerprint of the contract terms in force, and the lane rule that resolved. This screen
 * is that record read back, which is the whole reason the record exists: six weeks after
 * an invoice, "the rate card said so at the time" has to be provable rather than asserted.
 *
 * The column worth looking at is the resolution. It names which rule won and how specific
 * it was — and flags where two rules were equally specific and the winner came down to
 * which was edited last, because at that point somebody should collapse them.
 */
export default async function AuditPage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  const quotes = await recentQuotes(100);

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Rate audit</h2>
        <p className="lede">
          Every price this service has quoted, and what produced it — the card version, the
          contract terms in force, and the lane rule that won. This is what makes a charge
          explainable after the card has moved on.
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">Quotes recorded</div>
            <div className="v">{quotes.length}</div>
            <div className="sub">Most recent first</div>
          </div>
          <div className="stat">
            <div className="k">Against a contract</div>
            <div className="v">
              {quotes.filter((quote) => quote.pricedAgainst.customerCode).length}
            </div>
          </div>
          <div className="stat">
            <div className="k">Expired</div>
            <div className="v muted">
              {quotes.filter((quote) => quote.validUntil && quote.validUntil < new Date()).length}
            </div>
            <div className="sub">Past their validity, must be re-priced</div>
          </div>
        </div>

        {quotes.length === 0 ? (
          <p className="empty">
            Nothing quoted yet. Every answer from the quoting API is recorded here.
          </p>
        ) : (
          <div className="gridscroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Quote</th>
                  <th>When</th>
                  <th>Customer</th>
                  <th>Lane</th>
                  <th>Priced against</th>
                  <th>How the rate resolved</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((quote) => {
                  const first = quote.tiers[0];
                  const source = (first?.breakdown as { rateSource?: string } | undefined)?.rateSource;
                  return (
                    <tr key={quote.quoteId}>
                      <td className="ref">{quote.quoteId}</td>
                      <td>
                        {quote.createdAt.toLocaleDateString('en-IN', {
                          dateStyle: 'medium',
                        })}
                        {quote.validUntil && quote.validUntil < new Date() && (
                          <div className="sub">expired</div>
                        )}
                      </td>
                      <td>
                        {quote.request.customerCode ? (
                          <Link href={`/customers/${quote.request.customerCode}`}>
                            {quote.request.customerCode}
                          </Link>
                        ) : (
                          <span className="muted">book rate</span>
                        )}
                      </td>
                      <td>
                        {quote.request.originPincode} → {quote.request.destinationPincode}
                        <div className="sub">
                          {quote.request.actualWeight} kg
                          {first ? ` · ${first.service.toLowerCase()}` : ''}
                        </div>
                      </td>
                      <td>
                        {quote.pricedAgainst.cardName}
                        <div className="sub">
                          version {quote.pricedAgainst.cardVersion ?? '—'}
                          {quote.pricedAgainst.contractOverrides
                            ? ` · ${quote.pricedAgainst.contractOverrides} negotiated cells`
                            : ''}
                        </div>
                      </td>
                      <td>
                        {source ?? <span className="muted">—</span>}
                        {quote.pricedAgainst.contractFingerprint && (
                          <div className="sub">
                            terms {quote.pricedAgainst.contractFingerprint}
                          </div>
                        )}
                      </td>
                      <td className="num">
                        {first ? `₹${first.total.toLocaleString('en-IN')}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
