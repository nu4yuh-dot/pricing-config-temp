import type { Invoice } from './invoice';
import type { BillingPeriod } from './periods';
import { isFrozen, netRestatementPaise } from './periods';

/**
 * A period as the customer sees it in their own portal.
 *
 * Their Billing and Reconcile screens ask three questions, and this shape answers all of
 * them: what is this bill, what is on it line by line, and which lines am I disputing.
 *
 * The status vocabulary is theirs, because their screen renders it. Ours is a period state
 * — open, billed, reopened, relocked — which is about whether the *set* can change. Theirs
 * is about where the money has got to. Both are true; only one belongs on a customer's
 * screen.
 */

/** The core's own cycle statuses, which their portal renders directly. */
export type CustomerBillStatus =
  | 'active'
  | 'bill_generated'
  | 'shared'
  | 'review'
  | 'due'
  | 'overdue'
  | 'paid';

export interface BillLine {
  /** The AWB. What a customer queries a line by. */
  reference: string;
  date: Date;
  mode: string;
  origin: string;
  destination: string;
  chargeableWeight: number;
  taxableValue: number;
  gst: number;
  total: number;
  invoiceNumber: string;
  /** Whether the customer has accepted, disputed, or not looked at this line. */
  reconciliation: 'pending' | 'accepted' | 'disputed';
  disputeReason?: string;
}

export interface CustomerBill {
  /** Stable and readable: the period's start date. */
  periodId: string;
  from: Date;
  to: Date;
  status: CustomerBillStatus;
  dueAt: Date | null;
  invoiceNumbers: string[];
  totalPaise: number;
  paidPaise: number;
  balancePaise: number;
  /** Lines the customer has disputed, and what they add up to. */
  disputedCount: number;
  disputedPaise: number;
  /** Set when the bill has been reopened and corrected since it was issued. */
  restatedByPaise?: number;
  lines: BillLine[];
}

/** The period's id as the portal will address it — the start date, not a database id. */
export const periodIdOf = (from: Date): string => from.toISOString().slice(0, 10);

/**
 * Where the money has got to, from the facts rather than a stored flag.
 *
 * Derived so it cannot disagree with the invoices. A stored status is a second opinion
 * that drifts the first time a payment lands outside the flow that maintains it.
 */
export function billStatus(
  period: BillingPeriod,
  invoices: readonly Invoice[],
  dueAt: Date | null,
  asOf: Date = new Date(),
): CustomerBillStatus {
  if (!isFrozen(period.state) && invoices.length === 0) return 'active';
  if (invoices.length === 0) return 'active';

  const total = invoices.reduce((sum, invoice) => sum + invoice.totalPaise, 0);
  const paid = invoices.reduce((sum, invoice) => sum + invoice.paidPaise, 0);

  if (paid >= total && total > 0) return 'paid';
  if (period.state === 'reopened') return 'review';
  if (dueAt && asOf > dueAt) return 'overdue';
  if (dueAt) return 'due';
  return 'bill_generated';
}

export interface ReconciliationMark {
  awb: string;
  state: 'accepted' | 'disputed';
  reason?: string;
  at: Date;
  by: string;
}

/** Builds the customer-facing bill from what we hold. */
export function buildCustomerBill(
  period: BillingPeriod,
  invoices: readonly Invoice[],
  marks: readonly ReconciliationMark[],
  paymentTermsDays: number,
  asOf: Date = new Date(),
): CustomerBill {
  const markByAwb = new Map(marks.map((mark) => [mark.awb, mark]));

  const lines: BillLine[] = invoices.flatMap((invoice) =>
    invoice.lines.map((line) => {
      const mark = markByAwb.get(line.reference);
      return {
        reference: line.reference,
        date: line.date,
        mode: invoice.mode,
        origin: line.origin,
        destination: line.destination,
        chargeableWeight: line.chargeableWeight,
        taxableValue: line.taxableValuePaise / 100,
        gst: line.gstPaise / 100,
        total: line.totalPaise / 100,
        invoiceNumber: invoice.number,
        reconciliation: mark?.state ?? 'pending',
        ...(mark?.reason ? { disputeReason: mark.reason } : {}),
      };
    }),
  );

  const totalPaise = invoices.reduce((sum, invoice) => sum + invoice.totalPaise, 0);
  const paidPaise = invoices.reduce((sum, invoice) => sum + invoice.paidPaise, 0);

  const disputed = lines.filter((line) => line.reconciliation === 'disputed');
  const restated = netRestatementPaise(period);

  // Due from the earliest invoice, not from the period end: the clock starts when the
  // document is raised, and a bill raised late is not due sooner for it.
  const earliest = invoices
    .map((invoice) => invoice.raisedAt.getTime())
    .sort((a, b) => a - b)[0];
  const dueAt =
    earliest === undefined ? null : new Date(earliest + paymentTermsDays * 86_400_000);

  return {
    periodId: periodIdOf(period.from),
    from: period.from,
    to: period.to,
    status: billStatus(period, invoices, dueAt, asOf),
    dueAt,
    invoiceNumbers: invoices.map((invoice) => invoice.number),
    totalPaise,
    paidPaise,
    balancePaise: Math.max(totalPaise - paidPaise, 0),
    disputedCount: disputed.length,
    disputedPaise: Math.round(disputed.reduce((sum, line) => sum + line.total, 0) * 100),
    ...(restated === 0 ? {} : { restatedByPaise: restated }),
    lines,
  };
}
