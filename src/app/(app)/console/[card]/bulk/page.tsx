import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { draftVersion, findCard } from '../../../../../data/rate-cards';
import { laneRecord } from '../../../../../console/lanes';
import { canEditDraft } from '../../../../../data/workflow';
import BulkEditor from '../../../../../components/console/BulkEditor';
import { saveLaneEdits } from '../../../../../app/console-actions';

export default async function BulkPage({ params }: { params: Promise<{ card: string }> }) {
  const { card: cardKey } = await params;
  const user = await currentUser();
  if (!user) notFound();
  const card = await findCard(cardKey);
  if (!card) notFound();

  const draft = await draftVersion(cardKey);
  const canEdit = can(user.role, 'edit-draft') && canEditDraft(draft.state);

  return (
    <>
      <h2>Bulk changes</h2>
      <p className="lede">
        A fuel-driven increase or an across-the-board correction is one operation here, not hundreds
        of edits. Unserved lanes are always skipped — opening a lane is a deliberate decision, never
        a side effect.
      </p>

      <BulkEditor
        cardKey={cardKey}
        lanes={laneRecord(draft.data)}
        canEdit={canEdit}
        onApply={async (edits) => {
          'use server';
          await saveLaneEdits(cardKey, edits);
        }}
      />
    </>
  );
}
