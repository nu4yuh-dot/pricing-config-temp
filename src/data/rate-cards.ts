import { cache } from 'react';
import { ObjectId, type Collection } from 'mongodb';
import { db, COLLECTIONS } from './mongo';
import type { CardSource, FreightMethod, RateCard, RateCardData } from '../domain/types';
import { upsertRule, removeRule, type StoredLaneRule } from '../domain/lane-rule-store';
import {
  applyReview,
  submitDraft,
  canEditDraft,
  type Actor,
  type ChangeRequest,
  type ReviewDecisions,
  type VersionState,
} from './workflow';
import { setByPath } from '../sheets/resolve';
import type { BindPath } from '../sheets/types';
import { recordAudit } from './audit';

export interface RateCardDoc {
  _id: ObjectId;
  key: string;
  name: string;
  freightMethod: FreightMethod;
  /** Absent on cards seeded before Bluedart existed, which are all DNS. */
  source?: CardSource;
  /** @deprecated What `source` was called before; read for compatibility only. */
  product?: CardSource;
  liveVersionId: ObjectId;
  draftVersionId: ObjectId;
}

export interface RateCardVersionDoc {
  _id: ObjectId;
  rateCardId: ObjectId;
  version: number;
  state: VersionState;
  data: RateCardData;
  createdBy: Actor;
  createdAt: Date;
  approvedBy?: Actor;
  approvedAt?: Date;
  changeRequestId?: ObjectId;
}

export interface ChangeRequestDoc extends ChangeRequest {
  _id: ObjectId;
  rateCardId: string;
  versionId: ObjectId;
}

async function cards(): Promise<Collection<RateCardDoc>> {
  return (await db()).collection<RateCardDoc>(COLLECTIONS.rateCards);
}

async function versions(): Promise<Collection<RateCardVersionDoc>> {
  return (await db()).collection<RateCardVersionDoc>(COLLECTIONS.rateCardVersions);
}

async function requests(): Promise<Collection<ChangeRequestDoc>> {
  return (await db()).collection<ChangeRequestDoc>(COLLECTIONS.changeRequests);
}

/**
 * Fill `source` from the legacy `product` field.
 *
 * The rename happens on read rather than by migrating the collection: rows written by an
 * earlier version are still perfectly good, and a live migration to change a field name
 * is risk with nothing on the other side of it. Every card leaves this module carrying
 * `source`, so nothing downstream has to know the old name existed.
 */
function withSource(card: RateCardDoc): RateCardDoc {
  return card.source ? card : { ...card, source: card.product ?? 'dns' };
}

export async function listCards(): Promise<RateCardDoc[]> {
  return ((await cards()).find().sort({ key: 1 }).toArray()).then((rows) => rows.map(withSource));
}

/**
 * Memoised for the length of one request.
 *
 * A console page fetches the same card document up to five times: once in the layout,
 * once in the page, and once inside each of `draftVersion` and `liveVersion` on both.
 * That was four wasted round trips, and with the service and the database in different
 * regions a round trip is the whole cost of the page.
 *
 * Safe because nothing that writes the card document reads it back through here —
 * `reviewRequest`, the only writer, looks the card up by `_id` directly. Edits write
 * versions, not cards.
 */
export const findCard = cache(async (key: string): Promise<RateCardDoc | null> => {
  const card = await (await cards()).findOne({ key });
  return card === null ? null : withSource(card);
});

async function versionById(id: ObjectId): Promise<RateCardVersionDoc> {
  const version = await (await versions()).findOne({ _id: id });
  if (!version) throw new Error(`rate card version ${id.toHexString()} not found`);
  return version;
}

/**
 * The card as the pricing engine wants it: identity, method, and one version's data.
 * Quotes always read the live version, so pending edits can never leak into a
 * customer-facing number.
 */
export async function liveCard(key: string): Promise<RateCard | null> {
  const card = await findCard(key);
  if (!card) return null;
  const version = await versionById(card.liveVersionId);
  return {
    key: card.key,
    name: card.name,
    freightMethod: card.freightMethod,
    source: card.source ?? 'dns',
    version: version.version,
    data: version.data,
  };
}

export async function allLiveCards(): Promise<RateCard[]> {
  const list = await listCards();
  const resolved = await Promise.all(list.map((card) => liveCard(card.key)));
  return resolved.filter((card): card is RateCard => card !== null);
}

/**
 * The live cards from one source.
 *
 * The calculator prices the DNS cards side by side because they are one network under
 * three freight methods. Bluedart is not comparable with them — different zones, different
 * services — so it must not be swept into that comparison.
 */
export async function liveCardsFromSource(source: CardSource): Promise<RateCard[]> {
  const cards = await allLiveCards();
  return cards.filter((card) => (card.source ?? 'dns') === source);
}

export async function draftVersion(key: string): Promise<RateCardVersionDoc> {
  const card = await findCard(key);
  if (!card) throw new Error(`rate card ${key} not found`);
  return versionById(card.draftVersionId);
}

export async function liveVersion(key: string): Promise<RateCardVersionDoc> {
  const card = await findCard(key);
  if (!card) throw new Error(`rate card ${key} not found`);
  return versionById(card.liveVersionId);
}

/**
 * Write one cell into the draft.
 *
 * Refuses while the draft is under review, so that the diff an admin is looking at
 * cannot drift out from under them.
 */
export async function editDraftCell(
  key: string,
  bind: BindPath,
  value: string | number | null,
  actor: Actor,
): Promise<RateCardVersionDoc> {
  const draft = await draftVersion(key);
  if (!canEditDraft(draft.state)) {
    throw new Error(
      'This draft is awaiting approval and cannot be edited. ' +
        'Ask an admin to review it, or have the request rejected to reopen it.',
    );
  }

  const data = setByPath(draft.data, bind, value);
  await (await versions()).updateOne(
    { _id: draft._id, state: 'draft' },
    { $set: { data, lastEditedBy: actor, lastEditedAt: new Date() } },
  );
  return { ...draft, data };
}

/** Write several cells at once, for paste and fill-down. */
export async function editDraftCells(
  key: string,
  edits: { bind: BindPath; value: string | number | null }[],
  actor: Actor,
): Promise<RateCardVersionDoc> {
  const draft = await draftVersion(key);
  if (!canEditDraft(draft.state)) {
    throw new Error('This draft is awaiting approval and cannot be edited.');
  }

  const data = edits.reduce(
    (acc, edit) => setByPath(acc, edit.bind, edit.value),
    draft.data,
  );
  await (await versions()).updateOne(
    { _id: draft._id, state: 'draft' },
    { $set: { data, lastEditedBy: actor, lastEditedAt: new Date() } },
  );
  return { ...draft, data };
}

/**
 * Add or replace a lane rule on the draft.
 *
 * Separate from `editDraftCells` because adding a rule is structural, not a cell edit —
 * there is no existing path to set. Once a rule exists, each of its four rates *is* a
 * cell at `laneRules.<id>.rates.<tier>`, so editing one goes back through `editDraftCells`
 * and reaches the approval diff the same way every other value does.
 *
 * Same freeze guard as a cell edit: a draft awaiting approval cannot gain a rule either.
 */
export async function saveDraftRule(
  key: string,
  rule: StoredLaneRule,
  actor: Actor,
): Promise<RateCardVersionDoc> {
  return writeDraftData(key, (data) => upsertRule(data, { ...rule, updatedAt: Date.now() }), actor);
}

export async function deleteDraftRule(
  key: string,
  id: string,
  actor: Actor,
): Promise<RateCardVersionDoc> {
  return writeDraftData(key, (data) => removeRule(data, id), actor);
}

async function writeDraftData(
  key: string,
  change: (data: RateCardData) => RateCardData,
  actor: Actor,
): Promise<RateCardVersionDoc> {
  const draft = await draftVersion(key);
  if (!canEditDraft(draft.state)) {
    throw new Error('This draft is awaiting approval and cannot be edited.');
  }

  const data = change(draft.data);
  await (await versions()).updateOne(
    { _id: draft._id, state: 'draft' },
    { $set: { data, lastEditedBy: actor, lastEditedAt: new Date() } },
  );
  return { ...draft, data };
}

/** Discard every unsubmitted edit, returning the draft to the live values. */
export async function resetDraft(key: string, actor: Actor): Promise<void> {
  const card = await findCard(key);
  if (!card) throw new Error(`rate card ${key} not found`);
  const live = await versionById(card.liveVersionId);
  const draft = await versionById(card.draftVersionId);
  if (!canEditDraft(draft.state)) {
    throw new Error('This draft is awaiting approval and cannot be reset.');
  }

  await (await versions()).updateOne({ _id: draft._id }, { $set: { data: live.data } });
  await recordAudit({ action: 'draft-reset', rateCardKey: key, actor, at: new Date() });
}

export async function submitForApproval(key: string, actor: Actor): Promise<ChangeRequestDoc> {
  const card = await findCard(key);
  if (!card) throw new Error(`rate card ${key} not found`);
  const live = await versionById(card.liveVersionId);
  const draft = await versionById(card.draftVersionId);
  if (!canEditDraft(draft.state)) {
    throw new Error('This draft has already been submitted for approval.');
  }

  const submitted = submitDraft({
    rateCardId: card._id.toHexString(),
    liveData: live.data,
    draftData: draft.data,
    submittedBy: actor,
    submittedAt: new Date(),
  });

  const doc: ChangeRequestDoc = {
    ...submitted.changeRequest,
    _id: new ObjectId(),
    versionId: draft._id,
  };
  await (await requests()).insertOne(doc);
  await (await versions()).updateOne(
    { _id: draft._id },
    { $set: { state: 'pending', changeRequestId: doc._id } },
  );
  await recordAudit({
    action: 'submitted',
    rateCardKey: key,
    actor,
    at: doc.submittedAt,
    detail: { changeCount: doc.changes.length, changeRequestId: doc._id.toHexString() },
  });

  return doc;
}

export async function pendingRequests(): Promise<ChangeRequestDoc[]> {
  return (await requests()).find({ status: 'pending' }).sort({ submittedAt: 1 }).toArray();
}

export async function requestById(id: string): Promise<ChangeRequestDoc | null> {
  return (await requests()).findOne({ _id: new ObjectId(id) });
}

export async function requestHistory(limit = 50): Promise<ChangeRequestDoc[]> {
  return (await requests())
    .find({ status: { $ne: 'pending' } })
    .sort({ reviewedAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Review a pending request.
 *
 * Promotes approved values to a new live version, archives the previous one, and
 * forks a fresh draft carrying any rejected proposals so the team can revise them.
 */
export async function reviewRequest(
  requestId: string,
  decisions: ReviewDecisions,
  actor: Actor,
  comment?: string,
): Promise<ChangeRequestDoc> {
  const request = await requestById(requestId);
  if (!request) throw new Error(`change request ${requestId} not found`);

  const card = await (await cards()).findOne({ _id: new ObjectId(request.rateCardId) });
  if (!card) throw new Error(`rate card ${request.rateCardId} not found`);
  const live = await versionById(card.liveVersionId);

  const result = applyReview({
    changeRequest: request,
    liveData: live.data,
    decisions,
    reviewedBy: actor,
    reviewedAt: new Date(),
    ...(comment === undefined ? {} : { comment }),
  });

  const versionCollection = await versions();
  const nextVersion = live.version + 1;
  const approvedSomething = result.audit.approvedCount > 0;

  let liveVersionId = card.liveVersionId;
  if (approvedSomething) {
    const newLive: RateCardVersionDoc = {
      _id: new ObjectId(),
      rateCardId: card._id,
      version: nextVersion,
      state: 'live',
      data: result.newLiveData,
      createdBy: request.submittedBy,
      createdAt: request.submittedAt,
      approvedBy: actor,
      approvedAt: result.audit.reviewedAt,
      changeRequestId: request._id,
    };
    await versionCollection.insertOne(newLive);
    await versionCollection.updateOne({ _id: live._id }, { $set: { state: 'archived' } });
    liveVersionId = newLive._id;
  }

  // The submitted version is superseded either way: its content is now either live
  // or back in a fresh draft.
  const freshDraft: RateCardVersionDoc = {
    _id: new ObjectId(),
    rateCardId: card._id,
    version: nextVersion + (approvedSomething ? 1 : 0),
    state: 'draft',
    data: result.newDraftData,
    createdBy: actor,
    createdAt: result.audit.reviewedAt,
  };
  await versionCollection.insertOne(freshDraft);
  await versionCollection.updateOne(
    { _id: request.versionId },
    { $set: { state: 'archived' } },
  );

  await (await cards()).updateOne(
    { _id: card._id },
    { $set: { liveVersionId, draftVersionId: freshDraft._id } },
  );

  const updated: ChangeRequestDoc = { ...request, ...result.changeRequest };
  await (await requests()).updateOne(
    { _id: request._id },
    {
      $set: {
        status: updated.status,
        changes: updated.changes,
        reviewedBy: actor,
        reviewedAt: result.audit.reviewedAt,
        selfApproved: result.audit.selfApproved,
        ...(comment === undefined ? {} : { reviewComment: comment }),
      },
    },
  );

  await recordAudit({
    action: result.audit.action,
    rateCardKey: card.key,
    actor,
    at: result.audit.reviewedAt,
    detail: {
      changeRequestId: request._id.toHexString(),
      approvedCount: result.audit.approvedCount,
      rejectedCount: result.audit.rejectedCount,
      newLiveVersion: approvedSomething ? nextVersion : live.version,
      selfApproved: result.audit.selfApproved,
    },
  });

  return updated;
}

/** Every version of a card, newest first — the answer to "what did we quote then?". */
export async function versionHistory(key: string, limit = 50): Promise<RateCardVersionDoc[]> {
  const card = await findCard(key);
  if (!card) return [];
  return (await versions())
    .find({ rateCardId: card._id })
    .sort({ version: -1 })
    .limit(limit)
    .toArray();
}
