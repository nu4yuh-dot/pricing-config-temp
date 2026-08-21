import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import {
  canAttribute,
  canBill,
  canReopen,
  canRelock,
  restatementFor,
  type BillingPeriod,
} from '../billing/periods';
import type { Actor } from './workflow';

/**
 * Billing periods, stored.
 *
 * The rules live in `billing/periods.ts` and are tested without a database. This is only
 * the part that reads and writes them — kept apart so the question "may this shipment land
 * here" can be answered in a test without a Mongo instance.
 */

async function periods() {
  return (await db()).collection<BillingPeriod>(COLLECTIONS.billingPeriods);
}

export async function periodFor(customerCode: string, from: Date): Promise<BillingPeriod | null> {
  return (await periods()).findOne({ customerCode, from });
}

export async function openPeriod(
  customerCode: string,
  from: Date,
  to: Date,
): Promise<BillingPeriod> {
  const existing = await periodFor(customerCode, from);
  if (existing) return existing;

  const period: BillingPeriod = {
    customerCode,
    from,
    to,
    state: 'open',
    invoiceNumbers: [],
    restatements: [],
  };
  await (await periods()).insertOne(period);
  return period;
}

/** Whether a shipment may be attributed to the period covering this date. */
export async function attributionRefusal(
  customerCode: string,
  from: Date,
): Promise<string | null> {
  const period = await periodFor(customerCode, from);
  // No period yet means nothing has been claimed about that window.
  if (!period) return null;
  return canAttribute(period)?.message ?? null;
}

export async function markBilled(
  customerCode: string,
  from: Date,
  invoiceNumbers: string[],
  totalPaise: number,
  actor: Actor,
): Promise<BillingPeriod> {
  const collection = await periods();
  const period = await periodFor(customerCode, from);
  if (!period) throw new Error('No such period.');

  const refusal = canBill(period);
  if (refusal) throw new Error(refusal.message);

  const billedAt = new Date();
  const wasReopened = period.state === 'reopened';

  await collection.updateOne(
    { customerCode, from },
    {
      $set: {
        state: 'billed',
        billedAt,
        invoiceNumbers: [...new Set([...period.invoiceNumbers, ...invoiceNumbers])],
        // Only ever written once. It is what the customer was told, and a second billing
        // after a correction must not overwrite the figure being compared against.
        ...(period.asBilledPaise === undefined ? { asBilledPaise: totalPaise } : {}),
      },
    },
  );

  await recordAudit({
    action: 'period-billed',
    actor,
    at: billedAt,
    detail: {
      customer: customerCode,
      from: from.toISOString().slice(0, 10),
      invoices: invoiceNumbers.length,
      total: totalPaise / 100,
      afterCorrection: wasReopened,
    },
  });

  return { ...period, state: 'billed', billedAt };
}

/**
 * Reopens a billed period, on purpose and with a reason.
 *
 * The reason is required. A period that reopened itself because a late shipment arrived
 * would defeat the point — the whole reason for the state is that somebody decided.
 */
export async function reopenPeriod(
  customerCode: string,
  from: Date,
  reason: string,
  actor: Actor,
): Promise<void> {
  const period = await periodFor(customerCode, from);
  if (!period) throw new Error('No such period.');

  const refusal = canReopen(period);
  if (refusal) throw new Error(refusal.message);
  if (!reason.trim()) throw new Error('Say why this period is being reopened.');

  await (await periods()).updateOne(
    { customerCode, from },
    { $set: { state: 'reopened', reopenedAt: new Date(), reopenReason: reason } },
  );

  await recordAudit({
    action: 'period-reopened',
    actor,
    at: new Date(),
    detail: { customer: customerCode, from: from.toISOString().slice(0, 10), reason },
  });
}

/** Closes a reopened period and records what the correction did to the total. */
export async function relockPeriod(
  customerCode: string,
  from: Date,
  asCorrectedPaise: number,
  actor: Actor,
): Promise<void> {
  const collection = await periods();
  const period = (await periodFor(customerCode, from)) as
    | (BillingPeriod & { reopenedAt?: Date; reopenReason?: string })
    | null;
  if (!period) throw new Error('No such period.');

  const refusal = canRelock(period);
  if (refusal) throw new Error(refusal.message);

  const restatement = restatementFor(
    period,
    asCorrectedPaise,
    period.reopenReason ?? 'no reason recorded',
    period.reopenedAt ?? new Date(),
  );

  await collection.updateOne(
    { customerCode, from },
    { $set: { state: 'relocked' }, $push: { restatements: restatement } },
  );

  await recordAudit({
    action: 'period-relocked',
    actor,
    at: new Date(),
    detail: {
      customer: customerCode,
      from: from.toISOString().slice(0, 10),
      asBilled: restatement.asBilledPaise / 100,
      asCorrected: asCorrectedPaise / 100,
      difference: restatement.differencePaise / 100,
    },
  });
}

export async function listPeriods(customerCode?: string): Promise<BillingPeriod[]> {
  return (await periods())
    .find(customerCode ? { customerCode } : {})
    .sort({ from: -1 })
    .limit(100)
    .toArray();
}

/**
 * Shipments a customer has disputed, for the reopening proposals.
 *
 * Reads the dispute the core recorded — it reaches us on the shipment update, and until
 * now nothing looked at it.
 */
export async function disputedLines() {
  const shipments = await (await db())
    .collection(COLLECTIONS.shipments)
    .find({ 'pod.disputeStatus': { $in: ['open', 'investigating'] } })
    .toArray();

  return shipments.map((shipment) => {
    const doc = shipment as unknown as {
      awb: string;
      customerCode: string;
      bookedAt: Date;
      booked?: { total?: number };
      pod?: { disputeStatus: string; disputeAmount?: number; reason?: string };
    };
    return {
      awb: doc.awb,
      customerCode: doc.customerCode,
      bookedAt: doc.bookedAt,
      disputeStatus: doc.pod!.disputeStatus as 'open' | 'investigating',
      ...(doc.pod?.disputeAmount === undefined ? {} : { amount: doc.pod.disputeAmount }),
      billedTotal: doc.booked?.total ?? 0,
    };
  });
}
