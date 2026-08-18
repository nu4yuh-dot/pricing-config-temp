import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { draftVersion, liveVersion, findCard } from '../../../../../data/rate-cards';
import { canEditDraft } from '../../../../../data/workflow';
import ParamsEditor, { type ParamField } from '../../../../../components/console/ParamsEditor';
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
 * The same fields as the Bluedart Rates tab, as labelled inputs grouped by service. There
 * is no lane to pick here — everything ships ex-Pune, so a rate is a zone and a weight band,
 * which is exactly what a form is good at.
 */

const SLAB_LABELS: { field: string; label: (from: number) => string }[] = [
  { field: 'firstBlock', label: (from) => `First ${from} kg — flat` },
  { field: 'to25', label: (from) => `${from}–25 kg` },
  { field: 'to50', label: () => '25–50 kg' },
  { field: 'to100', label: () => '50–100 kg' },
  { field: 'above100', label: () => '100 kg and above' },
];

const CHARGE_FIELDS: { key: string; label: string; unit: ParamField['unit']; effect: string }[] = [
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

  const field = (bind: string, label: string, unit: ParamField['unit'], effect: string, group: string): ParamField => ({
    bind,
    label,
    unit,
    effect,
    group,
    value: read(draft.data, bind),
    liveValue: read(live.data, bind),
  });

  const fields: ParamField[] = [];

  for (const zone of BLUEDART_ZONES as readonly BluedartZone[]) {
    const tier = ZONE_DISTANCE_TIER[zone];
    fields.push(
      field(`bluedart.zones.${zone}.docs`, `${zone} — DOCs`, 'currency', `per 500 g · ${tier}`, 'Documents & non-documents, per 500 g'),
      field(`bluedart.zones.${zone}.duts`, `${zone} — DUTS`, 'currency', `per 500 g · ${tier}`, 'Documents & non-documents, per 500 g'),
    );
  }

  for (const [service, firstBlockTo, group] of [
    ['apex', 5, 'APEX — air, premium'],
    ['surface', 10, 'SURFACE — economy'],
  ] as const) {
    for (const zone of BLUEDART_ZONES as readonly BluedartZone[]) {
      for (const slab of SLAB_LABELS) {
        fields.push(
          field(
            `bluedart.zones.${zone}.${service}.${slab.field}`,
            `${zone} — ${slab.label(firstBlockTo)}`,
            'currency',
            slab.field === 'firstBlock' ? 'Flat, covers the minimum weight' : 'Rs per kg in this band only',
            group,
          ),
        );
      }
    }
  }

  for (const charge of CHARGE_FIELDS) {
    fields.push(
      field(`bluedart.charges.${charge.key}`, charge.label, charge.unit, charge.effect, 'Charges & rules'),
    );
  }

  fields.push(
    field('bluedart.oda.perKmBeyond', 'Beyond the last band', 'currency', 'Rs per km', 'ODA / EDL'),
    field('bluedart.oda.perKmThreshold', 'Distance it applies past', 'number', 'km', 'ODA / EDL'),
  );

  return (
    <>
      <h2>Bluedart rates</h2>
      <p className="lede">
        A different product from the DNS cards. Everything ships ex-Pune, so a price depends only on
        where it is going — five directional zones, not a lane matrix. Documents and non-documents
        are billed per 500 g; APEX and SURFACE build up slab by slab from a fixed first block, so a
        heavier shipment always costs more.
      </p>

      <ParamsEditor
        fields={fields}
        canEdit={canEdit}
        onSave={async (edits) => {
          'use server';
          await saveParamEdits(cardKey, edits);
        }}
      />
    </>
  );
}
