import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import { recordPayment } from './billing';
import {
  allocateOldestFirst,
  allocationIsPostable,
  unallocatedPaise,
  ageing,
  owedOn,
  type Receipt,
  type Allocation,
  type OutstandingInvoice,
} from '../billing/collections';
import type { Invoice } from '../billing/invoice';
import type { Actor } from './workflow';

/**
 * Receipts, and applying them to invoices.
 *
 * The order here is the whole design: a receipt exists as soon as money arrives, and is
 * applied afterwards. Recording it only at the moment somebody knows which invoice it
 * settles would mean money in the bank that the system says is not there.
 */

async function receipts() {
  return (await db()).collection<Receipt>(COLLECTIONS.receipts);
}

async function invoices() {
  return (await db()).collection<Invoice>(COLLECTIONS.invoices);
}

function reference(): string {
  return `RCP-${Date.now().toString(36).toUpperCase()}`;
}

/** Invoices with something still owed, oldest due first. */
export async function outstandingFor(
  customerCode: string,
  paymentTermsDays: number,
): Promise<OutstandingInvoice[]> {
  const open = await (await invoices())
    .find({ customerCode, status: { $in: ['unpaid', 'part-paid'] } })
    .toArray();

  return open
    .map((invoice) => ({
      number: invoice.number,
      // Due from the invoice's own date, not from one date for the customer — which is
      // what makes ageing per document rather than per account.
      dueAt: new Date(invoice.raisedAt.getTime() + paymentTermsDays * 86_400_000),
      totalPaise: invoice.totalPaise,
      paidPaise: invoice.paidPaise,
    }))
    .filter((invoice) => owedOn(invoice) > 0);
}

export async function recordReceipt(input: {
  customerCode: string;
  amountPaise: number;
  receivedAt: Date;
  instrument?: string;
  note?: string;
  /** Apply it oldest-first straight away. Still a draft, still changeable. */
  autoAllocate?: boolean;
  paymentTermsDays: number;
  actor: Actor;
}): Promise<Receipt> {
  const allocations = input.autoAllocate
    ? allocateOldestFirst(
        input.amountPaise,
        await outstandingFor(input.customerCode, input.paymentTermsDays),
      )
    : [];

  const receipt: Receipt = {
    reference: reference(),
    customerCode: input.customerCode,
    amountPaise: input.amountPaise,
    receivedAt: input.receivedAt,
    ...(input.instrument ? { instrument: input.instrument } : {}),
    status: 'draft',
    allocations,
    ...(input.note ? { note: input.note } : {}),
  };

  await (await receipts()).insertOne(receipt);
  await recordAudit({
    action: 'receipt-recorded',
    actor: input.actor,
    at: new Date(),
    detail: {
      customer: input.customerCode,
      reference: receipt.reference,
      amount: input.amountPaise / 100,
      allocatedLines: allocations.length,
    },
  });

  return receipt;
}

/**
 * Change where a draft receipt's money goes.
 *
 * Replaces the allocation rather than adjusting it. A clerk who applied ₹50,000 to the
 * wrong invoice fixes it by moving it, and a partial edit would leave the old line behind
 * to be noticed later.
 */
export async function reallocate(
  reference: string,
  allocations: Allocation[],
  actor: Actor,
): Promise<Receipt> {
  const collection = await receipts();
  const receipt = await collection.findOne({ reference });
  if (!receipt) throw new Error('No such receipt.');
  if (receipt.status === 'finalised') {
    throw new Error('This receipt has been posted. Correct it with a fresh receipt or a note.');
  }

  await collection.updateOne({ reference }, { $set: { allocations } });
  await recordAudit({
    action: 'receipt-reallocated',
    actor,
    at: new Date(),
    detail: { reference, lines: allocations.length },
  });

  return { ...receipt, allocations };
}

/**
 * Posts a draft receipt: the allocation becomes payments against the invoices.
 *
 * Checked immediately before posting rather than while editing, because a draft is allowed
 * to be temporarily wrong — that is what drafting is. Money left unallocated is permitted
 * and stays on account; over-allocation is not.
 */
export async function finaliseReceipt(
  reference: string,
  paymentTermsDays: number,
  actor: Actor,
): Promise<Receipt> {
  const collection = await receipts();
  const receipt = await collection.findOne({ reference });
  if (!receipt) throw new Error('No such receipt.');

  const outstanding = await outstandingFor(receipt.customerCode, paymentTermsDays);
  const problem = allocationIsPostable(receipt, outstanding);
  if (problem) throw new Error(problem.message);

  for (const allocation of receipt.allocations) {
    /**
     * One reference per receipt *line*, not per receipt.
     *
     * The ledger deduplicates on the reference, so passing the bank's own UTR for every
     * allocation makes the second line look like a repeat of the first and it is silently
     * dropped — the receipt reads as posted while the invoice stays unpaid. One transfer
     * settling four invoices is one bank reference and four payments.
     *
     * Keyed on the receipt and the invoice, so re-posting the same line is still correctly
     * a duplicate. The bank's own reference travels in the note, where it is what somebody
     * matches against a statement.
     */
    await recordPayment(
      receipt.customerCode,
      allocation.invoiceNumber,
      allocation.paise / 100,
      `${receipt.reference}/${allocation.invoiceNumber}`,
      actor,
    );
  }

  const finalisedAt = new Date();
  await collection.updateOne({ reference }, { $set: { status: 'finalised', finalisedAt } });

  await recordAudit({
    action: 'receipt-finalised',
    actor,
    at: finalisedAt,
    detail: {
      customer: receipt.customerCode,
      reference,
      applied: receipt.allocations.reduce((total, item) => total + item.paise, 0) / 100,
      onAccount: unallocatedPaise(receipt) / 100,
    },
  });

  return { ...receipt, status: 'finalised', finalisedAt };
}

export async function listReceipts(customerCode?: string, limit = 100): Promise<Receipt[]> {
  return (await receipts())
    .find(customerCode ? { customerCode } : {})
    .sort({ receivedAt: -1 })
    .limit(limit)
    .toArray();
}

export async function findReceipt(reference: string): Promise<Receipt | null> {
  return (await receipts()).findOne({ reference });
}

/** What is owed, by how overdue — for the collections screen. */
export async function ageingFor(customerCode: string, paymentTermsDays: number) {
  return ageing(await outstandingFor(customerCode, paymentTermsDays));
}
