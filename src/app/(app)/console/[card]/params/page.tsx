import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { draftVersion, liveVersion, findCard } from '../../../../../data/rate-cards';
import { canEditDraft } from '../../../../../data/workflow';
import ParamsEditor, { type ParamField } from '../../../../../components/console/ParamsEditor';
import { saveParamEdits } from '../../../../../app/console-actions';
import type { Charges } from '../../../../../domain/types';

const SPEC: { key: keyof Charges; label: string; unit: ParamField['unit']; effect: string; group: string }[] = [
  { key: 'fuelAir', label: 'Fuel, air', unit: 'percent', effect: 'Also used for NFO', group: 'Surcharges' },
  { key: 'fuelSurface', label: 'Fuel, surface', unit: 'percent', effect: 'On freight + cartage + ODA', group: 'Surcharges' },
  { key: 'fuelRail', label: 'Fuel, rail', unit: 'percent', effect: 'Rail carries none', group: 'Surcharges' },
  { key: 'fuelFtl', label: 'Fuel, FTL', unit: 'percent', effect: 'On the trip price; often nil', group: 'Surcharges' },

  { key: 'pickupAir', label: 'Pickup, air', unit: 'currency', effect: 'Default; per-zone values override', group: 'Cartage & docket' },
  { key: 'deliveryAir', label: 'Delivery, air', unit: 'currency', effect: 'Default; per-zone values override', group: 'Cartage & docket' },
  { key: 'pickupSurface', label: 'Pickup, surface', unit: 'currency', effect: 'Default; per-zone values override', group: 'Cartage & docket' },
  { key: 'deliverySurface', label: 'Delivery, surface', unit: 'currency', effect: 'Default; per-zone values override', group: 'Cartage & docket' },
  { key: 'docket', label: 'Docket / AWB', unit: 'currency', effect: 'Outside the fuel base', group: 'Cartage & docket' },

  { key: 'minWeightAir', label: 'Minimum weight, air', unit: 'number', effect: 'kg; also used for NFO', group: 'Weight rules' },
  { key: 'minWeightSurface', label: 'Minimum weight, surface', unit: 'number', effect: 'kg', group: 'Weight rules' },
  { key: 'minWeightRail', label: 'Minimum weight, rail', unit: 'number', effect: 'kg; nil follows surface', group: 'Weight rules' },
  { key: 'volumetricDivisorAir', label: 'Volumetric divisor, air', unit: 'number', effect: 'L×B×H cm ÷ this', group: 'Weight rules' },
  { key: 'volumetricDivisorSurface', label: 'Volumetric divisor, surface', unit: 'number', effect: 'L×B×H cm ÷ this', group: 'Weight rules' },
  { key: 'volumetricDivisorRail', label: 'Volumetric divisor, rail', unit: 'number', effect: 'nil follows surface', group: 'Weight rules' },
  { key: 'railHeavyPackageThreshold', label: 'Rail heavy-package threshold', unit: 'number', effect: 'kg; a single package at or above doubles', group: 'Weight rules' },
  { key: 'railHeavyPackageMultiplier', label: 'Rail heavy-package multiplier', unit: 'number', effect: '× actual weight', group: 'Weight rules' },
  { key: 'nfoMultiplier', label: 'NFO multiplier', unit: 'number', effect: '× the air card, all four grids', group: 'Weight rules' },
];

export default async function ParamsPage({ params }: { params: Promise<{ card: string }> }) {
  const { card: cardKey } = await params;
  const user = await currentUser();
  if (!user) notFound();
  const card = await findCard(cardKey);
  if (!card) notFound();

  const [draft, live] = await Promise.all([draftVersion(cardKey), liveVersion(cardKey)]);
  const canEdit = can(user.role, 'edit-draft') && canEditDraft(draft.state);

  const fields: ParamField[] = SPEC.map((entry) => ({
    bind: `charges.${entry.key}`,
    label: entry.label,
    unit: entry.unit,
    effect: entry.effect,
    group: entry.group,
    // Nil for a parameter a card predates, e.g. the FTL fuel rate on an older card.
    value: draft.data.charges[entry.key] ?? 0,
    liveValue: live.data.charges[entry.key] ?? 0,
  }));

  return (
    <>
      <h2>Charges &amp; surcharges</h2>
      <p className="lede">
        GST is not here: it is set per mode, with its own SAC and reverse-charge position, on{' '}
        <Link href={`/console/${cardKey}/tax`}>Tax &amp; charges</Link>. The workbook&rsquo;s two
        rates are superseded by that and no longer reach a quote, so they are not offered here
        where changing one would appear to work and would not.{' '}
        These apply to every lane on this card. In the source workbook each of these was stored
        twice — a display copy and an editable one — and they had drifted apart. There is one value
        here, and it is the one that prices.
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
