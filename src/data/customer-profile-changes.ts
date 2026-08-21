import { ObjectId, type Collection } from 'mongodb';
import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import { queueCustomerPush } from './core-push';
import { toCorePayload } from '../customers/core-payload';
import type { CompanyProfile } from '../domain/company';
import type { Actor } from './workflow';
import type { CustomerDoc } from './customers';

/**
 * Changes to a customer's master data, waiting for a decision.
 *
 * Company details used to save straight through. They cannot any more, for a reason that
 * has nothing to do with caution and everything to do with what the save now means: an
 * approved change is pushed into the core's database, where it decides who can sign in to
 * the enterprise portal and what appears on a tax invoice. A typo in a GSTIN used to be a
 * typo in our records; now it is a wrong tax invoice and a customer locked out of a portal.
 *
 * So the same shape as every other change here: propose, review, then it takes effect. The
 * customer's live profile is untouched until somebody accepts it.
 */

export type ProfileChangeStatus = 'pending' | 'approved' | 'rejected';

export interface CustomerProfileChangeDoc {
  _id: ObjectId;
  customerCode: string;
  /** What it would become. */
  proposed: CompanyProfile;
  /** What it is now, captured at submission so a reviewer sees the actual difference. */
  previous?: CompanyProfile;
  /** Field paths that differ, so the queue can say what changed without a diff view. */
  changed: string[];
  status: ProfileChangeStatus;
  submittedBy: Actor;
  submittedAt: Date;
  decidedBy?: Actor;
  decidedAt?: Date;
  comment?: string;
}

async function changes(): Promise<Collection<CustomerProfileChangeDoc>> {
  return (await db()).collection<CustomerProfileChangeDoc>(COLLECTIONS.customerProfileChanges);
}

async function customers(): Promise<Collection<CustomerDoc>> {
  return (await db()).collection<CustomerDoc>(COLLECTIONS.customers);
}

/* ------------------------------------------------------------ what changed */

const scalarFields = [
  'legalName', 'tradeName', 'gstin', 'pan', 'msmeNumber',
] as const satisfies readonly (keyof CompanyProfile)[];

/**
 * A readable list of what differs.
 *
 * Names fields rather than diffing values, because the reviewer's screen shows both
 * versions side by side. What the list is for is the queue: "GSTIN, billing address" tells
 * a reviewer whether this needs care before they open it.
 */
export function changedFields(before: CompanyProfile | undefined, after: CompanyProfile): string[] {
  const changed: string[] = [];
  const previous = before ?? ({ legalName: '', contacts: [], plants: [] } as CompanyProfile);

  for (const field of scalarFields) {
    if ((previous[field] ?? '') !== (after[field] ?? '')) changed.push(field);
  }

  const address = (value: unknown) => JSON.stringify(value ?? null);
  if (address(previous.registeredAddress) !== address(after.registeredAddress)) {
    changed.push('registeredAddress');
  }
  if (address(previous.billingAddress) !== address(after.billingAddress)) {
    changed.push('billingAddress');
  }
  if (JSON.stringify(previous.contacts) !== JSON.stringify(after.contacts)) changed.push('contacts');
  if (JSON.stringify(previous.plants) !== JSON.stringify(after.plants)) changed.push('plants');

  return changed;
}

/* ---------------------------------------------------------------- proposing */

export async function proposeProfileChange(
  code: string,
  proposed: CompanyProfile,
  actor: Actor,
): Promise<{ change: CustomerProfileChangeDoc | null; unchanged: boolean }> {
  const customer = await (await customers()).findOne({ code });
  if (!customer) throw new Error(`customer ${code} not found`);

  const changed = changedFields(customer.profile, proposed);
  // Saving a form nobody edited should not queue a decision for somebody.
  if (changed.length === 0) return { change: null, unchanged: true };

  const collection = await changes();

  // One open proposal per customer. Two people editing the same company into two different
  // shapes, both approved in turn, means the second silently undoes the first.
  const open = await collection.findOne({ customerCode: code, status: 'pending' });
  if (open) {
    throw new Error(
      'This customer already has changes awaiting approval. Have those reviewed first.',
    );
  }

  const doc: CustomerProfileChangeDoc = {
    _id: new ObjectId(),
    customerCode: code,
    proposed,
    ...(customer.profile === undefined ? {} : { previous: customer.profile }),
    changed,
    status: 'pending',
    submittedBy: actor,
    submittedAt: new Date(),
  };
  await collection.insertOne(doc);

  await recordAudit({
    action: 'customer-profile-proposed',
    actor,
    at: new Date(),
    detail: { customer: code, changed: changed.join(', ') },
  });

  return { change: doc, unchanged: false };
}

/* ----------------------------------------------------------------- deciding */

/**
 * Approve a change: apply it, then queue it for the core.
 *
 * Queued rather than sent. The reviewer's click must not depend on the core being awake,
 * and a change that is applied here but rejected by a network is not a change that should
 * be lost — see `data/core-push.ts` for why the queue is durable.
 */
export async function approveProfileChange(
  id: string,
  actor: Actor,
  comment?: string,
): Promise<CustomerProfileChangeDoc> {
  const collection = await changes();
  const change = await collection.findOne({ _id: new ObjectId(id) });
  if (!change) throw new Error('That change no longer exists.');
  if (change.status !== 'pending') throw new Error('That change has already been decided.');

  const customerCollection = await customers();
  const customer = await customerCollection.findOne({ code: change.customerCode });
  if (!customer) throw new Error(`customer ${change.customerCode} not found`);

  const revision = (customer.coreRevision ?? 0) + 1;
  await customerCollection.updateOne(
    { _id: customer._id },
    { $set: { profile: change.proposed, coreRevision: revision } },
  );

  await collection.updateOne(
    { _id: change._id },
    {
      $set: {
        status: 'approved',
        decidedBy: actor,
        decidedAt: new Date(),
        ...(comment ? { comment } : {}),
      },
    },
  );

  await queueCustomerPush(
    toCorePayload({ ...customer, profile: change.proposed, coreRevision: revision }),
  );

  await recordAudit({
    action: 'customer-profile-approved',
    actor,
    at: new Date(),
    detail: { customer: change.customerCode, changed: change.changed.join(', '), revision },
  });

  return { ...change, status: 'approved', decidedBy: actor, decidedAt: new Date() };
}

export async function rejectProfileChange(
  id: string,
  actor: Actor,
  comment?: string,
): Promise<void> {
  const collection = await changes();
  const change = await collection.findOne({ _id: new ObjectId(id) });
  if (!change) throw new Error('That change no longer exists.');
  if (change.status !== 'pending') throw new Error('That change has already been decided.');

  await collection.updateOne(
    { _id: change._id },
    {
      $set: {
        status: 'rejected',
        decidedBy: actor,
        decidedAt: new Date(),
        ...(comment ? { comment } : {}),
      },
    },
  );

  await recordAudit({
    action: 'customer-profile-rejected',
    actor,
    at: new Date(),
    detail: { customer: change.customerCode, reason: comment ?? 'none given' },
  });
}

/* ----------------------------------------------------------------- reading */

export async function pendingProfileChanges(): Promise<CustomerProfileChangeDoc[]> {
  return (await changes()).find({ status: 'pending' }).sort({ submittedAt: 1 }).toArray();
}

export async function profileChangeById(id: string): Promise<CustomerProfileChangeDoc | null> {
  if (!ObjectId.isValid(id)) return null;
  return (await changes()).findOne({ _id: new ObjectId(id) });
}

export async function openProfileChangeFor(code: string): Promise<CustomerProfileChangeDoc | null> {
  return (await changes()).findOne({ customerCode: code, status: 'pending' });
}

export async function profileChangeHistory(limit = 20): Promise<CustomerProfileChangeDoc[]> {
  return (await changes())
    .find({ status: { $ne: 'pending' } })
    .sort({ decidedAt: -1 })
    .limit(limit)
    .toArray();
}
