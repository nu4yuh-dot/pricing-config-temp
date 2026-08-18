import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { draftVersion, liveVersion, findCard } from '../../../../../data/rate-cards';
import { laneRecord, previewParams, lanesForMode } from '../../../../../console/lanes';
import { canEditDraft } from '../../../../../data/workflow';
import LaneEditor from '../../../../../components/console/LaneEditor';
import LaneTable from '../../../../../components/console/LaneTable';
import { saveLaneEdits } from '../../../../../app/console-actions';
import type { StoredMode } from '../../../../../domain/types';

export default async function RatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ card: string }>;
  searchParams: Promise<{ browse?: string }>;
}) {
  const { card: cardKey } = await params;
  const { browse } = await searchParams;
  const user = await currentUser();
  if (!user) notFound();

  const card = await findCard(cardKey);
  if (!card) notFound();

  const [draft, live] = await Promise.all([draftVersion(cardKey), liveVersion(cardKey)]);
  const frozen = !canEditDraft(draft.state);
  const canEdit = can(user.role, 'edit-draft') && !frozen;

  const browseMode = (['air', 'surface', 'rail'] as const).includes(browse as StoredMode)
    ? (browse as StoredMode)
    : 'surface';

  const lanes = laneRecord(draft.data);
  const baseline = laneRecord(live.data);
  const summaries = lanesForMode(draft.data, live.data, browseMode);

  return (
    <>
      <h2>Lane rates</h2>
      <p className="lede">
        Pick a lane and edit four labelled fields. The quote beside them updates as you type, so you
        can see what a change actually does before anyone approves it.
      </p>

      <LaneEditor
        lanes={lanes}
        baseline={baseline}
        freightMethod={card.freightMethod}
        minWeightAir={draft.data.charges.minWeightAir}
        minWeightSurface={draft.data.charges.minWeightSurface}
        preview={previewParams(draft.data)}
        canEdit={canEdit}
        baselineLabel="live"
        onSave={async (edits) => {
          'use server';
          await saveLaneEdits(cardKey, edits);
        }}
      />

      <h3>Browse every lane</h3>
      <LaneTable
        cardKey={cardKey}
        mode={browseMode}
        lanes={summaries}
        canEdit={canEdit}
        onSave={async (edits) => {
          'use server';
          await saveLaneEdits(cardKey, edits);
        }}
      />
    </>
  );
}
