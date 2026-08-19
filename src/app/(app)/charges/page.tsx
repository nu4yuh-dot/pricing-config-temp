import { notFound } from 'next/navigation';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import { listCards, draftVersion } from '../../../data/rate-cards';
import { listCustomers } from '../../../data/customers';
import { chargeLibrary, isBookableOneOff } from '../../../domain/charge-library';
import NewChargeForm from '../../../components/console/NewChargeForm';
import { createLibraryCharge } from '../../console-actions';

const BASIS_LABELS: Record<string, string> = {
  'per-shipment': 'flat, per shipment',
  'per-awb': 'flat, per AWB',
  'per-kg': 'per kg of chargeable weight',
  'by-pincode': 'from the pincode distance',
  'per-destination': 'per destination zone',
};

export default async function ChargeLibraryPage() {
  const user = await currentUser();
  if (!user) notFound();

  const [cards, customers] = await Promise.all([listCards(), listCustomers()]);
  const drafts = await Promise.all(cards.map((card) => draftVersion(card.key)));

  const library = chargeLibrary(
    drafts.map((draft) => draft.data),
    customers.map((customer) => customer.liveTerms.overrides),
  );
  const canEdit = can(user.role, 'edit-draft');

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Charge library</h2>
        <p className="lede">
          Every charge anyone has defined, standard or invented, and how many cards and
          contracts carry it. The list is read from what is actually configured rather than
          kept alongside it, so it cannot drift from what is being billed — and the charge
          three contracts already use is the one a fourth should reach for, rather than a
          fourth spelling of the same idea.
        </p>

        <div className="gridscroll">
          <table className="data">
            <thead>
              <tr>
                <th>Charge</th>
                <th>Code</th>
                <th>How it is charged</th>
                <th>GST</th>
                <th>Fuel</th>
                <th>One-off</th>
                <th className="num">In use</th>
              </tr>
            </thead>
            <tbody>
              {library.map((charge) => (
                <tr key={charge.id}>
                  <td>
                    <strong>{charge.name}</strong>
                  </td>
                  <td className="ref">{charge.id}</td>
                  <td>{BASIS_LABELS[charge.basis] ?? charge.basis}</td>
                  {/* Only the exception is worth a chip. Marking every charge "in GST"
                      when almost all of them are put six identical badges on the screen
                      and made the one that is not harder to spot, not easier. */}
                  <td>
                    {charge.gstApplies === false ? (
                      <span className="chip pending">outside GST</span>
                    ) : (
                      <span className="meta">in GST</span>
                    )}
                  </td>
                  <td>
                    {charge.fuelApplies ? (
                      <span className="chip">applies</span>
                    ) : (
                      <span className="meta">—</span>
                    )}
                  </td>
                  <td>
                    {isBookableOneOff(charge) ? (
                      <span className="chip live">bookable</span>
                    ) : (
                      <span className="meta">standing term only</span>
                    )}
                  </td>
                  <td className="num">
                    {charge.usedBy === 0 ? (
                      <span className="meta">not used</span>
                    ) : (
                      `${charge.usedBy} ${charge.usedBy === 1 ? 'place' : 'places'}`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="two-col" style={{ marginTop: '1.4rem' }}>
          <div className="panel">
            <header>
              <h3>Attached as a standing term</h3>
            </header>
            <div className="body">
              <p style={{ marginBottom: 0 }}>
                Switched on for a card or negotiated onto a contract, where it appears on every
                quote that matches its modes — automatically, and priced the same way every time.
              </p>
            </div>
          </div>
          <div className="panel">
            <header>
              <h3>Added one-off at a booking</h3>
            </header>
            <div className="body">
              <p style={{ marginBottom: 0 }}>
                Attached to a single consignment for a customer with no standing term for it. It
                touches no contract, so it cannot quietly become permanent. Only a charge with one
                amount to ask for can be used this way.
              </p>
            </div>
          </div>
        </div>

        <h3>Define a charge</h3>
        {canEdit ? (
          <NewChargeForm
            cards={cards.map((card) => ({ key: card.key, name: card.name }))}
            existingIds={library.map((charge) => charge.id)}
            canEdit={canEdit}
            onCreate={async (cardKey, definition) => {
              'use server';
              await createLibraryCharge(cardKey, definition);
            }}
          />
        ) : (
          <p className="empty">Your role can read the library but not add to it.</p>
        )}
      </div>
    </div>
  );
}
