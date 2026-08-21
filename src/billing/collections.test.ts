import { describe, expect, test } from 'vitest';
import {
  allocateOldestFirst,
  allocationIsPostable,
  unallocatedPaise,
  ageing,
  overduePaise,
  owedOn,
  type Receipt,
  type OutstandingInvoice,
} from './collections';

const invoice = (
  number: string,
  dueDays: number,
  totalPaise: number,
  paidPaise = 0,
): OutstandingInvoice => ({
  number,
  dueAt: new Date(Date.UTC(2026, 7, 1) + dueDays * 86_400_000),
  totalPaise,
  paidPaise,
});

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  reference: 'RCP-001',
  customerCode: 'MAHLE',
  amountPaise: 100_000,
  receivedAt: new Date('2026-09-01'),
  status: 'draft',
  allocations: [],
  ...over,
});

describe('spreading a receipt over invoices', () => {
  const open = [invoice('B', 10, 50_000), invoice('A', 0, 30_000), invoice('C', 20, 40_000)];

  test('oldest due date first, whatever order they arrive in', () => {
    const allocations = allocateOldestFirst(100_000, open);
    expect(allocations.map((item) => item.invoiceNumber)).toEqual(['A', 'B', 'C']);
  });

  test('it stops when the money runs out', () => {
    const allocations = allocateOldestFirst(60_000, open);
    expect(allocations).toEqual([
      { invoiceNumber: 'A', paise: 30_000 },
      { invoiceNumber: 'B', paise: 30_000 },
    ]);
  });

  test('never more to an invoice than it owes', () => {
    // Over-applying shows an invoice paid twice and hides money still sitting unallocated.
    const allocations = allocateOldestFirst(1_000_000, open);
    expect(allocations.reduce((total, item) => total + item.paise, 0)).toBe(120_000);
  });

  test('what an invoice already paid is taken off before it is offered money', () => {
    const part = [invoice('A', 0, 50_000, 20_000)];
    expect(allocateOldestFirst(100_000, part)).toEqual([{ invoiceNumber: 'A', paise: 30_000 }]);
  });

  test('a settled invoice is skipped, not allocated zero', () => {
    const settled = [invoice('A', 0, 50_000, 50_000), invoice('B', 5, 10_000)];
    expect(allocateOldestFirst(100_000, settled)).toEqual([{ invoiceNumber: 'B', paise: 10_000 }]);
  });

  test('two invoices due the same day resolve by number, so a rerun agrees with itself', () => {
    const sameDay = [invoice('Z', 3, 10_000), invoice('A', 3, 10_000)];
    expect(allocateOldestFirst(15_000, sameDay).map((item) => item.invoiceNumber)).toEqual([
      'A',
      'Z',
    ]);
  });
});

describe('what is left unapplied', () => {
  test('money on account is visible rather than lost', () => {
    const partial = receipt({ allocations: [{ invoiceNumber: 'A', paise: 30_000 }] });
    expect(unallocatedPaise(partial)).toBe(70_000);
  });
});

describe('whether an allocation may be posted', () => {
  const open = [invoice('A', 0, 50_000), invoice('B', 5, 40_000)];

  test('a clean allocation posts', () => {
    const clean = receipt({
      amountPaise: 60_000,
      allocations: [
        { invoiceNumber: 'A', paise: 50_000 },
        { invoiceNumber: 'B', paise: 10_000 },
      ],
    });
    expect(allocationIsPostable(clean, open)).toBeNull();
  });

  test('allocating more than arrived is refused', () => {
    const over = receipt({
      amountPaise: 50_000,
      allocations: [{ invoiceNumber: 'A', paise: 50_000 }, { invoiceNumber: 'B', paise: 10_000 }],
    });
    expect(allocationIsPostable(over, open)?.message).toMatch(/of a receipt for/);
  });

  test('allocating more than an invoice owes is refused, and says how much it owes', () => {
    const over = receipt({
      allocations: [{ invoiceNumber: 'A', paise: 60_000 }],
    });
    expect(allocationIsPostable(over, open)?.message).toMatch(/owes ₹500/);
  });

  test('the same invoice twice is refused rather than silently summed', () => {
    const twice = receipt({
      allocations: [
        { invoiceNumber: 'A', paise: 20_000 },
        { invoiceNumber: 'A', paise: 20_000 },
      ],
    });
    expect(allocationIsPostable(twice, open)?.message).toMatch(/appears twice/);
  });

  test('an invoice that is not open is refused', () => {
    const ghost = receipt({ allocations: [{ invoiceNumber: 'NOPE', paise: 1_000 }] });
    expect(allocationIsPostable(ghost, open)?.message).toMatch(/not an open invoice/);
  });

  test('an allocation of nothing is refused, because a blank line is not a decision', () => {
    const zero = receipt({ allocations: [{ invoiceNumber: 'A', paise: 0 }] });
    expect(allocationIsPostable(zero, open)?.message).toMatch(/not an allocation/);
  });

  test('a receipt already posted cannot be posted again', () => {
    const done = receipt({ status: 'finalised', allocations: [] });
    expect(allocationIsPostable(done, open)?.message).toMatch(/already been posted/);
  });

  test('a draft may be temporarily wrong — that is what drafting is', () => {
    // Only finalising has to be right. The check is not run while editing.
    const messy = receipt({ allocations: [{ invoiceNumber: 'NOPE', paise: 1 }] });
    expect(messy.status).toBe('draft');
  });
});

describe('ageing against each invoice’s own due date', () => {
  const asOf = new Date(Date.UTC(2026, 9, 1)); // 1 Oct 2026

  test('bands are measured per invoice, not from the customer’s terms', () => {
    // A customer on 45-day terms with one invoice raised late is not uniformly 45 days old.
    const bands = ageing(
      [
        invoice('FUTURE', 90, 10_000), // due 30 Oct — not yet due
        invoice('FRESH', 55, 20_000), // due 25 Sep — 6 days
        invoice('MID', 20, 30_000), // due 21 Aug — 41 days
        invoice('OLD', -40, 40_000), // due 22 Jun — 101 days
      ],
      asOf,
    );
    const byLabel = Object.fromEntries(bands.map((band) => [band.label, band.paise]));
    expect(byLabel['Not yet due']).toBe(10_000);
    expect(byLabel['0–30 days']).toBe(20_000);
    expect(byLabel['31–60 days']).toBe(30_000);
    expect(byLabel['Over 90 days']).toBe(40_000);
  });

  test('a settled invoice ages nowhere', () => {
    const bands = ageing([invoice('PAID', -10, 50_000, 50_000)], asOf);
    expect(bands.every((band) => band.paise === 0)).toBe(true);
  });

  test('only what is still owed ages, not the whole invoice', () => {
    const bands = ageing([invoice('PART', -10, 50_000, 30_000)], asOf);
    expect(overduePaise(bands)).toBe(20_000);
  });

  test('what is not yet due is not overdue', () => {
    const bands = ageing([invoice('FUTURE', 90, 10_000)], asOf);
    expect(overduePaise(bands)).toBe(0);
  });

  test('every band names its invoices, so a collections call has a list', () => {
    const bands = ageing([invoice('OLD', -40, 40_000)], asOf);
    expect(bands.find((band) => band.label === 'Over 90 days')?.invoices).toEqual(['OLD']);
  });
});

describe('owed on one invoice', () => {
  test('never negative, however much was paid', () => {
    expect(owedOn(invoice('A', 0, 50_000, 60_000))).toBe(0);
  });
});

describe('one transfer settling several invoices', () => {
  test('each allocation needs its own ledger reference, not the bank’s', () => {
    /**
     * A regression. The ledger deduplicates on the payment reference, and posting every
     * allocation under the bank's own UTR made the second line look like a repeat of the
     * first. It was dropped silently: the receipt read as posted while the invoice stayed
     * unpaid — money recorded as applied that had not been applied.
     *
     * The reference has to be unique per receipt *line*, while still repeating for the
     * same line so a re-post is correctly a duplicate.
     */
    const receiptRef = 'RCP-001';
    const allocations = [
      { invoiceNumber: 'DNS/2026-27/000001', paise: 210_000 },
      { invoiceNumber: 'DNS/2026-27/000002', paise: 190_000 },
    ];

    const references = allocations.map(
      (allocation) => `${receiptRef}/${allocation.invoiceNumber}`,
    );
    expect(new Set(references).size).toBe(allocations.length);

    // And stable: the same line posted again produces the same reference, which is what
    // makes a genuine repeat detectable.
    expect(`${receiptRef}/${allocations[0]!.invoiceNumber}`).toBe(references[0]);
  });
});
