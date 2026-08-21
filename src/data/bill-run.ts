import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import { raiseInvoices } from './billing';
import { billableFor, billableUnder } from './shipments';
import { findCustomer } from './customers';
import { openPeriod, periodFor, markBilled } from './billing-periods';
import { canBill } from '../billing/periods';
import type { BillableShipment } from '../billing/invoice';
import type { ShipmentDoc } from './shipments';
import type { Actor } from './workflow';

/**
 * The monthly bill run — the thing that turns shipments into invoices.
 *
 * Everything beneath this existed and was tested: what a period is, how a number is
 * allocated, how an invoice is built, what a receipt settles. What did not exist was
 * anything that *started* it, so a bill could only be raised by calling a function from a
 * script. This is that missing step.
 *
 * Deliberately explicit rather than automatic. Somebody presses it, for a named customer
 * and a named period, and can see beforehand what it would do — because a bill run that
 * fires on a timer and gets it wrong has already reached the customer by the time anybody
 * looks.
 */

export interface BillRunLine {
  awb: string;
  bookedAt: Date;
  mode: string;
  total: number;
  /** Why this shipment is not being billed, when it is not. */
  heldBecause?: string;
}

export interface BillRunPreview {
  customerCode: string;
  customerName: string;
  from: Date;
  to: Date;
  /** What stops the run, when something does. */
  refusal?: string;
  basis: string;
  billable: BillRunLine[];
  held: BillRunLine[];
  totalToBill: number;
  heldTotal: number;
}

export interface BillRunResult {
  invoiceNumbers: string[];
  shipmentsBilled: number;
  totalPaise: number;
  skipped: string[];
}

const asBillable = (shipment: ShipmentDoc): BillableShipment => ({
  reference: shipment.awb,
  date: shipment.bookedAt,
  mode: shipment.mode,
  origin: shipment.originPincode,
  destination: shipment.destinationPincode,
  chargeableWeight: shipment.chargeableWeight,
  taxableValue: shipment.booked.taxableValue,
  gst: shipment.booked.gst,
  gstRate: shipment.booked.gstRate,
  sac: shipment.booked.sac,
  rcm: shipment.booked.rcm,
  total: shipment.booked.total,
});

/**
 * Why a shipment is not being billed this run, in words.
 *
 * A held shipment is not an error and not a silence — it is a fact somebody needs, because
 * "the bill is smaller than expected" is otherwise unanswerable.
 */
function heldReason(shipment: ShipmentDoc, basis: string | undefined): string | null {
  if (shipment.status === 'cancelled') return 'Cancelled.';
  if (basis !== 'POD Verified') return null;
  if (!shipment.pod) return 'Waiting for proof of delivery.';
  if (shipment.pod.status === 'disputed') return 'The customer has disputed this line.';
  if (shipment.pod.status !== 'clear') return `Proof of delivery is ${shipment.pod.status}.`;
  return null;
}

/**
 * What the run would do, without doing it.
 *
 * The preview is not a convenience. Raising an invoice allocates a number from a series
 * that can never reuse it, so seeing the shape of the bill first is the difference between
 * a decision and a discovery.
 */
export async function previewBillRun(
  customerCode: string,
  from: Date,
  to: Date,
): Promise<BillRunPreview> {
  const customer = await findCustomer(customerCode);
  if (!customer) throw new Error(`No customer ${customerCode}.`);

  const basis = customer.enterprise?.billing?.basis;
  const shipments = await billableFor(customer.code, from, to);

  const billable: BillRunLine[] = [];
  const held: BillRunLine[] = [];

  for (const shipment of shipments) {
    const line: BillRunLine = {
      awb: shipment.awb,
      bookedAt: shipment.bookedAt,
      mode: shipment.mode,
      total: shipment.booked.total,
    };
    const reason = heldReason(shipment, basis);
    if (reason || !billableUnder(shipment, basis)) {
      held.push({ ...line, heldBecause: reason ?? 'Not billable under this basis.' });
    } else {
      billable.push(line);
    }
  }

  const period = await periodFor(customer.code, from);
  const refusal = period ? canBill(period)?.message : undefined;

  const sum = (lines: BillRunLine[]) =>
    Math.round(lines.reduce((total, line) => total + line.total, 0) * 100) / 100;

  return {
    customerCode: customer.code,
    customerName: customer.name,
    from,
    to,
    ...(refusal ? { refusal } : {}),
    basis: basis ?? 'Everything booked',
    billable,
    held,
    totalToBill: sum(billable),
    heldTotal: sum(held),
  };
}

/**
 * Raises the bill.
 *
 * Order matters and is not arbitrary. The period is opened and checked first, so a run
 * against an already-billed period stops before a number is allocated. Then the invoices —
 * which is where numbers are spent. Then the shipments are marked billed, so a second run
 * cannot bill them again. Then the period.
 *
 * If the shipment marking failed after invoices were raised, the invoices would still
 * exist and the shipments would look unbilled — which is why they carry the invoice number
 * rather than only a status: the damage is visible instead of invisible.
 */
export async function runBilling(
  customerCode: string,
  from: Date,
  to: Date,
  actor: Actor,
): Promise<BillRunResult> {
  const preview = await previewBillRun(customerCode, from, to);
  if (preview.refusal) throw new Error(preview.refusal);
  if (preview.billable.length === 0) {
    throw new Error(
      preview.held.length > 0
        ? `Nothing can be billed yet — all ${preview.held.length} shipment(s) are held. ${preview.held[0]!.heldBecause}`
        : 'No shipments in this period.',
    );
  }

  await openPeriod(customerCode, from, to);

  const shipments = await billableFor(customerCode, from, to);
  const billing = shipments.filter((shipment) =>
    preview.billable.some((line) => line.awb === shipment.awb),
  );

  const { raised, skipped } = await raiseInvoices(
    customerCode,
    billing.map(asBillable),
    { from, to },
    actor,
  );

  const numbers = raised.map((invoice) => invoice.number);
  const totalPaise = raised.reduce((total, invoice) => total + invoice.totalPaise, 0);

  // Marked billed and stamped with the invoice they went onto, so a shipment can never be
  // billed twice and can always be traced to the document that charged for it.
  const collection = (await db()).collection<ShipmentDoc>(COLLECTIONS.shipments);
  for (const invoice of raised) {
    for (const line of invoice.lines) {
      await collection.updateOne(
        { awb: line.reference },
        { $set: { status: 'billed', invoiceNumber: invoice.number } },
      );
    }
  }

  await markBilled(customerCode, from, numbers, totalPaise, actor);

  await recordAudit({
    action: 'bill-run',
    actor,
    at: new Date(),
    detail: {
      customer: customerCode,
      period: from.toISOString().slice(0, 10),
      invoices: numbers.length,
      shipments: billing.length,
      held: preview.held.length,
      total: totalPaise / 100,
    },
  });

  return {
    invoiceNumbers: numbers,
    shipmentsBilled: billing.length,
    totalPaise,
    skipped,
  };
}
