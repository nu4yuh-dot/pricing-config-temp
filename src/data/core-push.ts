import { ObjectId } from 'mongodb';
import { db, COLLECTIONS } from './mongo';
import type { CoreCustomerPayload } from '../core/contract';

/**
 * Changes waiting to reach the SameX core.
 *
 * Written before anything is sent, and only marked sent once the core has acknowledged it.
 * That order matters: the alternative — send, then record — loses the change if the process
 * dies between the two, and a customer who exists here but not in the core cannot sign in
 * to the enterprise portal and cannot have a shipment attached to them. Nobody would notice
 * until they tried.
 *
 * So the queue is the source of truth for "what the core still owes us", and it is
 * deliberately durable rather than in-memory: a restart must not lose it.
 *
 * It is also how this works before the core has built its side at all. With `CORE_API_URL`
 * unset, every change queues and stays queued. Nothing breaks, nothing is lost, and the day
 * the endpoint ships the backlog drains in order.
 */

export type PushState = 'queued' | 'sent' | 'failed';

export interface CorePushDoc {
  _id: ObjectId;
  kind: 'customer.upsert';
  /** What the change is about, so a customer's history can be read at a glance. */
  customerCode: string;
  /** The full record as it was approved. Kept verbatim: this is what we told the core. */
  payload: CoreCustomerPayload;
  state: PushState;
  attempts: number;
  queuedAt: Date;
  sentAt?: Date;
  lastError?: string;
  /** Whatever the core returned, for support when somebody asks what happened. */
  coreCustomerId?: string;
}

async function pushes() {
  return (await db()).collection<CorePushDoc>(COLLECTIONS.corePushes);
}

/**
 * Queue one change.
 *
 * Superseding is deliberate: if a customer is edited twice before the core is reachable,
 * only the later record needs to go. The payload is the whole customer, so the newer one
 * fully contains the older, and sending both would make the core apply a change it will
 * immediately overwrite.
 */
export async function queueCustomerPush(payload: CoreCustomerPayload): Promise<CorePushDoc> {
  const collection = await pushes();

  await collection.updateMany(
    { customerCode: payload.customerCode, state: 'queued' },
    { $set: { state: 'failed', lastError: 'Superseded by a later revision.' } },
  );

  const doc: CorePushDoc = {
    _id: new ObjectId(),
    kind: 'customer.upsert',
    customerCode: payload.customerCode,
    payload,
    state: 'queued',
    attempts: 0,
    queuedAt: new Date(),
  };
  await collection.insertOne(doc);
  return doc;
}

/** Oldest first: the core should see changes in the order they were approved. */
export async function queuedPushes(limit = 50): Promise<CorePushDoc[]> {
  return (await pushes()).find({ state: 'queued' }).sort({ queuedAt: 1 }).limit(limit).toArray();
}

export async function markSent(id: ObjectId, coreCustomerId?: string): Promise<void> {
  await (await pushes()).updateOne(
    { _id: id },
    {
      $set: {
        state: 'sent',
        sentAt: new Date(),
        ...(coreCustomerId === undefined ? {} : { coreCustomerId }),
      },
      $inc: { attempts: 1 },
    },
  );
}

/**
 * A failed attempt stays `queued`, not `failed`.
 *
 * The core being down is the normal case this exists for, and a state that stops it being
 * retried would turn a five-minute outage into a customer permanently missing from the
 * core. `failed` is reserved for a change that has been superseded and should not be sent.
 */
export async function recordAttempt(id: ObjectId, error: string): Promise<void> {
  await (await pushes()).updateOne(
    { _id: id },
    { $set: { lastError: error }, $inc: { attempts: 1 } },
  );
}

/** What is outstanding, for the screen that shows whether the core is in step with us. */
export async function pushBacklog(): Promise<{ queued: number; oldest: Date | null }> {
  const collection = await pushes();
  const queued = await collection.countDocuments({ state: 'queued' });
  const oldest = await collection.find({ state: 'queued' }).sort({ queuedAt: 1 }).limit(1).next();
  return { queued, oldest: oldest?.queuedAt ?? null };
}

/** Everything we have ever told the core about one customer, newest first. */
export async function pushHistoryFor(customerCode: string, limit = 20): Promise<CorePushDoc[]> {
  return (await pushes()).find({ customerCode }).sort({ queuedAt: -1 }).limit(limit).toArray();
}
