import { decideBooking } from '../billing/settlement-room';
import type { EffectiveSettlement } from '../billing/settlement';
import { db, COLLECTIONS } from './mongo';
import {
  balance,
  bookability,
  creditPosition,
  entry,
  reverseOf,
  statement,
  type Bookability,
  type BookingBlock,
  type CreditPosition,
  type CreditTerms,
  type EntryKind,
  type LedgerEntry,
  type StatementRow,
  ageing,
  type AgeingBucket,
} from '../billing/ledger';
import {
  buildInvoices,
  statusOf,
  type BillableShipment,
  type Invoice,
  type Period,
} from '../billing/invoice';
import { recordAudit } from './audit';
import { allocateNumber, recordGap } from './invoice-series';
import type { Actor } from './workflow';

/**
 * Money, persisted.
 *
 * The repository deliberately holds no arithmetic. Balances, credit positions and invoice
 * totals are computed by replaying entries through `billing/ledger.ts`, which is pure and
 * tested in isolation. Storing a balance and updating it in place would create a second
 * source of truth that can silently disagree with the entries — and when those two
 * disagree, there is no way to tell which is right.
 */

async function ledger() {
  return (await db()).collection<LedgerEntry>(COLLECTIONS.ledger);
}

async function invoicesCollection() {
  return (await db()).collection<Invoice>(COLLECTIONS.invoices);
}

export async function entriesFor(customerCode: string): Promise<LedgerEntry[]> {
  const rows = await (await ledger())
    .find({ customerCode }, { projection: { _id: 0 } })
    .sort({ at: 1 })
    .toArray();
  return rows;
}

export interface RecordEntryInput {
  customerCode: string;
  kind: EntryKind;
  amount: number;
  /** This transaction's own id — the gateway reference, the UTR, the invoice number. */
  reference: string;
  /** For a payment: the invoice being settled. */
  against?: string;
  note?: string;
}

/**
 * Append one entry.
 *
 * The reference is unique per kind on purpose: a recharge reference is the payment gateway's
 * id and an invoice reference is the invoice number, so a retried callback or a double-click
 * cannot pay the same money in twice.
 */
export async function recordEntry(
  input: RecordEntryInput,
  actor: Actor,
): Promise<{ entry: LedgerEntry; duplicate: boolean }> {
  const collection = await ledger();

  const existing = await collection.findOne({
    customerCode: input.customerCode,
    kind: input.kind,
    reference: input.reference,
  });
  if (existing) return { entry: existing, duplicate: true };

  const created = entry(input);
  await collection.insertOne({ ...created });
  await recordAudit({
    action: 'ledger-entry',
    actor,
    at: new Date(),
    detail: {
      customerCode: input.customerCode,
      kind: input.kind,
      amount: input.amount,
      reference: input.reference,
    },
  });
  return { entry: created, duplicate: false };
}

/** Undo an entry by appending its reversal. Nothing is edited or removed. */
export async function reverseEntry(
  entryId: string,
  reason: string,
  actor: Actor,
): Promise<LedgerEntry> {
  const collection = await ledger();
  const original = await collection.findOne({ id: entryId });
  if (!original) throw new Error(`Ledger entry ${entryId} does not exist.`);

  const already = await collection.findOne({ reversalOf: entryId });
  if (already) throw new Error(`That entry has already been reversed.`);

  const reversal = reverseOf(original, reason);
  await collection.insertOne({ ...reversal });
  await recordAudit({
    action: 'ledger-reversal',
    actor,
    at: new Date(),
    detail: {
      customerCode: original.customerCode,
      reversed: original.kind,
      reference: original.reference,
      reason,
    },
  });
  return reversal;
}

export interface BillingSummary {
  position: CreditPosition;
  statement: StatementRow[];
  invoices: Invoice[];
  balancePaise: number;
  /** Unpaid invoices by how long they have been unpaid. Same replay as `position`. */
  ageing: AgeingBucket[];
}

export async function billingFor(
  customerCode: string,
  terms: CreditTerms,
  asOf: Date = new Date(),
): Promise<BillingSummary> {
  const [entries, invoices] = await Promise.all([
    entriesFor(customerCode),
    invoicesFor(customerCode),
  ]);
  return {
    position: creditPosition(terms, entries, asOf),
    statement: statement(entries),
    invoices,
    balancePaise: balance(entries),
    ageing: ageing(terms, entries, asOf),
  };
}

/** Whether a shipment of this value can be booked against the customer's money. */
/**
 * May this customer book this shipment?
 *
 * With a settlement arrangement assigned, that arrangement decides: prepaid and credit
 * measure room differently, and what happens when the room runs out is itself configured
 * per profile. Without one, the older wallet-plus-limit check applies unchanged — a
 * customer nobody has put on terms should not silently become permissive, and should not
 * silently become blocked either.
 */
export async function canBook(
  customerCode: string,
  terms: CreditTerms,
  shipmentValue: number,
  settlement?: EffectiveSettlement | null,
): Promise<Bookability & { overridable?: boolean; flagged?: boolean; clearsIf?: string[] }> {
  const entries = await entriesFor(customerCode);
  const position = creditPosition(terms, entries);

  if (!settlement) return bookability(position, shipmentValue);

  const decision = decideBooking(settlement, position, shipmentValue);
  if (decision.allowed && !decision.flagged) {
    return { allowed: true, ...(decision.lowBalance ? { message: lowBalanceNote(settlement) } : {}) };
  }

  // Which of the two problems to name. Overdue is reported first because it is the one
  // that paying the shortfall would not fix.
  const reason: BookingBlock =
    position.overdue > 0 && settlement.mode === 'credit'
      ? 'overdue'
      : settlement.mode === 'prepaid'
        ? 'insufficient-wallet'
        : 'credit-limit-exceeded';

  return {
    allowed: decision.allowed,
    reason,
    shortfall: decision.shortfall,
    message: [...decision.reasons, ...(decision.clearsIf.length ? [`Clears with ${decision.clearsIf.join(', or ')}.`] : [])].join(' '),
    overridable: decision.overridable,
    flagged: decision.flagged,
    clearsIf: decision.clearsIf,
  };
}

/** Said only when the arrangement asked to be warned. */
function lowBalanceNote(settlement: EffectiveSettlement): string {
  const suggestion = settlement.prepaid.minRecharge;
  return suggestion
    ? `This takes the balance to the alert level. A top-up of ₹${suggestion.toLocaleString('en-IN')} or more is the usual amount.`
    : 'This takes the balance to the alert level.';
}

export async function invoicesFor(customerCode: string): Promise<Invoice[]> {
  return (await invoicesCollection())
    .find({ customerCode }, { projection: { _id: 0 } })
    .sort({ raisedAt: -1 })
    .toArray();
}

/**
 * Raise invoices for a period, one per mode, and post each to the ledger.
 *
 * Invoice numbers are deterministic, so running a period twice hits the unique index rather
 * than billing the customer again. Both writes use the same number, which is what keeps the
 * invoice and its ledger entry in step.
 */
export async function raiseInvoices(
  customerCode: string,
  shipments: BillableShipment[],
  period: Period,
  actor: Actor,
): Promise<{ raised: Invoice[]; skipped: string[] }> {
  const built = buildInvoices(customerCode, shipments, period);
  const collection = await invoicesCollection();

  const raised: Invoice[] = [];
  const skipped: string[] = [];

  for (const invoice of built) {
    /**
     * The duplicate check comes first, and deliberately before the series is touched.
     *
     * A rerun of a bill run must not spend a number. If it allocated first and then found
     * the invoice already existed, every retry would burn a number and leave a gap to
     * explain — turning an ordinary re-run into paperwork.
     */
    const existing = await collection.findOne({ naturalKey: invoice.naturalKey });
    if (existing) {
      skipped.push(existing.number || invoice.naturalKey);
      continue;
    }

    const { number, sequence } = await allocateNumber(invoice.raisedAt);
    const numbered = { ...invoice, number };

    try {
      await collection.insertOne(numbered);
    } catch (cause) {
      // The number is spent. It is not reused — that would put two documents at one
      // position in the series — so it is recorded as a gap with a reason, and the series
      // still reconciles.
      await recordGap(
        number,
        sequence,
        cause instanceof Error ? cause.message : 'invoice write failed',
        invoice.raisedAt,
      );
      throw cause;
    }

    Object.assign(invoice, { number });
    // A reverse-charge invoice bills nothing, so nothing is owed and nothing is posted.
    if (invoice.totalPaise > 0) {
      await recordEntry(
        {
          customerCode,
          kind: 'invoice',
          amount: invoice.totalPaise / 100,
          reference: invoice.number,
          note: `${invoice.mode} · ${invoice.lines.length} shipment(s)`,
        },
        actor,
      );
    }
    raised.push(invoice);
  }

  return { raised, skipped };
}

/** Record a payment against an invoice and move it to part-paid or paid. */
export async function recordPayment(
  customerCode: string,
  invoiceNumber: string,
  amount: number,
  reference: string,
  actor: Actor,
): Promise<Invoice> {
  const collection = await invoicesCollection();
  const invoice = await collection.findOne({ number: invoiceNumber, customerCode });
  if (!invoice) throw new Error(`Invoice ${invoiceNumber} does not exist for ${customerCode}.`);
  if (invoice.status === 'cancelled') {
    throw new Error(`Invoice ${invoiceNumber} is cancelled and cannot take a payment.`);
  }

  // Deduplicated on the payment's own reference, not the invoice: two part payments are
  // two payments, and only a repeat of the same transaction is a duplicate.
  const { duplicate } = await recordEntry(
    {
      customerCode,
      kind: 'payment',
      amount,
      reference,
      against: invoiceNumber,
      note: `Payment against ${invoiceNumber}`,
    },
    actor,
  );
  if (duplicate) return invoice;

  const paidPaise = invoice.paidPaise + Math.round(amount * 100);
  const status = statusOf(invoice, paidPaise);
  await collection.updateOne({ number: invoiceNumber }, { $set: { paidPaise, status } });

  return { ...invoice, paidPaise, status };
}
