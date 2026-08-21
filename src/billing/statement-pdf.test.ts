import { describe, expect, test } from 'vitest';
import { renderStatement } from './statement-pdf';
import type { CustomerBill, BillLine } from './statement';

const line = (over: Partial<BillLine> = {}): BillLine => ({
  reference: 'AWB-0001',
  date: new Date('2026-07-04T00:00:00Z'),
  mode: 'surface',
  origin: '110001',
  destination: '400001',
  chargeableWeight: 25,
  taxableValue: 2000,
  gst: 100,
  total: 2100,
  taxableValuePaise: 200_000,
  gstPaise: 10_000,
  totalPaise: 210_000,
  invoiceNumber: 'DNS/2026-27/000041',
  reconciliation: 'pending',
  ...over,
});

const bill = (over: Partial<CustomerBill> = {}): CustomerBill => ({
  periodId: '2026-07-01',
  from: new Date('2026-07-01T00:00:00Z'),
  to: new Date('2026-07-31T00:00:00Z'),
  status: 'due',
  dueAt: new Date('2026-08-30T00:00:00Z'),
  invoiceNumbers: ['DNS/2026-27/000041'],
  totalPaise: 210_000,
  paidPaise: 50_000,
  balancePaise: 160_000,
  disputedCount: 0,
  disputedPaise: 0,
  lines: [line()],
  ...over,
});

const read = (b: Buffer) => b.toString('latin1');

describe('the statement', () => {
  test('it is a readable PDF naming the customer and the period', () => {
    const pdf = read(renderStatement(bill(), 'Mahle Anand Filter Systems'));
    expect(pdf.startsWith('%PDF')).toBe(true);
    expect(pdf).toContain('Mahle Anand Filter Systems');
    expect(pdf).toContain('2026-07-01');
  });

  test('it says what it is not, on the page', () => {
    // Somebody will file this. It must not be filed as a tax invoice, and the tax invoices
    // it references are the real documents.
    const pdf = read(renderStatement(bill(), 'Mahle'));
    expect(pdf).toContain('STATEMENT OF CHARGES');
    expect(pdf).toContain('not a tax invoice');
    expect(pdf).toContain('DNS/2026-27/000041');
  });

  test('the money on it is the money on the bill', () => {
    const pdf = read(renderStatement(bill(), 'Mahle'));
    expect(pdf).toContain('2,100.00'); // charged
    expect(pdf).toContain('500.00');   // received
    expect(pdf).toContain('1,600.00'); // outstanding
  });

  test('a period with no charges still produces a statement that says so', () => {
    // An empty file is not an answer to "send me the bill".
    const pdf = read(renderStatement(bill({ lines: [], invoiceNumbers: [], totalPaise: 0, paidPaise: 0, balancePaise: 0 }), 'Mahle'));
    expect(pdf.startsWith('%PDF')).toBe(true);
    expect(pdf).toContain('No charges in this period');
    expect(pdf).toContain('has not been billed');
  });

  test('a disputed line shows its reason rather than only a flag', () => {
    const pdf = read(renderStatement(
      bill({ lines: [line({ reconciliation: 'disputed', disputeReason: 'Weight billed at 25kg, shipped 18' })], disputedCount: 1, disputedPaise: 210_000 }),
      'Mahle',
    ));
    expect(pdf).toContain('Weight billed at 25kg, shipped 18');
    expect(pdf).toContain('under review');
  });

  test('a long period runs onto more pages, with totals only on the last', () => {
    // A running total on page one that disagrees with the final figure is how somebody pays
    // the wrong amount.
    const many = Array.from({ length: 80 }, (_, i) => line({ reference: `AWB-${i}` }));
    const pdf = read(renderStatement(bill({ lines: many }), 'Mahle'));
    expect(pdf).toContain('/Count 3');
    expect([...pdf.matchAll(/Outstanding/g)]).toHaveLength(1);
    expect(pdf).toContain('Page 1 of 3');
  });

  test('a name with brackets does not corrupt the file', () => {
    const pdf = read(renderStatement(bill(), 'Mahle (India) Pvt Ltd'));
    expect(pdf).toContain('Mahle \\(India\\) Pvt Ltd');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  test('a restated period says it was corrected since it was billed', () => {
    const pdf = read(renderStatement(bill({ restatedByPaise: -50_000 }), 'Mahle'));
    expect(pdf).toContain('reopened and corrected');
  });
});
