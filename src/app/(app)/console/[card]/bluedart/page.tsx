import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { draftVersion, liveVersion, findCard } from '../../../../../data/rate-cards';
import { canEditDraft } from '../../../../../data/workflow';
import GridEditor, { type GridSpec, type GridCellSpec } from '../../../../../components/console/GridEditor';
import { saveParamEdits } from '../../../../../app/console-actions';
import {
  BLUEDART_ZONES,
  ZONE_DISTANCE_TIER,
  type BluedartZone,
} from '../../../../../domain/bluedart';
import type { RateCardData } from '../../../../../domain/types';

/**
 * The console view of the Bluedart rates.
 *
 * Everything ships ex-Pune, so a rate is a zone and a weight band — a matrix, not a form.
 * Twenty-five labelled boxes said the same thing as a five-by-five table and took five
 * times the screen to say it, and the shape of the tariff was invisible: you could not see
 * that a rate falls as the weight rises without reading every box.
 *
 * The two settings tables are the same editor with one column, so there is one save button
 * for the card rather than one per section.
 */

const SLAB_LABELS: { field: string; label: (from: number) => string }[] = [
  { field: 'firstBlock', label: (from) => `First ${from} kg — flat` },
  { field: 'to25', label: (from) => `${from}–25 kg` },
  { field: 'to50', label: () => '25–50 kg' },
  { field: 'to100', label: () => '50–100 kg' },
  { field: 'above100', label: () => '100 kg and above' },
];

const CHARGE_FIELDS: { key: string; label: string; unit: GridCellSpec['unit']; effect: string }[] = [
  { key: 'fuelAir', label: 'Fuel — air', unit: 'percent', effect: 'On freight + ODA; DOCs and DUTS use this too' },
  { key: 'fuelSurface', label: 'Fuel — surface', unit: 'percent', effect: 'On freight + ODA' },
  { key: 'awb', label: 'AWB / docket', unit: 'currency', effect: 'APEX and SURFACE only' },
  { key: 'fovRate', label: 'FOV / risk', unit: 'percent', effect: 'Of declared value' },
  { key: 'fovMinimum', label: 'FOV minimum', unit: 'currency', effect: 'Charged even at nil declared value' },
  { key: 'gstRate', label: 'GST', unit: 'percent', effect: 'On the pre-GST sub-total' },
  { key: 'volumetricDivisorAir', label: 'Volumetric divisor — air', unit: 'number', effect: 'L×B×H cm ÷ this; also DUTS' },
  { key: 'volumetricDivisorSurface', label: 'Volumetric divisor — surface', unit: 'number', effect: 'L×B×H cm ÷ this, then ×' },
  { key: 'volumetricMultiplierSurface', label: 'Volumetric multiplier — surface', unit: 'number', effect: '× the divided volume' },
];

export default async function BluedartPage({ params }: { params: Promise<{ card: string }> }) {
  const { card: cardKey } = await params;
  const user = await currentUser();
  if (!user) notFound();
  const card = await findCard(cardKey);
  if (!card || (card.source ?? 'dns') !== 'bluedart') notFound();

  const [draft, live] = await Promise.all([draftVersion(cardKey), liveVersion(cardKey)]);
  const canEdit = can(user.role, 'edit-draft') && canEditDraft(draft.state);

  const read = (data: RateCardData, path: string): number => {
    const value = path.split('.').reduce<unknown>(
      (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
      data,
    );
    return typeof value === 'number' ? value : 0;
  };

  const cell = (bind: string, unit: GridCellSpec['unit'], title: string): GridCellSpec => ({
    bind,
    value: read(draft.data, bind),
    liveValue: read(live.data, bind),
    kind: 'number',
    unit,
    title,
  });

  const zones = BLUEDART_ZONES as readonly BluedartZone[];

  /** A settings table: one row per field, one value column. Same editor, one column. */
  const settings = (
    key: string,
    title: string,
    hint: string,
    entries: { bind: string; label: string; unit: GridCellSpec['unit']; effect: string }[],
  ): GridSpec => ({
    key,
    title,
    hint,
    rowHeader: 'Setting',
    columns: ['Value'],
    rows: entries.map((entry) => ({
      label: entry.label,
      cells: [cell(entry.bind, entry.unit, `${entry.label} — ${entry.effect}`)],
    })),
  });

  const grids: GridSpec[] = [
    {
      key: 'docs',
      title: 'Documents & non-documents',
      hint: 'rupees per 500 g',
      rowHeader: 'Zone',
      columns: ['DOCs', 'DUTS'],
      note: 'Billed per 500 g rather than per kilogram, and the whole shipment is charged at the destination zone.',
      rows: zones.map((zone) => ({
        label: `${zone} · ${ZONE_DISTANCE_TIER[zone]}`,
        cells: [
          cell(`bluedart.zones.${zone}.docs`, 'currency', `${zone} — DOCs, per 500 g`),
          cell(`bluedart.zones.${zone}.duts`, 'currency', `${zone} — DUTS, per 500 g`),
        ],
      })),
    },
    ...(
      [
        ['apex', 5, 'APEX — air, premium'],
        ['surface', 10, 'SURFACE — economy'],
      ] as const
    ).map(([service, firstBlockTo, title]): GridSpec => ({
      key: service,
      title,
      hint: 'first block is a flat charge; the rest are rupees per kg in that band',
      rowHeader: 'Zone',
      columns: SLAB_LABELS.map((slab) => slab.label(firstBlockTo)),
      note: 'The price builds up slab by slab from the first block, so a heavier shipment always costs more even where the per-kilogram rate falls.',
      rows: zones.map((zone) => ({
        label: `${zone} · ${ZONE_DISTANCE_TIER[zone]}`,
        cells: SLAB_LABELS.map((slab) =>
          cell(
            `bluedart.zones.${zone}.${service}.${slab.field}`,
            'currency',
            `${zone} — ${slab.label(firstBlockTo)}`,
          ),
        ),
      })),
    })),
    settings(
      'charges',
      'Charges & rules',
      'applies to every zone',
      CHARGE_FIELDS.map((charge) => ({
        bind: `bluedart.charges.${charge.key}`,
        label: charge.label,
        unit: charge.unit,
        effect: charge.effect,
      })),
    ),
    settings('oda', 'ODA / EDL', 'beyond the last band', [
      {
        bind: 'bluedart.oda.perKmBeyond',
        label: 'Beyond the last band',
        unit: 'currency',
        effect: 'Rs per km',
      },
      {
        bind: 'bluedart.oda.perKmThreshold',
        label: 'Distance it applies past',
        unit: 'number',
        effect: 'km',
      },
    ]),
  ];

  return (
    <>
      <h2>Bluedart rates</h2>
      <p className="lede">
        A different product from the DNS cards. Everything ships ex-Pune, so a price depends only on
        where it is going — five directional zones, not a lane matrix. Documents and non-documents
        are billed per 500 g; APEX and SURFACE build up slab by slab from a fixed first block, so a
        heavier shipment always costs more.
      </p>

      <GridEditor
        grids={grids}
        canEdit={canEdit}
        tabbed
        consequence="Reprices every Bluedart shipment to that zone."
        onSave={async (edits) => {
          'use server';
          await saveParamEdits(cardKey, edits);
        }}
      />
    </>
  );
}
