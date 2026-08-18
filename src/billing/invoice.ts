import { paise } from './ledger';

/**
 * Invoicing.
 *
 * **One invoice per mode.** This is a tax rule rather than a preference: road freight is
 * GTA at 5% and, under reverse charge, is not billed at all; air cargo is 18% forward. They
 * carry different SAC codes and different treatments, and an invoice states one SAC and one
 * treatment. A document mixing them cannot be filed, so the grouping is enforced here and
 * two rates inside one mode are refused rather than averaged.
 *
 * Every figure is held in paise, for the reason set out in `ledger.ts`: an invoice is a sum
 * of many lines, and that is exactly where floating-point rupees go wrong.
 */

export type InvoiceStatus = 'unpaid' | 'part-paid' | 'paid' | 'cancelled';

/** One priced shipment, ready to bill. Rupees in, because that is what a quote produces. */
export interface BillableShipment {
  /** The docket or AWB number, which is how a customer queries a line. */
  reference: string;
  date: Date;
  mode: string;
  origin: string;
  destination: string;
  chargeableWeight: number;
  taxableValue: number;
  gst: number;
  gstRate: number;
  sac: string;
  rcm: boolean;
  total: number;
}

export interface InvoiceLine {
  reference: string;
  date: Date;
  origin: string;
  destination: string;
  chargeableWeight: number;
  taxableValuePaise: number;
  gstPaise: number;
  totalPaise: number;
}

export interface Invoice {
  number: string;
  customerCode: string;
  mode: string;
  periodFrom: Date;
  periodTo: Date;
  raisedAt: Date;
  sac: string;
  gstRate: number;
  rcm: boolean;
  lines: InvoiceLine[];
  taxableValuePaise: number;
  gstPaise: number;
  totalPaise: number;
  paidPaise: number;
  status: InvoiceStatus;
  /** Present when something about the tax treatment has to be stated on the document. */
  note?: string;
}

export interface Period {
  from: Date;
  to: Date;
}

/**
 * A stable, readable invoice number.
 *
 * Deterministic on purpose: raising the same customer, mode and period twice produces the
 * same number, so a duplicate run is detectable instead of quietly billing twice.
 */
export function invoiceNumber(customerCode: string, mode: string, periodStart: Date): string {
  const year = periodStart.getUTCFullYear();
  const month = String(periodStart.getUTCMonth() + 1).padStart(2, '0');
  return `INV-${customerCode.toUpperCase()}-${year}${month}-${mode.toUpperCase()}`;
}

export function buildInvoices(
  customerCode: string,
  shipments: BillableShipment[],
  period: Period,
  raisedAt: Date = new Date(),
): Invoice[] {
  const byMode = new Map<string, BillableShipment[]>();
  for (const shipment of shipments) {
    const existing = byMode.get(shipment.mode);
    if (existing) existing.push(shipment);
    else byMode.set(shipment.mode, [shipment]);
  }

  const invoices: Invoice[] = [];

  for (const [mode, group] of byMode) {
    const first = group[0];
    if (!first) continue;

    // A rate change mid-period would produce a document claiming one rate over lines taxed
    // at two. Refused, named, and left for someone to split by period.
    const rates = [...new Set(group.map((shipment) => shipment.gstRate))];
    if (rates.length > 1) {
      throw new Error(
        `Cannot raise one ${mode} invoice over two GST rates ` +
          `(${rates.map((rate) => `${(rate * 100).toFixed(0)}%`).join(' and ')}). ` +
          `Split the period at the date the rate changed.`,
      );
    }

    const lines: InvoiceLine[] = group.map((shipment) => ({
      reference: shipment.reference,
      date: shipment.date,
      origin: shipment.origin,
      destination: shipment.destination,
      chargeableWeight: shipment.chargeableWeight,
      taxableValuePaise: paise(shipment.taxableValue),
      gstPaise: paise(shipment.gst),
      totalPaise: paise(shipment.total),
    }));

    const sum = (pick: (line: InvoiceLine) => number) =>
      lines.reduce((total, line) => total + pick(line), 0);

    const rcm = first.rcm;

    invoices.push({
      number: invoiceNumber(customerCode, mode, period.from),
      customerCode,
      mode,
      periodFrom: period.from,
      periodTo: period.to,
      raisedAt,
      sac: first.sac,
      gstRate: first.gstRate,
      rcm,
      lines,
      taxableValuePaise: sum((line) => line.taxableValuePaise),
      gstPaise: sum((line) => line.gstPaise),
      totalPaise: sum((line) => line.totalPaise),
      paidPaise: 0,
      status: 'unpaid',
      ...(rcm
        ? {
            note:
              `GST ${(first.gstRate * 100).toFixed(0)}% under reverse charge (SAC ${first.sac}) — ` +
              `payable by the consignee under section 9(3), not charged on this invoice.`,
          }
        : {}),
    });
  }

  return invoices;
}

/** How an invoice stands once payments are applied. */
export function statusOf(invoice: Invoice, paidPaise: number): InvoiceStatus {
  if (paidPaise <= 0) return 'unpaid';
  if (paidPaise >= invoice.totalPaise) return 'paid';
  return 'part-paid';
}
