import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { draftVersion, liveVersion, findCard } from '../../../../../data/rate-cards';
import { canEditDraft } from '../../../../../data/workflow';
import FtlRatesEditor from '../../../../../components/console/FtlRatesEditor';
import { saveParamEdits } from '../../../../../app/console-actions';
import { VEHICLE_TYPES } from '../../../../../pricing/ftl';
import { SURFACE_ZONES } from '../../../../../domain/zones';
import { taxProfileFor } from '../../../../../domain/tax';
import { taxOverridesFrom } from '../../../../../pricing/card-config';
import type { RateCardData } from '../../../../../domain/types';

/**
 * The console view of FTL rates.
 *
 * The FTL Rates tab shows nine 21 × 21 matrices, which is right for someone reading a rate
 * sheet. This asks the other question: what does this truck cost on this lane.
 */

/** Flatten the stored `vehicle → origin → destination` shape to a lookup by lane key. */
function flatten(data: RateCardData): Record<string, number | null> {
  const flat: Record<string, number | null> = {};
  const rates = data.ftl?.rates ?? {};
  for (const vehicle of VEHICLE_TYPES) {
    for (const origin of SURFACE_ZONES) {
      for (const destination of SURFACE_ZONES) {
        flat[`${vehicle.code}:${origin}>${destination}`] =
          rates[vehicle.code]?.[origin]?.[destination] ?? null;
      }
    }
  }
  return flat;
}

export default async function FtlPage({ params }: { params: Promise<{ card: string }> }) {
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

  const tax = taxProfileFor('ftl', taxOverridesFrom('ftl', draft.data, 0.12));

  return (
    <>
      <h2>FTL rates</h2>
      <p className="lede">
        A truck is hired whole, so there is one price per vehicle per lane — no weight tiers, no
        minimum charge, no chargeable weight. An empty price means that truck is not offered on that
        lane, which is different from it being free.
      </p>

      <FtlRatesEditor
        vehicles={VEHICLE_TYPES}
        rates={flatten(draft.data)}
        baseline={flatten(live.data)}
        canEdit={canEdit}
        fuelFtl={draft.data.charges.fuelFtl ?? 0}
        gstFtl={tax.rcm ? 0 : tax.gstRate}
        onSave={async (edits) => {
          'use server';
          await saveParamEdits(
            cardKey,
            edits.map((edit) => ({
              bind: `ftl.rates.${edit.vehicle}.${edit.origin}.${edit.destination}`,
              value: edit.value,
            })),
          );
        }}
      />
    </>
  );
}
