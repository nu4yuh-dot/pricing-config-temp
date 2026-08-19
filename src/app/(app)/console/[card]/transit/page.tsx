import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { findCard, draftVersion, liveVersion } from '../../../../../data/rate-cards';
import { canEditDraft } from '../../../../../data/workflow';
import { AIR_ZONES, SURFACE_ZONES } from '../../../../../domain/zones';
import { STORED_MODES, type StoredMode } from '../../../../../domain/types';
import GridEditor, { type GridSpec } from '../../../../../components/console/GridEditor';
import { saveParamEdits } from '../../../../../app/console-actions';

/**
 * Transit times — the working days a lane takes, per mode.
 *
 * These reach the customer on every quote, and until now they were editable only on
 * the sheet UI's TAT tabs. Blank means the mode does not serve that lane, which is the
 * same `null` the rate grids use, so a lane that cannot be carried does not quote a
 * transit time either.
 */

const MODE_LABELS: Record<StoredMode, string> = {
  air: 'TAT Air — air hub to air hub',
  surface: 'TAT Surface — zone to zone',
  rail: 'ETA Rail — zone to zone',
};

const zonesFor = (mode: StoredMode): readonly string[] =>
  mode === 'air' ? AIR_ZONES : SURFACE_ZONES;

export default async function TransitPage({ params }: { params: Promise<{ card: string }> }) {
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

  const grids: GridSpec[] = STORED_MODES.map((mode) => {
    const zones = zonesFor(mode);
    const draftGrid = draft.data.transitTimes[mode] ?? {};
    const liveGrid = live.data.transitTimes[mode] ?? {};
    return {
      key: mode,
      title: MODE_LABELS[mode],
      hint: 'working days',
      rowHeader: 'From',
      columns: [...zones],
      note: 'A blank cell means this mode does not serve that lane, and no transit time is quoted for it.',
      rows: zones.map((origin) => ({
        label: origin,
        cells: zones.map((destination) => ({
          bind: `transitTimes.${mode}.${origin}.${destination}`,
          value: draftGrid[origin]?.[destination] ?? null,
          liveValue: liveGrid[origin]?.[destination] ?? null,
          kind: 'number' as const,
          title: `${origin} → ${destination}`,
          placeholder: '—',
        })),
      })),
    };
  });

  return (
    <>
      <h2>Transit times</h2>
      <p className="lede">
        Working days per lane, per mode. Every quote carries the number for the lane it prices, so a
        wrong value here is visible to the customer even when the price is right.
      </p>

      <GridEditor
        grids={grids}
        canEdit={canEdit}
        consequence="Quoted transit days, not the price."
        onSave={async (edits) => {
          'use server';
          await saveParamEdits(cardKey, edits);
        }}
      />
    </>
  );
}
