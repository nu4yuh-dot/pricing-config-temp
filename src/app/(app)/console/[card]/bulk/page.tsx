import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { draftVersion, findCard } from '../../../../../data/rate-cards';
import { laneRecord } from '../../../../../console/lanes';
import { canEditDraft } from '../../../../../data/workflow';
import { SURFACE_ZONES } from '../../../../../domain/zones';
import type { ZoneCartage } from '../../../../../domain/types';
import BulkEditor from '../../../../../components/console/BulkEditor';
import ChargeBulkEditor, {
  type ChargeGroup,
  type ChargeTarget,
} from '../../../../../components/console/ChargeBulkEditor';
import { saveLaneEdits, saveParamEdits } from '../../../../../app/console-actions';

/**
 * Repricing in one operation — including discounts.
 *
 * A discount on this card is a bulk decrease: it moves the book rate, goes through the
 * same approval as any other change, and once live is what new customers are quoted.
 * Customers who have already negotiated a cell keep their agreed number, because a
 * contract stores that value rather than tracking the card.
 */

const CARTAGE_FIELDS: (keyof ZoneCartage)[] = [
  'pickupSurface',
  'deliverySurface',
  'pickupAir',
  'deliveryAir',
];

const GROUPS: ChargeGroup[] = [
  { key: 'cartage-default', label: 'Card default cartage', hint: 'Pickup and delivery, air and surface' },
  { key: 'cartage-zone', label: 'Per-zone cartage', hint: 'Zones that override the card default' },
  { key: 'docket', label: 'Docket / AWB', hint: 'Charged once per shipment' },
  { key: 'oda', label: 'ODA / EDL matrix', hint: 'Every band of the out-of-area surcharge' },
];

export default async function BulkPage({ params }: { params: Promise<{ card: string }> }) {
  const { card: cardKey } = await params;
  const user = await currentUser();
  if (!user) notFound();
  const card = await findCard(cardKey);
  // Lane-shaped pages only exist for our own network. A franchise or export card
  // has none of this data, and rendering an empty editor for one invites somebody
  // to type rates into fields nothing will ever read.
  if (!card || (card.source ?? 'dns') !== 'dns') notFound();

  const draft = await draftVersion(cardKey);
  const canEdit = can(user.role, 'edit-draft') && canEditDraft(draft.state);
  const data = draft.data;

  // Only money. Percentages, weights and divisors are not discountable — a percentage
  // off a fuel percentage means nothing anyone intends.
  const targets: ChargeTarget[] = [
    ...CARTAGE_FIELDS.map((field) => ({
      bind: `charges.${field}`,
      value: data.charges[field],
      group: 'cartage-default',
    })),
    { bind: 'charges.docket', value: data.charges.docket, group: 'docket' },
    ...SURFACE_ZONES.flatMap((zone) =>
      CARTAGE_FIELDS.flatMap((field) => {
        const value = data.pickupDelivery[zone]?.[field];
        return value === undefined
          ? []
          : [{ bind: `pickupDelivery.${zone}.${field}`, value, group: 'cartage-zone' }];
      }),
    ),
    ...data.edlMatrix.rates.flatMap((row, rowIndex) =>
      row.flatMap((value, columnIndex) =>
        value === null || value === undefined
          ? []
          : [{ bind: `edlMatrix.rates.${rowIndex}.${columnIndex}`, value, group: 'oda' }],
      ),
    ),
  ].filter((target) => typeof target.value === 'number');

  return (
    <>
      <h2>Bulk changes &amp; discounts</h2>
      <p className="lede">
        A fuel-driven increase, an across-the-board correction or a discount is one operation here,
        not hundreds of edits. Everything written goes to the draft and through the usual approval.
        Unserved lanes are always skipped — opening a lane is a deliberate decision, never a side
        effect. Customers who have already negotiated a rate keep it: a contract stores the agreed
        number rather than following this card.
      </p>

      <BulkEditor
        cardKey={cardKey}
        lanes={laneRecord(data)}
        canEdit={canEdit}
        onApply={async (edits) => {
          'use server';
          await saveLaneEdits(cardKey, edits);
        }}
      />

      <ChargeBulkEditor
        groups={GROUPS}
        targets={targets}
        canEdit={canEdit}
        onApply={async (edits) => {
          'use server';
          await saveParamEdits(cardKey, edits);
        }}
      />
    </>
  );
}
