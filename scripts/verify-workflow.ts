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

async function main(): Promise<void> {
  console.log(describeTarget(await assertOwnDatabase('run workflow verification')));

  const card = await findCard(CARD);
  if (!card) throw new Error(`${CARD} is not seeded. Run: npx tsx scripts/seed.ts`);

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

  // --- the submitter may not approve their own work --------------------------
  let selfApprovalRefused = false;
  try {
    await reviewRequest(request._id.toHexString(), 'approve-all', editor);
  } catch {
    selfApprovalRefused = true;
  }
  check('the submitter cannot approve their own request', selfApprovalRefused);

  // --- approve --------------------------------------------------------------
  const reviewed = await reviewRequest(request._id.toHexString(), 'approve-all', admin);
  check('the request is marked approved', reviewed.status === 'approved');

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
  await database.collection(COLLECTIONS.rateCardVersions).updateMany(
    { rateCardId: card._id },
    { $set: { state: 'archived' } },
  );
  await database
    .collection(COLLECTIONS.rateCardVersions)
    .updateOne({ _id: originalLive._id }, { $set: { state: 'live' } });
  const restoredDraft = new ObjectId();
  await database.collection(COLLECTIONS.rateCardVersions).insertOne({
    _id: restoredDraft,
    rateCardId: card._id,
    version: 9000,
    state: 'draft',
    data: originalLive.data,
    createdBy: admin,
    createdAt: new Date(),
  });
  await database
    .collection(COLLECTIONS.rateCards)
    .updateOne(
      { _id: card._id },
      { $set: { liveVersionId: originalLive._id, draftVersionId: restoredDraft } },
    );
  await database
    .collection(COLLECTIONS.changeRequests)
    .deleteMany({ _id: { $in: [request._id, second._id] } });

  const restoredTotal = await priceIt();
  check('the card was restored to its starting state', restoredTotal === startingTotal);

  console.log(`\n${failures === 0 ? 'workflow verified end to end' : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('verification failed:', error);
  process.exit(1);
});
