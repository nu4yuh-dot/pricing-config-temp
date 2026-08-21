import { describe, expect, test } from 'vitest';
import { buildCustomerBill, billStatus, periodIdOf, type ReconciliationMark } from './statement';
import type { Invoice, InvoiceLine } from './invoice';
import type { BillingPeriod } from './periods';

const line = (reference: string, taxablePaise: number): InvoiceLine => ({
  reference,
  date: new Date('2026-07-04T00:00:00Z'),
  origin: '110001',
  destination: '400001',
  chargeableWeight: 25,
  taxableValuePaise: taxablePaise,
  gstPaise: Math.round(taxablePaise * 0.18),
  totalPaise: taxablePaise + Math.round(taxablePaise * 0.18),
});

const invoice = (number: string, lines: InvoiceLine[], paidPaise = 0): Invoice => ({
  number,
  naturalKey: `MAHLE|surface|2026-07-01`,
  customerCode: 'MAHLE',
  mode: 'surface',
  periodFrom: new Date('2026-07-01T00:00:00Z'),
  periodTo: new Date('2026-07-31T00:00:00Z'),
  raisedAt: new Date('2026-08-01T00:00:00Z'),
  sac: '996511',
  gstRate: 0.18,
  rcm: false,
  lines,
  taxableValuePaise: lines.reduce((s, l) => s + l.taxableValuePaise, 0),
  gstPaise: lines.reduce((s, l) => s + l.gstPaise, 0),
  totalPaise: lines.reduce((s, l) => s + l.totalPaise, 0),
  paidPaise,
  status: 'unpaid',
});

const period = (over: Partial<BillingPeriod> = {}): BillingPeriod => ({
  customerCode: 'MAHLE',
  from: new Date('2026-07-01T00:00:00Z'),
  to: new Date('2026-07-31T00:00:00Z'),
  state: 'billed',
  invoiceNumbers: ['DNS/2026-27/000001'],
  restatements: [],
  ...over,
});

describe('the money on a bill', () => {
  const bill = buildCustomerBill(
    period(),
    [invoice('DNS/2026-27/000001', [line('AWB-A', 100_000), line('AWB-B', 50_123)])],
    [],
    30,
  );

  test('the paise on the lines add up to the paise on the bill, exactly', () => {
    // The property the whole shape exists to guarantee. A caller reconciling a bill sums
    // the lines; if that disagreed with the header the customer is shown two truths.
    expect(bill.lines.reduce((sum, l) => sum + l.totalPaise, 0)).toBe(bill.totalPaise);
  });

  test('rupee fields are the same money, and are not what to reconcile with', () => {
    const first = bill.lines[0]!;
    expect(first.total).toBeCloseTo(first.totalPaise / 100, 10);
    // 1,181 rupees of lines against 118,145 paise of bill: summing the wrong field is out
    // by a hundred, which is the mistake these tests exist to make loud.
    expect(bill.lines.reduce((sum, l) => sum + l.total, 0)).not.toBe(bill.totalPaise);
  });

  test('a rounded line still reconciles, because paise are carried not recomputed', () => {
    // 50,123 paise at 18% is 9,022.14 — the kind of figure that drifts if each reader
    // rounds it themselves.
    const b = bill.lines[1]!;
    expect(b.gstPaise).toBe(9_022);
    expect(b.taxableValuePaise + b.gstPaise).toBe(b.totalPaise);
  });

  test('the balance is the bill less what has been paid', () => {
    const part = buildCustomerBill(
      period(),
      [invoice('DNS/2026-27/000001', [line('AWB-A', 100_000)], 40_000)],
      [],
      30,
    );
    expect(part.balancePaise).toBe(part.totalPaise - 40_000);
  });
});

describe('what the customer sees a bill as', () => {
  const inv = invoice('DNS/2026-27/000001', [line('AWB-A', 100_000)]);

  test('an open period with nothing raised is still active', () => {
    expect(billStatus(period({ state: 'open', invoiceNumbers: [] }), [], null)).toBe('active');
  });

  test('paid in full reads as paid, whatever the due date says', () => {
    const settled = { ...inv, paidPaise: inv.totalPaise };
    const longOverdue = new Date('2020-01-01T00:00:00Z');
    expect(billStatus(period(), [settled], longOverdue)).toBe('paid');
  });

  test('past the due date and unpaid is overdue', () => {
    expect(billStatus(period(), [inv], new Date('2026-08-31T00:00:00Z'), new Date('2026-09-05T00:00:00Z')))
      .toBe('overdue');
  });

  test('a reopened period is under review, not due, even while money is outstanding', () => {
    // The figure is moving. Chasing a customer for a number about to be restated is how
    // a correction turns into a dispute.
    expect(billStatus(period({ state: 'reopened' }), [inv], new Date('2020-01-01T00:00:00Z')))
      .toBe('review');
  });
});

describe('disputes and identity', () => {
  test('a disputed line carries its reason and counts toward the disputed total', () => {
    const marks: ReconciliationMark[] = [
      { awb: 'AWB-B', state: 'disputed', reason: 'Weight billed at 25kg, shipped 18kg.', at: new Date(), by: 'ops@mahle' },
    ];
    const bill = buildCustomerBill(
      period(),
      [invoice('DNS/2026-27/000001', [line('AWB-A', 100_000), line('AWB-B', 50_000)])],
      marks,
      30,
    );
    expect(bill.disputedCount).toBe(1);
    expect(bill.lines.find((l) => l.reference === 'AWB-B')?.disputeReason).toContain('18kg');
    expect(bill.lines.find((l) => l.reference === 'AWB-A')?.reconciliation).toBe('pending');
  });

  test('the period id is the start date, so a customer can address a bill by its month', () => {
    expect(periodIdOf(new Date('2026-07-01T00:00:00Z'))).toBe('2026-07-01');
  });
});
