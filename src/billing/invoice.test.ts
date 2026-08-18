import { describe, expect, test } from 'vitest';
import { buildInvoices, invoiceNumber, type BillableShipment } from './invoice';
import { paise } from './ledger';

/**
 * Invoicing.
 *
 * One invoice per mode, not one per shipment and not one for everything. That is a tax
 * rule, not a preference: road freight is taxed at 5% under reverse charge and air at 18%
 * forward, they carry different SAC codes, and an invoice states one SAC and one treatment.
 * Mixing them produces a document that cannot be filed.
 */

const shipment = (over: Partial<BillableShipment> = {}): BillableShipment => ({
  reference: 'DKT-1001',
  date: new Date(Date.UTC(2026, 7, 3)),
  mode: 'surface',
  origin: 'PNQ',
  destination: 'NCR',
  chargeableWeight: 200,
  taxableValue: 4950,
  gst: 247.5,
  gstRate: 0.05,
  sac: '9965',
  rcm: false,
  total: 5197.5,
  ...over,
});

const period = { from: new Date(Date.UTC(2026, 7, 1)), to: new Date(Date.UTC(2026, 7, 31)) };

describe('one invoice per mode', () => {
  test('shipments on one mode make one invoice', () => {
    const invoices = buildInvoices('AMOL', [shipment(), shipment({ reference: 'DKT-1002' })], period);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.lines).toHaveLength(2);
  });

  test('two modes make two invoices, because they are taxed differently', () => {
    const invoices = buildInvoices(
      'AMOL',
      [shipment(), shipment({ reference: 'DKT-2001', mode: 'air', sac: '9968', gstRate: 0.18, rcm: false })],
      period,
    );
    expect(invoices).toHaveLength(2);
    expect(invoices.map((invoice) => invoice.mode).sort()).toEqual(['air', 'surface']);
  });

  test('each invoice states one SAC and one rate', () => {
    const [invoice] = buildInvoices('AMOL', [shipment()], period);
    expect(invoice?.sac).toBe('9965');
    expect(invoice?.gstRate).toBe(0.05);
  });

  test('no shipments make no invoices, rather than an empty one', () => {
    expect(buildInvoices('AMOL', [], period)).toEqual([]);
  });
});

describe('the arithmetic', () => {
  test('totals are summed in paise, so a long invoice does not drift', () => {
    const lines = Array.from({ length: 300 }, (_, index) =>
      shipment({ reference: `DKT-${index}`, taxableValue: 0.1, gst: 0.01, total: 0.11 }),
    );
    const [invoice] = buildInvoices('AMOL', lines, period);
    expect(invoice?.taxableValuePaise).toBe(3000);
    expect(invoice?.totalPaise).toBe(3300);
  });

  test('the total is the taxable value plus the tax', () => {
    const [invoice] = buildInvoices('AMOL', [shipment(), shipment({ reference: 'DKT-1002' })], period);
    expect(invoice?.taxableValuePaise).toBe(paise(9900));
    expect(invoice?.gstPaise).toBe(paise(495));
    expect(invoice?.totalPaise).toBe(paise(10395));
  });

  test('a reverse-charge invoice bills no tax but still states the rate', () => {
    const [invoice] = buildInvoices(
      'AMOL',
      [shipment({ rcm: true, gst: 0, total: 4950 })],
      period,
    );
    expect(invoice?.gstPaise).toBe(0);
    expect(invoice?.rcm).toBe(true);
    expect(invoice?.gstRate).toBe(0.05);
    expect(invoice?.note).toMatch(/reverse charge/i);
    expect(invoice?.totalPaise).toBe(paise(4950));
  });
});

describe('what an invoice has to carry', () => {
  const [invoice] = buildInvoices('AMOL', [shipment()], period);

  test('the customer, the period and the mode', () => {
    expect(invoice?.customerCode).toBe('AMOL');
    expect(invoice?.periodFrom).toEqual(period.from);
    expect(invoice?.mode).toBe('surface');
  });

  test('a line per shipment, identifiable by its docket', () => {
    expect(invoice?.lines[0]?.reference).toBe('DKT-1001');
    expect(invoice?.lines[0]?.origin).toBe('PNQ');
    expect(invoice?.lines[0]?.destination).toBe('NCR');
    expect(invoice?.lines[0]?.chargeableWeight).toBe(200);
  });

  test('it starts unpaid, with nothing settled against it', () => {
    expect(invoice?.status).toBe('unpaid');
    expect(invoice?.paidPaise).toBe(0);
  });
});

describe('invoice numbers', () => {
  test('carry the customer, the period and the mode, so they sort and read', () => {
    const number = invoiceNumber('AMOL', 'surface', period.from);
    expect(number).toBe('INV-AMOL-202608-SURFACE');
  });

  test('two modes in one period never collide', () => {
    expect(invoiceNumber('AMOL', 'air', period.from)).not.toBe(
      invoiceNumber('AMOL', 'surface', period.from),
    );
  });

  test('the same customer, mode and period is always the same number', () => {
    // Which is what makes raising a period twice detectable rather than duplicated.
    expect(invoiceNumber('AMOL', 'air', period.from)).toBe(
      invoiceNumber('AMOL', 'air', new Date(Date.UTC(2026, 7, 28))),
    );
  });
});

describe('mixed rates within a mode', () => {
  /**
   * A rate change mid-period would otherwise produce one invoice claiming a single rate
   * while its lines were taxed at two. That is a wrong document, so it is refused.
   */
  test('two GST rates on one mode are refused rather than averaged', () => {
    expect(() =>
      buildInvoices(
        'AMOL',
        [shipment(), shipment({ reference: 'DKT-1002', gstRate: 0.12 })],
        period,
      ),
    ).toThrow(/two GST rates/i);
  });

  test('the error names the mode and both rates, so it can be acted on', () => {
    expect(() =>
      buildInvoices('AMOL', [shipment(), shipment({ reference: 'X', gstRate: 0.12 })], period),
    ).toThrow(/surface/i);
  });
});
