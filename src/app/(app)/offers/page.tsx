import { notFound } from 'next/navigation';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import { listOffers } from '../../../data/offers';
import { listProducts } from '../../../data/products';
import { listCustomers } from '../../../data/customers';
import { listCards, draftVersion } from '../../../data/rate-cards';
import { chargeLibrary } from '../../../domain/charge-library';
import { offerWindow } from '../../../domain/offers';
import NewOfferForm from '../../../components/console/NewOfferForm';
import OfferSwitch from '../../../components/console/OfferSwitch';

const WINDOW_CHIP: Record<string, string> = {
  active: 'live',
  scheduled: 'draft',
  expired: '',
};

/**
 * Offers — the only prices here that move without anybody editing a rate.
 *
 * Everything else in this system is a stored value somebody negotiated. An offer is a
 * time-boxed adjustment resolved at quote time, which is what lets it end by arithmetic
 * rather than by somebody remembering on the 16th of November.
 */
export default async function OffersPage() {
  const user = await currentUser();
  if (!user) notFound();

  const [offers, products, customers, cards] = await Promise.all([
    listOffers(),
    listProducts(),
    listCustomers(),
    listCards(),
  ]);
  const drafts = await Promise.all(cards.map((card) => draftVersion(card.key)));
  const library = chargeLibrary(
    drafts.map((draft) => draft.data),
    customers.map((customer) => customer.liveTerms.overrides),
  );

  const now = new Date();
  const canEdit = can(user.role, 'edit-draft');

  const segments = [
    ...new Set([
      ...customers.flatMap((customer) => customer.tags ?? []),
      ...products.flatMap((product) => (product.segment ? [product.segment] : [])),
    ]),
  ].sort();

  const describe = (offer: (typeof offers)[number]) =>
    offer.kind === 'percent-off-freight'
      ? `${offer.value}% off freight`
      : offer.kind === 'amount-off-freight'
        ? `₹${offer.value} off freight`
        : `${library.find((charge) => charge.id === offer.chargeId)?.name ?? offer.chargeId} waived`;

  const reach = (offer: (typeof offers)[number]) => {
    if (offer.audience.kind === 'customer') return offer.audience.value;
    if (offer.audience.kind === 'product') {
      return products.find((product) => product.key === offer.audience.value)?.name ?? offer.audience.value;
    }
    const count = customers.filter((customer) =>
      (customer.tags ?? []).some(
        (tag) => tag.trim().toLowerCase() === offer.audience.value.trim().toLowerCase(),
      ),
    ).length;
    return `${offer.audience.value} · ${count} customer${count === 1 ? '' : 's'}`;
  };

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Offers</h2>
        <p className="lede">
          A rate that changes for a fortnight and then puts itself back. An offer never touches a
          stored rate — it is applied at quote time and expires by arithmetic — which is the
          whole point, because a festival discount hand-edited in has to be hand-edited out, and
          the edit that gets forgotten is always the second one.
        </p>

        {offers.length === 0 ? (
          <div className="panel">
            <div className="empty">Nothing scheduled.</div>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Offer</th>
                  <th>What it does</th>
                  <th>Who it reaches</th>
                  <th>When</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {offers.map((offer) => {
                  const window = offerWindow(offer, now);
                  return (
                    <tr key={offer.key}>
                      <td>
                        <strong>{offer.name}</strong>
                        <div style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                          {offer.createdBy && `scheduled by ${offer.createdBy}`}
                        </div>
                      </td>
                      <td>{describe(offer)}</td>
                      <td style={{ color: 'var(--ink-soft)' }}>{reach(offer)}</td>
                      <td style={{ color: 'var(--ink-soft)' }}>
                        {new Date(offer.startsAt).toLocaleDateString('en-IN')} –{' '}
                        {new Date(offer.endsAt).toLocaleDateString('en-IN')}
                      </td>
                      <td>
                        {!offer.enabled ? (
                          <span className="chip">suspended</span>
                        ) : window === 'expired' ? (
                          <span style={{ color: 'var(--ink-faint)' }}>
                            expired — reverted on its own
                          </span>
                        ) : (
                          <span className={`chip ${WINDOW_CHIP[window]}`}>
                            {window === 'active' ? 'live now' : 'scheduled'}
                          </span>
                        )}
                      </td>
                      <td>
                        {canEdit && window !== 'expired' && (
                          <OfferSwitch offerKey={offer.key} enabled={offer.enabled} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="two-col" style={{ marginTop: '1.4rem' }}>
          <div className="panel">
            <h3>Why this needs no approval</h3>
            <p>
              An offer cannot alter a negotiated rate, it is bounded by dates somebody typed, and
              it undoes itself. What it does need is to be visible, so every quote it touches
              names it and shows what the freight would have been without it.
            </p>
          </div>
          <div className="panel">
            <h3>Why offers do not stack</h3>
            <p>
              Two campaigns overlapping by a week is an ordinary scheduling accident, and stacking
              10% on 15% quietly sells at 23.5% off — a number nobody decided. The larger one
              wins; the other is recorded as considered. Waiving two different charges is not a
              stack, and both hold.
            </p>
          </div>
        </div>

        {canEdit ? (
          <NewOfferForm
            products={products.map((product) => ({ key: product.key, name: product.name }))}
            segments={segments}
            customers={customers.map((customer) => ({ code: customer.code, name: customer.name }))}
            charges={library.map((charge) => ({ id: charge.id, name: charge.name }))}
          />
        ) : (
          <p className="empty">Your role can see offers but not schedule them.</p>
        )}
      </div>
    </div>
  );
}
