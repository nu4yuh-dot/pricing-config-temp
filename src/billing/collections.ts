import type { Invoice } from './invoice';

/**
 * Collections — money arriving, and which invoices it settles.
 *
 * A receipt is not a payment against an invoice. It is money in the bank, which somebody
 * then decides how to apply. Conflating the two is the mistake this file exists to avoid:
 * a customer sends one transfer covering four invoices and a part of a fifth, and if the
 * money can only exist as a payment against one invoice, that reality cannot be recorded.
 *
 * So a receipt has its own life:
 *
 *   draft      — recorded, allocated however somebody likes, freely changed
 *   finalised  — the allocation is posted to the ledger and the money is applied
 *
 * And allocation is *reallocatable* while a receipt is a draft. A clerk who applied ₹50,000
 * to the wrong invoice should fix it by moving it, not by inventing a reversing entry.
 *
 * Oldest first is the default because it is what both sides assume when nobody says
 * otherwise — but it is a default, not a rule, and a customer who says "this one is for
 * the September invoice" gets that.
 */

export type ReceiptStatus = 'draft' | 'finalised';

export interface Allocation {
  invoiceNumber: string;
  paise: number;
}

export interface Receipt {
  reference: string;
  customerCode: string;
  /** What arrived, in paise. Never changes once recorded — the bank said so. */
  amountPaise: number;
  receivedAt: Date;
  /** The bank's own reference: a UTR, a cheque number, a gateway id. */
  instrument?: string;
  status: ReceiptStatus;
  allocations: Allocation[];
  finalisedAt?: Date;
  note?: string;
}

/** What a receipt has not yet been applied to anything. */
export function unallocatedPaise(receipt: Receipt): number {
  const applied = receipt.allocations.reduce((total, item) => total + item.paise, 0);
  return receipt.amountPaise - applied;
}

export interface OutstandingInvoice {
  number: string;
  dueAt: Date;
  totalPaise: number;
  paidPaise: number;
}

/** What is still owed on one invoice. */
export const owedOn = (invoice: OutstandingInvoice): number =>
  Math.max(invoice.totalPaise - invoice.paidPaise, 0);

/**
 * Spreads a receipt across invoices, oldest due date first.
 *
 * Stops when the money runs out, and never allocates more to an invoice than it owes —
 * over-applying would show an invoice as paid twice and hide the fact that money is still
 * sitting unallocated.
 *
 * Deterministic on the due date, then the number, so the same receipt against the same
 * ledger always produces the same allocation. A clerk who reruns it must not get a
 * different answer.
 */
export function allocateOldestFirst(
  amountPaise: number,
  invoices: readonly OutstandingInvoice[],
): Allocation[] {
  const ordered = [...invoices]
    .filter((invoice) => owedOn(invoice) > 0)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.number.localeCompare(b.number));

  const allocations: Allocation[] = [];
  let left = amountPaise;

  for (const invoice of ordered) {
    if (left <= 0) break;
    const paise = Math.min(owedOn(invoice), left);
    allocations.push({ invoiceNumber: invoice.number, paise });
    left -= paise;
  }

  return allocations;
}

export interface AllocationProblem {
  message: string;
}

/**
 * Whether an allocation may be posted.
 *
 * Checked before finalising rather than while editing: a draft allocation is allowed to be
 * temporarily wrong, because that is what drafting is. It is finalising that has to be
 * right.
 */
export function allocationIsPostable(
  receipt: Receipt,
  invoices: readonly OutstandingInvoice[],
): AllocationProblem | null {
  if (receipt.status === 'finalised') {
    return { message: 'This receipt has already been posted.' };
  }

  const applied = receipt.allocations.reduce((total, item) => total + item.paise, 0);
  if (applied > receipt.amountPaise) {
    return {
      message: `Allocated ₹${(applied / 100).toLocaleString('en-IN')} of a receipt for ₹${(receipt.amountPaise / 100).toLocaleString('en-IN')}.`,
    };
  }

  if (receipt.allocations.some((item) => item.paise <= 0)) {
    return { message: 'An allocation of nothing is not an allocation. Remove the line instead.' };
  }

  const byNumber = new Map(invoices.map((invoice) => [invoice.number, invoice]));
  const seen = new Set<string>();

  for (const allocation of receipt.allocations) {
    if (seen.has(allocation.invoiceNumber)) {
      // Two lines against one invoice add up to the same money and read as a mistake.
      return { message: `${allocation.invoiceNumber} appears twice. Combine the lines.` };
    }
    seen.add(allocation.invoiceNumber);

    const invoice = byNumber.get(allocation.invoiceNumber);
    if (!invoice) return { message: `${allocation.invoiceNumber} is not an open invoice.` };

    if (allocation.paise > owedOn(invoice)) {
      return {
        message: `${allocation.invoiceNumber} owes ₹${(owedOn(invoice) / 100).toLocaleString('en-IN')}; ₹${(allocation.paise / 100).toLocaleString('en-IN')} was allocated to it.`,
      };
    }
  }

  return null;
}

/* --------------------------------------------------------------- ageing */

export interface AgeingBand {
  label: string;
  /** Days overdue, inclusive lower bound. */
  from: number;
  /** Exclusive upper bound; null is open-ended. */
  to: number | null;
  paise: number;
  invoices: string[];
}

const BANDS: { label: string; from: number; to: number | null }[] = [
  { label: 'Not yet due', from: -Infinity as unknown as number, to: 0 },
  { label: '0–30 days', from: 0, to: 31 },
  { label: '31–60 days', from: 31, to: 61 },
  { label: '61–90 days', from: 61, to: 91 },
  { label: 'Over 90 days', from: 91, to: null },
];

/**
 * What is owed, by how overdue it is.
 *
 * Measured against each invoice's own due date, not against a single date for the
 * customer. A customer on 45-day terms with one invoice raised late is not uniformly
 * 45 days old, and a band computed from the customer's terms rather than the document
 * would say they were.
 */
export function ageing(invoices: readonly OutstandingInvoice[], asOf: Date = new Date()): AgeingBand[] {
  const bands: AgeingBand[] = BANDS.map((band) => ({ ...band, paise: 0, invoices: [] }));

  for (const invoice of invoices) {
    const owed = owedOn(invoice);
    if (owed <= 0) continue;

    const daysOverdue = Math.floor(
      (asOf.getTime() - invoice.dueAt.getTime()) / (24 * 60 * 60 * 1000),
    );

    const band =
      bands.find(
        (candidate) =>
          daysOverdue >= candidate.from && (candidate.to === null || daysOverdue < candidate.to),
      ) ?? bands[bands.length - 1]!;

    band.paise += owed;
    band.invoices.push(invoice.number);
  }

  return bands;
}

/** Everything overdue, whatever the band. The number a collections call is about. */
export function overduePaise(bands: readonly AgeingBand[]): number {
  return bands
    .filter((band) => band.label !== 'Not yet due')
    .reduce((total, band) => total + band.paise, 0);
}
