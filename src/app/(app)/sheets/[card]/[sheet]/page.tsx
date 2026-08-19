import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import {
  listCards,
  draftVersion,
  liveVersion,
  findCard,
  requestById,
} from '../../../../../data/rate-cards';
import { specsFor, sheetSpecsForSource } from '../../../../../sheets/specs';
import { renderSheet, getByPath } from '../../../../../sheets/resolve';
import { diffCardData } from '../../../../../changes/diff';
import { validateCard } from '../../../../../changes/validate';
import SheetEditor from '../../../../../components/SheetEditor';
import DraftBar from '../../../../../components/console/DraftBar';
import { consoleHomeFor } from '../../../../../console/card-home';
import DerivedSheet from '../../../../../components/DerivedSheet';
import { canEditDraft } from '../../../../../data/workflow';

export default async function SheetPage({
  params,
}: {
  params: Promise<{ card: string; sheet: string }>;
}) {
  const { card: cardKey, sheet: sheetId } = await params;
  const user = await currentUser();
  if (!user) notFound();

  const card = await findCard(cardKey);
  if (!card) notFound();

  const source = card.source ?? 'dns';
  const draft = await draftVersion(cardKey);
  const live = await liveVersion(cardKey);

  // The UPS tabs are built from the card, so the tab list is only knowable once the draft
  // is loaded. Everything else is static and unaffected.
  const tabs = sheetSpecsForSource(source, draft.data);
  const spec = specsFor(draft.data).find((entry) => entry.id === sheetId);

  // A tab belongs to one source. Asking for the Bluedart rates on a DNS card is not a
  // blank sheet, it is a wrong address — and editing it there would write franchise rates
  // onto a card that does not price them.
  if (!spec || (spec.source ?? 'dns') !== source) notFound();

  const frozen = !canEditDraft(draft.state);
  const editable = can(user.role, 'edit-draft') && !frozen;

  // Everything outstanding against live, so unsaved and pending cells can be marked.
  const outstanding = diffCardData(live.data, draft.data);
  const pendingBinds = frozen ? outstanding.map((change) => change.bind) : [];

  const pendingRequest = draft.changeRequestId
    ? await requestById(draft.changeRequestId.toHexString())
    : null;
  const rejectedBinds = Object.fromEntries(
    (pendingRequest?.changes ?? [])
      .filter((change) => change.decision === 'rejected' && change.comment)
      .map((change) => [change.bind, change.comment as string]),
  );

  const flaggedBinds = Object.fromEntries(
    validateCard(draft.data, card.freightMethod)
      .filter((finding) => finding.bind && finding.sheet === spec.name)
      .map((finding) => [finding.bind as string, finding.message]),
  );

  const rendered = renderSheet(spec, draft.data);
  const cells = [...rendered.cells.values()];
  const liveValues = Object.fromEntries(
    cells
      .filter((cell) => cell.bind)
      .map((cell) => [cell.bind as string, (getByPath(live.data, cell.bind as string) ?? null) as string | number | null]),
  );

  return (
    <>
      <DraftBar
        cardKey={cardKey}
        cardName={card.name}
        outstandingCount={outstanding.length}
        frozen={frozen}
        sheetView
        toggleHref={consoleHomeFor(source, cardKey)}
        {...(frozen && draft.changeRequestId
          ? { pendingRequestId: draft.changeRequestId.toHexString() }
          : {})}
      />

      {spec.derived || spec.id === 'pincode-master' || spec.id === 'cover' ? (
        <DerivedSheet
          spec={spec}
          cells={cells}
          cardKey={cardKey}
          cardName={card.name}
        />
      ) : (
        <SheetEditor
          cardKey={cardKey}
          cells={cells}
          columns={rendered.columns}
          rows={rendered.rows}
          liveValues={liveValues}
          pendingBinds={pendingBinds}
          rejectedBinds={rejectedBinds}
          flaggedBinds={flaggedBinds}
          canEdit={editable}
          lockReason={
            frozen
              ? 'This draft is awaiting approval — editing is locked until it is reviewed.'
              : can(user.role, 'edit-draft')
                ? undefined
                : `Your role (${user.role}) is read-only.`
          }
          outstandingCount={outstanding.length}
          frozen={frozen}
          canSubmit={can(user.role, 'submit-for-approval') && !frozen}
          pendingRequestId={frozen ? draft.changeRequestId?.toHexString() : undefined}
        />
      )}

      <nav className="tabstrip">
        {tabs.map((entry) => (
          <Link
            key={entry.id}
            href={`/sheets/${cardKey}/${entry.id}`}
            aria-current={entry.id === sheetId ? 'page' : undefined}
          >
            {entry.name}
            {entry.derived && <span className="derived-mark">fx</span>}
          </Link>
        ))}
      </nav>
    </>
  );
}
