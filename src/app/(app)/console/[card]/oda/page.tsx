import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { findCard, draftVersion, liveVersion } from '../../../../../data/rate-cards';
import { canEditDraft } from '../../../../../data/workflow';
import GridEditor, { type GridSpec } from '../../../../../components/console/GridEditor';
import { saveParamEdits } from '../../../../../app/console-actions';

/**
 * The ODA / EDL surcharge matrix.
 *
 * Rows are minimum-kilometre thresholds and columns minimum-weight thresholds; both
 * are matched approximately, largest threshold at or below the value, which is what
 * the source workbook's `MATCH(..., 1)` did.
 *
 * The bands themselves are shown but not editable. Adding or removing one reshapes
 * every row of the matrix, so it is a migration rather than an edit — the same line
 * the network page draws around zones.
 */

const km = (value: number | undefined, next: number | undefined): string =>
  next === undefined ? `${value ?? 0} km +` : `${value ?? 0}–${next - 1} km`;

const kg = (value: number | undefined, next: number | undefined): string =>
  next === undefined ? `${value ?? 0} kg +` : `${value ?? 0}–${next - 1} kg`;

export default async function OdaPage({ params }: { params: Promise<{ card: string }> }) {
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

  const matrix = draft.data.edlMatrix;
  const liveMatrix = live.data.edlMatrix;

  const grids: GridSpec[] = [
    {
      key: 'rates',
      title: 'ODA / EDL surcharge — rupees per shipment',
      hint: 'distance × weight',
      rowHeader: 'Distance',
      columns: matrix.weightBands.map((band, index) => kg(band, matrix.weightBands[index + 1])),
      note: 'A band is matched downwards: a 60 km shipment is charged at the 51 km row. Bands are structural — changing the set of them reshapes every row, so it is handled as a migration.',
      rows: matrix.kmBands.map((band, row) => ({
        label: km(band, matrix.kmBands[row + 1]),
        cells: matrix.weightBands.map((_, column) => ({
          bind: `edlMatrix.rates.${row}.${column}`,
          value: matrix.rates[row]?.[column] ?? null,
          liveValue: liveMatrix.rates[row]?.[column] ?? null,
          kind: 'number' as const,
          title: `${band} km, ${matrix.weightBands[column]} kg`,
        })),
      })),
    },
    {
      key: 'beyond',
      title: 'Beyond the last band',
      hint: 'charged per kilometre',
      rowHeader: '',
      columns: ['Rupees per km', 'Applies beyond (km)'],
      rows: [
        {
          label: 'Long distance',
          cells: [
            {
              bind: 'edlMatrix.perKmBeyondLastBand',
              value: matrix.perKmBeyondLastBand ?? null,
              liveValue: liveMatrix.perKmBeyondLastBand ?? null,
              kind: 'number' as const,
              title: 'Rupees per km past the threshold',
            },
            {
              bind: 'edlMatrix.perKmThreshold',
              value: matrix.perKmThreshold ?? null,
              liveValue: liveMatrix.perKmThreshold ?? null,
              kind: 'number' as const,
              title: 'The distance past which the per-km rate applies',
            },
          ],
        },
      ],
    },
  ];

  return (
    <>
      <h2>ODA &amp; EDL matrix</h2>
      <p className="lede">
        What an out-of-delivery-area shipment costs on top of freight, by distance and weight. This
        is charged on both legs independently — an ODA pickup and an ODA delivery are two lookups —
        and it sits inside the fuel base, so a change here moves the fuel surcharge with it.
      </p>

      <GridEditor
        grids={grids}
        canEdit={canEdit}
        consequence="Reprices every out-of-area shipment on this card."
        onSave={async (edits) => {
          'use server';
          await saveParamEdits(cardKey, edits);
        }}
      />
    </>
  );
}
