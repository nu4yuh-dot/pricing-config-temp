import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, db, closeDb, form, expectOk, reasonFrom } from './harness';
import { RedirectError } from './next-stubs';
import { saveLaneEdits, saveParamEdits } from '../console-actions';
import { submitDraftForApproval, decideRequest, discardDraft } from '../actions';
import { liveCard, findCard, liveVersion, draftVersion } from '../../data/rate-cards';
import { findPincodePair } from '../../data/pincodes';
import { quote } from '../../pricing/quote';

/**
 * The base rate card: edit, submit, decide.
 *
 * This is list pricing, so it reaches every customer who has not negotiated the cell — a
 * change escaping review here is the most expensive mistake the application can make. The
 * assertions are therefore about a **quote**, taken at each stage, rather than about the
 * draft document.
 *
 * The card is snapshotted and rolled back, not merely edited back. A run that fails half way
 * used to leave a test rate live, and the next run then reported a mismatch that had nothing
 * to do with the change under test — two confusing failures from one abandoned run.
 */

const CARD = 'model-3';
const LANE = { mode: 'surface' as const, origin: 'PNQ', destination: 'NCR' };
/**
 * A weight light enough that the minimum charge binds.
 *
 * At 200 kg the computed freight on this card exceeds any sensible minimum, so raising
 * `minCharge` changed the draft, passed review, went live — and moved no price at all. The
 * test read as "an approval does not change list pricing", which is alarming and was wrong:
 * the cell simply did not apply to the shipment being priced. Picking a cell that cannot
 * affect the probe is the same mistake as asserting on a superseded field.
 */
const PROBE_WEIGHT = 5;
const TEST_RATE = 617;

type Snapshot = {
  versions: { id: unknown; state: string; data: unknown }[];
  liveVersionId: unknown;
  draftVersionId: unknown;
};

let snapshot: Snapshot | null = null;

async function takeSnapshot(): Promise<void> {
  const d = await db();
  const card = await d.collection('rateCards').findOne({ key: CARD });
  if (!card) throw new Error(`${CARD} is not seeded — run: npm run seed`);
  const rows = await d
    .collection('rateCardVersions')
    .find({ rateCardId: card._id })
    .project({ _id: 1, state: 1, data: 1 })
    .toArray();
  snapshot = {
    versions: rows.map((r) => ({
      id: r._id,
      state: String((r as { state: unknown }).state),
      data: (r as { data: unknown }).data,
    })),
    liveVersionId: (card as { liveVersionId?: unknown }).liveVersionId,
    draftVersionId: (card as { draftVersionId?: unknown }).draftVersionId,
  };
}

async function rollBack(): Promise<void> {
  if (!snapshot) return;
  const d = await db();
  const card = await d.collection('rateCards').findOne({ key: CARD });
  if (!card) return;
  const versions = d.collection('rateCardVersions');

  // Anything the run forked is debris, not history.
  await versions.deleteMany({
    rateCardId: card._id,
    _id: { $nin: snapshot.versions.map((v) => v.id) as never },
  });
  for (const version of snapshot.versions) {
    await versions.updateOne(
      { _id: version.id as never },
      { $set: { state: version.state, data: version.data } },
    );
  }
  await d.collection('rateCards').updateOne(
    { _id: card._id },
    { $set: { liveVersionId: snapshot.liveVersionId, draftVersionId: snapshot.draftVersionId } },
  );
  await d.collection('changeRequests').deleteMany({ rateCardId: String(card._id) });
}

async function priceIt(): Promise<number> {
  const card = await liveCard(CARD);
  if (!card) throw new Error(`${CARD} has no live version`);
  const { origin, destination } = await findPincodePair(411001, 110001);
  if (!origin || !destination) throw new Error('the probe lane is not serviceable');
  const priced = quote(
    { mode: 'surface', actualWeight: PROBE_WEIGHT },
    { origin, destination },
    card,
  );
  if (!priced.available) throw new Error(`did not price: ${priced.reason}`);
  return priced.breakdown.total;
}

/**
 * The card's own id, as a string.
 *
 * A change request stores `rateCardId` — the card document's ObjectId rendered as a string —
 * not the card key. Querying on `cardKey` matched nothing and the failure read as "no
 * pending request", which looks like the submit having failed rather than the query being
 * wrong.
 */
async function cardObjectId(): Promise<string> {
  const card = await (await db()).collection('rateCards').findOne({ key: CARD });
  if (!card) throw new Error(`${CARD} is not seeded`);
  return String(card._id);
}

async function pendingRequestId(): Promise<string> {
  const doc = await (await db())
    .collection('changeRequests')
    .findOne({ rateCardId: await cardObjectId(), status: 'pending' });
  if (!doc) throw new Error('no pending request for this card');
  return (doc as unknown as { _id: { toHexString(): string } })._id.toHexString();
}

async function submit(): Promise<string> {
  try {
    await submitDraftForApproval(CARD);
  } catch (error) {
    if (error instanceof RedirectError) return error.url;
    throw error;
  }
  throw new Error('submitting did not navigate, so it did not submit');
}

async function decide(id: string, fields: Record<string, string>): Promise<void> {
  try {
    await decideRequest(id, form(fields));
  } catch (error) {
    if (error instanceof RedirectError) return;
    throw error;
  }
}

describe('a list price cannot change without a review', () => {
  let listPrice = 0;

  beforeAll(async () => {
    await signInAs('admin', 'admin');
    await takeSnapshot();
    listPrice = await priceIt();
    expect(listPrice).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await rollBack();
    await closeDb();
  });

  test('editing a lane writes to the draft and leaves the live price alone', async () => {
    expectOk(
      await saveLaneEdits(CARD, [{ ...LANE, rate: 'minCharge', value: TEST_RATE }]),
      'saving the lane edit',
    );

    const draft = await draftVersion(CARD);
    expect(draft.state, 'the edit is in a draft').toBe('draft');
    expect(await priceIt(), 'and the live price has not moved').toBe(listPrice);
  });

  test('a viewer cannot edit at all', async () => {
    await signInAs('viewer', 'viewer');
    let refused = false;
    try {
      const outcome = await saveLaneEdits(CARD, [{ ...LANE, rate: 'minCharge', value: 1 }]);
      refused = Boolean(reasonFrom(outcome));
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    await signInAs('admin', 'admin');
  });

  test('submitting freezes the draft and still does not move the price', async () => {
    const url = await submit();
    expect(url).toMatch(/\/approvals\//);

    const frozen = await draftVersion(CARD);
    expect(frozen.state, 'the submitted draft is frozen').toBe('pending');
    expect(await priceIt(), 'quotes are still on the old value').toBe(listPrice);
  });

  test('a frozen draft refuses further edits', async () => {
    const outcome = await saveLaneEdits(CARD, [{ ...LANE, rate: 'minCharge', value: 999 }]);
    expect(
      reasonFrom(outcome),
      'and it says why rather than appearing to save',
    ).not.toBe('');
    expect(await priceIt()).toBe(listPrice);
  });

  test('rejecting leaves the live price exactly where it was', async () => {
    const id = await pendingRequestId();
    await decide(id, { intent: 'reject-all', comment: 'Not this quarter.' });

    expect(await priceIt(), 'a rejection must not move list pricing').toBe(listPrice);
    const live = await liveVersion(CARD);
    expect(live.state).toBe('live');
  });

  test('approving is what moves it, and the version advances', async () => {
    const versionBefore = (await liveVersion(CARD)).version;

    expectOk(
      await saveLaneEdits(CARD, [{ ...LANE, rate: 'minCharge', value: TEST_RATE }]),
      'the second edit',
    );
    await submit();
    await decide(await pendingRequestId(), { intent: 'approve-all' });

    const after = await priceIt();
    expect(after, 'only an approval changes list pricing').not.toBe(listPrice);

    const live = await liveVersion(CARD);
    expect(live.version, 'the live version number advances').toBeGreaterThan(versionBefore);
  });

  test('a fresh draft is forked, matching the new live data', async () => {
    const live = await liveVersion(CARD);
    const draft = await draftVersion(CARD);
    expect(draft.state).toBe('draft');
    expect(JSON.stringify(draft.data)).toBe(JSON.stringify(live.data));
  });

  test('discarding a draft edit reverts it without touching live', async () => {
    const before = await priceIt();
    expectOk(
      await saveLaneEdits(CARD, [{ ...LANE, rate: 'minCharge', value: 123 }]),
      'an edit to discard',
    );
    try {
      await discardDraft(CARD);
    } catch (error) {
      if (!(error instanceof RedirectError)) throw error;
    }
    expect(await priceIt(), 'live pricing is untouched throughout').toBe(before);
  });

  test('a param edit follows the same route', async () => {
    const before = await priceIt();
    expectOk(
      await saveParamEdits(CARD, [{ bind: 'charges.fuelSurface', value: 0.5 }]),
      'saving a param edit',
    );
    expect(await priceIt(), 'a param edit is a draft edit like any other').toBe(before);
  });

  test('the card is left as it was found', async () => {
    await rollBack();
    expect(await priceIt(), 'the rollback restores the starting price').toBe(listPrice);

    const card = await findCard(CARD);
    expect(card).not.toBeNull();
    const count = await (await db())
      .collection('rateCardVersions')
      .countDocuments({ rateCardId: (card as unknown as { _id: unknown })._id as never });
    expect(count, 'and leaves no extra version documents').toBe(snapshot?.versions.length);
  });
});
