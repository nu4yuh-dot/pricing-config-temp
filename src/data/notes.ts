import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import { recordEntry } from './billing';
import { allocateNumber, recordGap } from './invoice-series';
import {
  correctionRoutes,
  routeFor,
  type CorrectionContext,
  type CorrectionRoute,
  type RouteOption,
} from '../billing/corrections';
import { findCustomer } from './customers';
import { periodFor } from './billing-periods';
import { isFrozen } from '../billing/periods';
import type { Invoice } from '../billing/invoice';
import type { Actor } from './workflow';

/**
 * Credit and debit notes — correcting an invoice that has already been issued.
 *
 * An issued invoice is a numbered document in a filed series. It is never edited. The
 * correction is a *second* document that references it: a credit note reduces what is
 * owed, a debit note increases it.
 *
 * The route is chosen from the amount and the state of the invoice, not offered as a
 * menu — see `billing/corrections.ts`. Letting somebody pick invites a credit note that
 * increases a bill, which is a document meaning the opposite of what it says.
 *
 * A note takes its own number from the same series as invoices. One consecutive run of
 * documents per financial year is what a series is; a note outside it would be a document
 * with no position.
 */

export interface Note {
  number: string;
  kind: 'credit-note' | 'debit-note';
  customerCode: string;
  /** The invoice this corrects. A note never stands alone. */
  against: string;
  issuedAt: Date;
  /** Always positive. The direction is in `kind`, never in the sign. */
  amountPaise: number;
  gstPaise: number;
  totalPaise: number;
  sac: string;
  gstRate: number;
  reason: string;
  issuedBy: Actor;
}

async function notes() {
  return (await db()).collection<Note>(COLLECTIONS.notes);
}

async function invoices() {
  return (await db()).collection<Invoice>(COLLECTIONS.invoices);
}

export interface IssueNoteInput {
  invoiceNumber: string;
  /** Signed, in rupees. Negative reduces the bill, positive increases it. */
  deltaRupees: number;
  reason: string;
  /** Withdrawing the invoice entirely, rather than adjusting it. */
  withdrawEntirely?: boolean;
  actor: Actor;
}

/**
 * The circumstances that decide which corrections are open on an invoice.
 *
 * Shared by the preview and the issue, so a screen cannot offer a route the issue would
 * refuse. Two of these would drift instantly if each caller assembled them itself.
 */
async function contextFor(invoice: Invoice): Promise<CorrectionContext> {
  const customer = await findCustomer(invoice.customerCode);
  const period = await periodFor(invoice.customerCode, invoice.periodFrom);
  return {
    // Nothing here tracks GST filing yet, so a filed return cannot be detected. Treated
    // as unfiled rather than assumed filed: assuming would refuse cancellations that are
    // legitimately available, which is the more damaging guess.
    filed: false,
    cancelPolicy: customer?.settlement ? 'requireApproval' : 'allow',
    periodLocked: period ? isFrozen(period.state) : false,
  };
}

/**
 * What may be done to an invoice, before anybody commits to it.
 *
 * The screen needs this because the route is **decided, not chosen** — asking to withdraw
 * an invoice that has been part-paid produces a full-value credit note instead, and finding
 * that out afterwards is how somebody issues a document they did not mean to. Each option
 * carries why it is closed, in words, so the screen can say so rather than greying a button
 * with no explanation.
 */
export async function correctionOptionsFor(invoiceNumber: string): Promise<{
  invoice: Pick<Invoice, 'number' | 'customerCode' | 'totalPaise' | 'paidPaise' | 'status'>;
  options: RouteOption[];
} | null> {
  const invoice = await (await invoices()).findOne({ number: invoiceNumber });
  if (!invoice) return null;
  return {
    invoice: {
      number: invoice.number,
      customerCode: invoice.customerCode,
      totalPaise: invoice.totalPaise,
      paidPaise: invoice.paidPaise,
      status: invoice.status,
    },
    options: correctionRoutes(invoice, await contextFor(invoice)),
  };
}

/**
 * Issues the correction, whichever it turns out to be.
 *
 * Returns the route taken as well as the document, because "I asked to cancel and got a
 * credit note" needs to be visible rather than surprising — withdrawing an invoice that
 * cannot be cancelled becomes a full-value credit note, which is the same commercial
 * effect by the route that is actually open.
 */
export async function issueCorrection(
  input: IssueNoteInput,
): Promise<{ route: CorrectionRoute; note?: Note }> {
  const invoiceCollection = await invoices();
  const invoice = await invoiceCollection.findOne({ number: input.invoiceNumber });
  if (!invoice) throw new Error(`No invoice ${input.invoiceNumber}.`);
  if (!input.reason.trim()) throw new Error('Say why this invoice is being corrected.');

  const decision = routeFor(
    invoice,
    await contextFor(invoice),
    {
      deltaPaise: Math.round(input.deltaRupees * 100),
      withdrawEntirely: input.withdrawEntirely === true,
    },
  );

  if ('refused' in decision) throw new Error(decision.refused);

  if (decision.route === 'cancel') {
    await invoiceCollection.updateOne(
      { number: invoice.number },
      { $set: { status: 'cancelled' } },
    );
    await recordAudit({
      action: 'credit-note-issued',
      actor: input.actor,
      at: new Date(),
      detail: { invoice: invoice.number, route: 'cancel', reason: input.reason },
    });
    return { route: 'cancel' };
  }

  const kind = decision.route as 'credit-note' | 'debit-note';

  /**
   * Withdrawing takes the invoice's own value, not the delta.
   *
   * A withdrawal arrives with a delta of zero — the caller is saying "all of it", not "this
   * much of it". Using that figure produced a note worth nothing, which the ledger rightly
   * refused as recording nothing. The amount is the document being withdrawn.
   *
   * Its GST is copied rather than recomputed, so the note reverses exactly what the
   * invoice charged. Recomputing could differ by a paisa on rounding, and a credit note
   * that does not exactly undo the invoice leaves a balance nobody can explain.
   */
  const amountPaise = input.withdrawEntirely
    ? invoice.taxableValuePaise
    : Math.abs(Math.round(input.deltaRupees * 100));

  // The note carries the invoice's own tax treatment. A correction to a road-freight
  // invoice is road freight — giving it a different SAC or rate would make the pair
  // irreconcilable on a return.
  const gstPaise = input.withdrawEntirely
    ? invoice.gstPaise
    : Math.round(amountPaise * invoice.gstRate);
  const issuedAt = new Date();

  const { number, sequence } = await allocateNumber(issuedAt);
  const note: Note = {
    number,
    kind,
    customerCode: invoice.customerCode,
    against: invoice.number,
    issuedAt,
    amountPaise,
    gstPaise,
    totalPaise: amountPaise + gstPaise,
    sac: invoice.sac,
    gstRate: invoice.gstRate,
    reason: input.reason,
    issuedBy: input.actor,
  };

  try {
    await (await notes()).insertOne(note);
  } catch (cause) {
    await recordGap(
      number,
      sequence,
      cause instanceof Error ? cause.message : 'note write failed',
      issuedAt,
    );
    throw cause;
  }

  /**
   * A credit note reduces what is owed; a debit note increases it.
   *
   * Posted as a ledger entry rather than by editing the invoice, because the invoice is
   * what the customer was charged and stays that way. What they owe is the invoice plus
   * every note against it — which is also why the ageing and the credit position pick this
   * up without either being taught about notes.
   */
  await recordEntry(
    {
      customerCode: invoice.customerCode,
      kind: kind === 'credit-note' ? 'credit-note' : 'debit-note',
      amount: note.totalPaise / 100,
      reference: number,
      against: invoice.number,
      note: input.reason,
    },
    input.actor,
  );

  await recordAudit({
    action: 'credit-note-issued',
    actor: input.actor,
    at: issuedAt,
    detail: {
      note: number,
      kind,
      invoice: invoice.number,
      amount: note.totalPaise / 100,
      reason: input.reason,
    },
  });

  return { route: kind, note };
}

export async function notesFor(customerCode: string): Promise<Note[]> {
  return (await notes()).find({ customerCode }).sort({ issuedAt: -1 }).toArray();
}

export async function notesAgainst(invoiceNumber: string): Promise<Note[]> {
  return (await notes()).find({ against: invoiceNumber }).sort({ issuedAt: 1 }).toArray();
}
