import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { findCard, draftVersion, liveVersion } from '../../../../../data/rate-cards';
import { canEditDraft } from '../../../../../data/workflow';
import { SURFACE_ZONES } from '../../../../../domain/zones';
import type { ZoneCartage } from '../../../../../domain/types';
import GridEditor, { type GridSpec } from '../../../../../components/console/GridEditor';
import { saveParamEdits } from '../../../../../app/console-actions';

/**
 * Pickup and delivery cartage, per zone.
 *
 * `Charges & surcharges` holds one default per leg per mode; this is where a zone
 * departs from it. A blank cell falls back to that default, so the sheet is sparse by
 * design and a zone that has never been negotiated separately stays empty.
 */

const COLUMNS: { key: keyof ZoneCartage; label: string }[] = [
  { key: 'pickupSurface', label: 'Pickup · surface' },
  { key: 'deliverySurface', label: 'Delivery · surface' },
  { key: 'pickupAir', label: 'Pickup · air' },
  { key: 'deliveryAir', label: 'Delivery · air' },
];

export default async function CartagePage({ params }: { params: Promise<{ card: string }> }) {
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

  const defaults = draft.data.charges;

  const grids: GridSpec[] = [
    {
      key: 'cartage',
      title: 'Cartage by zone — rupees per shipment',
      hint: `blank falls back to the card default`,
      rowHeader: 'Zone',
      columns: COLUMNS.map((column) => column.label),
      note: `Defaults on this card: pickup ₹${defaults.pickupSurface} / delivery ₹${defaults.deliverySurface} surface, pickup ₹${defaults.pickupAir} / delivery ₹${defaults.deliveryAir} air. Cartage sits inside the fuel base, so changing one moves the fuel surcharge with it.`,
      rows: SURFACE_ZONES.map((zone) => ({
        label: zone,
        cells: COLUMNS.map((column) => ({
          bind: `pickupDelivery.${zone}.${column.key}`,
          value: draft.data.pickupDelivery[zone]?.[column.key] ?? null,
          liveValue: live.data.pickupDelivery[zone]?.[column.key] ?? null,
          kind: 'number' as const,
          title: `${zone} · ${column.label}`,
          placeholder: String(defaults[column.key]),
        })),
      })),
    },
  ];

  return (
    <>
      <h2>Cartage by zone</h2>
      <p className="lede">
        What pickup and delivery cost in each zone, where that zone differs from the card default set
        on <Link href={`/console/${cardKey}/params`}>Charges &amp; surcharges</Link>. A blank cell
        uses the default, shown greyed in the box.
      </p>

      <GridEditor
        grids={grids}
        canEdit={canEdit}
        consequence="Reprices every shipment collected or delivered in that zone."
        onSave={async (edits) => {
          'use server';
          await saveParamEdits(cardKey, edits);
        }}
      />
    </>
  );
}
