/**
 * Exercise the whole approval workflow against a real database.
 *
 * The unit tests prove the state machine in isolation; this proves the repositories
 * wire it up correctly and that an approved rate actually changes what a quote
 * returns. Run against a seeded database:
 *
 *   npx tsx scripts/verify-workflow.ts
 *
 * It cleans up after itself, leaving the cards as it found them.
 */

import { ObjectId } from 'mongodb';
import { db, COLLECTIONS } from '../src/data/mongo';
import { assertOwnDatabase, describeTarget } from '../src/data/guard';
import {
  editDraftCell,
  submitForApproval,
  reviewRequest,
  liveCard,
  draftVersion,
  liveVersion,
  findCard,
  pendingRequests,
  versionHistory,
} from '../src/data/rate-cards';
import { findPincodePair } from '../src/data/pincodes';
import { quote } from '../src/pricing/quote';

const CARD = 'model-1';
const BIND = 'grids.surface.minCharge.PNQ.NCR';
const NEW_VALUE = 560;
/** What the seeded card holds, and what every run must leave behind. */
const ORIGINAL_VALUE = 530;

const editor = { id: '000000000000000000000011', email: 'editor@test', name: 'Test Editor' };
const admin = { id: '000000000000000000000012', email: 'admin@test', name: 'Test Admin' };

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function priceIt(): Promise<number | null> {
  const card = await liveCard(CARD);
  if (!card) return null;
  const { origin, destination } = await findPincodePair(411001, 110001);
  const result = quote({ mode: 'surface', actualWeight: 200 }, { origin, destination }, card);
  return result.available ? result.breakdown.total : null;
}

/**
 * Put the card back exactly as it was found, however this exits.
 *
 * This script approves a change, which promotes a value to **live pricing**, and every
 * submit/approve forks new version documents. An earlier version of this restore archived
 * every version and inserted a fresh draft numbered 9000 instead of deleting what the run
 * created — so each run left permanent debris behind. After a few runs the card carried
 * duplicate version numbers and twenty-odd rows, the ten-row history window filled with
 * them, and the live row was pushed out of sight: run 1 passed, run 2 failed on assertions
 * about state that was actually correct. A verification script that cannot be run twice
 * gets run zero times.
 *
 * So the run takes a snapshot first and rolls back to it: versions it created are deleted,
 * versions that already existed keep the state they had, and the card's own live/draft
 * pointers go back to the documents they named.
 */
type Snapshot = {
  cardId: ObjectId;
  versions: { id: ObjectId; state: string }[];
  liveVersionId: unknown;
  draftVersionId: unknown;
};

let snapshot: Snapshot | null = null;

async function takeSnapshot(): Promise<void> {
  const d = await db();
  const card = await d.collection(COLLECTIONS.rateCards).findOne({ key: CARD });
  if (!card) return;
  const rows = await d
    .collection(COLLECTIONS.rateCardVersions)
    .find({ rateCardId: card._id })
    .project({ _id: 1, state: 1 })
    .toArray();
  snapshot = {
    cardId: card._id,
    versions: rows.map((r) => ({ id: r._id, state: String((r as { state: unknown }).state) })),
    liveVersionId: (card as { liveVersionId?: unknown }).liveVersionId,
    draftVersionId: (card as { draftVersionId?: unknown }).draftVersionId,
  };
}

/** Idempotent: safe to call from the assertion body and again from `finally`. */
async function restore(original: number): Promise<void> {
  if (!snapshot) return;
  const { setByPath } = await import('../src/sheets/resolve');
  const d = await db();
  const versions = d.collection(COLLECTIONS.rateCardVersions);
  const keep = snapshot.versions.map((v) => v.id);

  // Anything this run forked is debris, not history. Delete it.
  await versions.deleteMany({ rateCardId: snapshot.cardId, _id: { $nin: keep } });

  // Pre-existing rows get their original state back, and the test value undone.
  for (const v of snapshot.versions) {
    const row = await versions.findOne({ _id: v.id }, { projection: { data: 1 } });
    if (!row) continue;
    await versions.updateOne(
      { _id: v.id },
      { $set: { state: v.state, data: setByPath((row as unknown as { data: unknown }).data, BIND, original) } },
    );
  }

  await d.collection(COLLECTIONS.rateCards).updateOne(
    { _id: snapshot.cardId },
    { $set: { liveVersionId: snapshot.liveVersionId, draftVersionId: snapshot.draftVersionId } },
  );
}

async function main(): Promise<void> {
  console.log(describeTarget(await assertOwnDatabase('run workflow verification')));

  const card = await findCard(CARD);
  if (!card) throw new Error(`${CARD} is not seeded. Run: npx tsx scripts/seed.ts`);

  await takeSnapshot();
  const originalLive = await liveVersion(CARD);
  const originalValue = 530;
  const startingTotal = await priceIt();

  console.log(`starting state: ${BIND} = ${originalValue}, quote total = ${startingTotal}\n`);
  check('a seeded card prices the golden shipment at 5197.5', startingTotal === 5197.5, String(startingTotal));

  // --- edit the draft -------------------------------------------------------
  await editDraftCell(CARD, BIND, NEW_VALUE, editor);
  const afterEdit = await draftVersion(CARD);
  check(
    'editing writes into the draft',
    (afterEdit.data.grids.surface.minCharge.PNQ?.NCR ?? null) === NEW_VALUE,
  );
  check('editing does not touch live pricing', (await priceIt()) === startingTotal);

  // --- submit ---------------------------------------------------------------
  const request = await submitForApproval(CARD, editor);
  check('submitting produces a one-line change request', request.changes.length === 1);
  check('the change is located and labelled', request.changes[0]?.cellRef === 'J5');
  check(
    'the label reads for a human',
    request.changes[0]?.label === 'Surface Rates · min charge · PNQ→NCR',
    request.changes[0]?.label,
  );
  check('the request appears in the pending queue', (await pendingRequests()).length >= 1);

  const frozen = await draftVersion(CARD);
  check('the submitted draft is frozen', frozen.state === 'pending');
  let editRefused = false;
  try {
    await editDraftCell(CARD, BIND, 999, editor);
  } catch {
    editRefused = true;
  }
  check('a frozen draft refuses further edits', editRefused);
  check('quotes are still on the old value while pending', (await priceIt()) === startingTotal);

  // --- approve, by somebody else -------------------------------------------
  /**
   * Self-approval is permitted and recorded, not blocked.
   *
   * This script used to assert a refusal, which is what the system did before a
   * single-admin setup deadlocked on it: `admin` is the only role that may review, so
   * forbidding self-approval left nobody able to approve anything. The rule became
   * "allowed, and visible" instead — so what is worth proving here is that the flag is
   * set when it happens and clear when it does not.
   */
  const reviewed = await reviewRequest(request._id.toHexString(), 'approve-all', admin);
  check('the request is marked approved', reviewed.status === 'approved');
  check('an approval by somebody else is not marked self-approved', reviewed.selfApproved !== true);

  const newLive = await liveVersion(CARD);
  check(
    'the approved value is now live',
    (newLive.data.grids.surface.minCharge.PNQ?.NCR ?? null) === NEW_VALUE,
  );
  check('the live version number advanced', newLive.version > originalLive.version);

  const history = await versionHistory(CARD, 10);
  check(
    'the previous live version is archived, not deleted',
    history.some((v) => v._id.equals(originalLive._id) && v.state === 'archived'),
  );
  check('exactly one version is live', history.filter((v) => v.state === 'live').length === 1);
  check('exactly one version is a draft', history.filter((v) => v.state === 'draft').length === 1);

  const freshDraft = await draftVersion(CARD);
  check('a fresh draft was forked and is editable', freshDraft.state === 'draft');
  check(
    'the fresh draft matches the new live data',
    JSON.stringify(freshDraft.data) === JSON.stringify(newLive.data),
  );

  // --- the quote actually moved ---------------------------------------------
  const newTotal = await priceIt();
  // minCharge 530 -> 560 adds 30 to freight, which fuel (25%) and GST (5%) compound.
  const expected = 5197.5 + 30 * 1.25 * 1.05;
  check(
    'the approved rate changes what a quote returns',
    newTotal !== null && Math.abs(newTotal - expected) < 0.05,
    `got ${newTotal}, expected about ${expected.toFixed(2)}`,
  );

  // --- reject path ----------------------------------------------------------
  await editDraftCell(CARD, BIND, 999, editor);
  const second = await submitForApproval(CARD, editor);
  const rejected = await reviewRequest(
    second._id.toHexString(),
    'reject-all',
    admin,
    'Not this quarter.',
  );
  check('a rejected request is marked rejected', rejected.status === 'rejected');
  check('rejecting leaves live pricing alone', (await priceIt()) === newTotal);

  const reopened = await draftVersion(CARD);
  check('rejecting reopens the draft', reopened.state === 'draft');
  check(
    'the rejected proposal is kept in the draft to revise',
    (reopened.data.grids.surface.minCharge.PNQ?.NCR ?? null) === 999,
  );

  // --- restore --------------------------------------------------------------
  const database = await db();
  await database
    .collection(COLLECTIONS.changeRequests)
    .deleteMany({ _id: { $in: [request._id, second._id] } });
  await restore(ORIGINAL_VALUE);

  const restoredTotal = await priceIt();
  check('the card was restored to its starting state', restoredTotal === startingTotal);

  /**
   * Re-runnability, asserted. The count going back to what it was is the difference
   * between a script that can run twice and one that quietly poisons the next run.
   */
  const leftBehind = await database
    .collection(COLLECTIONS.rateCardVersions)
    .countDocuments({ rateCardId: card._id });
  check(
    'the run leaves no extra version documents behind',
    leftBehind === (snapshot?.versions.length ?? -1),
    `${leftBehind} versions now, ${snapshot?.versions.length} before the run`,
  );
  const liveNow = await database
    .collection(COLLECTIONS.rateCardVersions)
    .countDocuments({ rateCardId: card._id, state: 'live' });
  check('exactly one version is live after restore', liveNow === 1, `${liveNow} live`);

  console.log(`\n${failures === 0 ? 'workflow verified end to end' : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * `finally`, not `catch`.
 *
 * The value has to go back whether the run passed, failed an assertion, or threw — an
 * abandoned run that leaves a test rate live is worse than a failed test, because the next
 * run then fails for a different and more confusing reason.
 */
main()
  .catch((error) => {
    console.error('verification failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await restore(ORIGINAL_VALUE);
    console.log(`\nrestored ${BIND} to ${ORIGINAL_VALUE}`);
    process.exit(process.exitCode ?? 0);
  });
