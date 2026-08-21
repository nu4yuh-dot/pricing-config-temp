import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import { listPeriods, periodFor } from './billing-periods';
import {
  buildCustomerBill,
  periodIdOf,
  type CustomerBill,
  type ReconciliationMark,
} from '../billing/statement';
import type { Invoice } from '../billing/invoice';
import type { Actor } from './workflow';

/**
 * Billing as the customer's own portal asks for it.
 *
 * Their screens address a bill by cycle. We hold periods, keyed by the customer and the
 * date the period starts — so the period's start date is the id. Readable, stable, and it
 * cannot be confused with a database identifier that means nothing to anybody.
 *
 * Reconciliation marks are stored beside the period rather than on the shipment, because
 * accepting a line is a statement about *this bill*: the same shipment can appear on a
 * restated bill and be looked at again.
 */

interface MarksDoc {
  customerCode: string;
  periodId: string;
  marks: ReconciliationMark[];
}

async function marksCollection() {
  return (await db()).collection<MarksDoc>(COLLECTIONS.reconciliation);
}

async function invoicesFor(customerCode: string, numbers: string[]): Promise<Invoice[]> {
  if (numbers.length === 0) return [];
  return (await db())
    .collection<Invoice>(COLLECTIONS.invoices)
    .find({ customerCode, number: { $in: numbers } })
    .toArray();
}

async function marksFor(customerCode: string, periodId: string): Promise<ReconciliationMark[]> {
  const doc = await (await marksCollection()).findOne({ customerCode, periodId });
  return doc?.marks ?? [];
}

/** Every bill the customer has, newest first. */
export async function billHistory(
  customerCode: string,
  paymentTermsDays: number,
): Promise<CustomerBill[]> {
  const periods = await listPeriods(customerCode);
  return Promise.all(
    periods.map(async (period) => {
      const periodId = periodIdOf(period.from);
      const [invoices, marks] = await Promise.all([
        invoicesFor(customerCode, period.invoiceNumbers),
        marksFor(customerCode, periodId),
      ]);
      return buildCustomerBill(period, invoices, marks, paymentTermsDays);
    }),
  );
}

/**
 * The bill the customer is currently looking at.
 *
 * The newest period that has actually been billed. An open period is not a bill — nothing
 * has been claimed about it — and showing one as "current" invites a customer to query a
 * total that is still moving.
 */
export async function currentBill(
  customerCode: string,
  paymentTermsDays: number,
): Promise<CustomerBill | null> {
  const bills = await billHistory(customerCode, paymentTermsDays);
  return bills.find((bill) => bill.status !== 'active') ?? null;
}

export async function billFor(
  customerCode: string,
  periodId: string,
  paymentTermsDays: number,
): Promise<CustomerBill | null> {
  const period = await periodFor(customerCode, new Date(`${periodId}T00:00:00.000Z`));
  if (!period) return null;

  const [invoices, marks] = await Promise.all([
    invoicesFor(customerCode, period.invoiceNumbers),
    marksFor(customerCode, periodId),
  ]);
  return buildCustomerBill(period, invoices, marks, paymentTermsDays);
}

/**
 * The customer accepting or disputing one line.
 *
 * Replaces the mark rather than appending, so a customer who disputes a line and then
 * accepts it does not leave both opinions on the record for somebody to choose between.
 */
export async function markLine(
  customerCode: string,
  periodId: string,
  mark: ReconciliationMark,
  actor: Actor,
): Promise<void> {
  const collection = await marksCollection();
  const existing = await collection.findOne({ customerCode, periodId });
  const marks = [...(existing?.marks ?? []).filter((item) => item.awb !== mark.awb), mark];

  await collection.updateOne(
    { customerCode, periodId },
    { $set: { customerCode, periodId, marks } },
    { upsert: true },
  );

  await recordAudit({
    action: mark.state === 'disputed' ? 'bill-line-disputed' : 'bill-line-accepted',
    actor,
    at: mark.at,
    detail: { customer: customerCode, period: periodId, awb: mark.awb, by: mark.by, reason: mark.reason },
  });
}

/** Accepting every line at once, which is what most customers do. */
export async function acceptAll(
  customerCode: string,
  periodId: string,
  by: string,
  paymentTermsDays: number,
  actor: Actor,
): Promise<number> {
  const bill = await billFor(customerCode, periodId, paymentTermsDays);
  if (!bill) throw new Error('No such bill.');

  const at = new Date();
  // Only the lines nobody has looked at. Accepting everything must not quietly withdraw a
  // dispute the customer already raised.
  const pending = bill.lines.filter((line) => line.reconciliation === 'pending');

  for (const line of pending) {
    await markLine(customerCode, periodId, { awb: line.reference, state: 'accepted', at, by }, actor);
  }

  return pending.length;
}
