import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { draftVersion, liveVersion, findCard } from '../../../../../data/rate-cards';
import { canEditDraft } from '../../../../../data/workflow';
import TaxChargesEditor from '../../../../../components/console/TaxChargesEditor';
import {
  modeTaxRows,
  fuelBaseRows,
  chargeRows,
  essZoneRows,
} from '../../../../../console/settlement-fields';
import { saveParamEdits } from '../../../../../app/console-actions';

/**
 * The console view of the Tax & Charges tab.
 *
 * Same values, same draft, same approval — presented as dropdowns rather than cells you
 * type "Yes" into, because every switch here is a yes/no decision.
 */

export default async function TaxPage({ params }: { params: Promise<{ card: string }> }) {
  const { card: cardKey } = await params;
  const user = await currentUser();
  if (!user) notFound();
  const card = await findCard(cardKey);
  // Lane-shaped pages only exist for our own network. A franchise or export card
  // has none of this data, and rendering an empty editor for one invites somebody
  // to type rates into fields nothing will ever read.
  if (!card || (card.source ?? 'dns') !== 'dns') notFound();

  const [draft, live] = await Promise.all([draftVersion(cardKey), liveVersion(cardKey)]);
  const canEdit = can(user.role, 'edit-draft') && canEditDraft(draft.state);

  return (
    <>
      <h2>Tax &amp; charges</h2>
      <p className="lede">
        GST is a property of the transport mode, not of the customer: road freight is 5% under
        reverse charge while air is 18% forward. The fuel base decides what the fuel percentage is
        levied on — some contracts charge it on total charges rather than on freight. The charge menu
        is where ancillaries are switched on, priced, and put inside or outside GST.
      </p>

      <TaxChargesEditor
        modes={modeTaxRows(draft.data, live.data)}
        fuelBase={fuelBaseRows(draft.data, live.data)}
        charges={chargeRows(draft.data, live.data)}
        essZones={essZoneRows(draft.data, live.data)}
        canEdit={canEdit}
        onSave={async (edits) => {
          'use server';
          await saveParamEdits(cardKey, edits);
        }}
      />
    </>
  );
}
