import { describe, expect, test } from 'vitest';
import {
  balance,
  bookability,
  creditPosition,
  entry,
  paise,
  rupees,
  reverseOf,
  statement,
  ageing,
  type LedgerEntry,
} from './ledger';

/**
 * The money ledger.
 *
 * Two rules the tests below exist to hold:
 *
 *  1. Money is integer paise. A wallet is summed thousands of times over its life, and
 *     rupees as floating point drift — 0.1 + 0.2 is not 0.3 — so the drift would land in
 *     somebody's balance.
 *  2. The ledger is append-only. A wrong entry is corrected by a reversing entry, never by
 *     editing or deleting, because a balance nobody can reconstruct is not a balance.
 */

const at = (day: number) => new Date(Date.UTC(2026, 7, day));

const recharge = (amount: number, day = 1) =>
  entry({ customerCode: 'AMOL', kind: 'recharge', amount, reference: `RCG-${day}`, at: at(day) });

const invoice = (amount: number, day = 2) =>
  entry({ customerCode: 'AMOL', kind: 'invoice', amount, reference: `INV-${day}`, at: at(day) });

describe('money is integer paise', () => {
  test('rupees convert to paise exactly', () => {
    expect(paise(1234.56)).toBe(123456);
    expect(paise(0.1)).toBe(10);
    expect(paise(5197.5)).toBe(519750);
  });

  test('a fraction of a paisa is rounded, not silently truncated', () => {
    expect(paise(0.005)).toBe(1);
    expect(paise(0.004)).toBe(0);
  });

  test('paise convert back to rupees', () => {
    expect(rupees(123456)).toBe(1234.56);
    expect(rupees(0)).toBe(0);
  });

  /** The reason for all of this: the same sum in rupees does not come out right. */
  test('summing in paise does not drift the way rupees do', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(rupees(paise(0.1) + paise(0.2))).toBe(0.3);
  });
});

describe('balance', () => {
  test('an empty ledger is zero, not undefined', () => {
    expect(balance([])).toBe(0);
  });

  test('a recharge adds and an invoice subtracts', () => {
    expect(balance([recharge(10000), invoice(3000)])).toBe(paise(7000));
  });

  test('a payment is money in, the same as a recharge', () => {
    // One account, not a wallet plus a separate receivable: a customer billed 3,000 who
    // then pays that 3,000 separately is left with the 10,000 they paid in advance.
    const entries = [recharge(10000), invoice(3000), entry({
      customerCode: 'AMOL',
      kind: 'payment',
      amount: 3000,
      reference: 'UTR-1',
      against: 'INV-2',
      at: at(3),
    })];
    expect(balance(entries)).toBe(paise(10000));
  });

  test('a balance can go negative, because a credit customer bills before paying', () => {
    expect(balance([invoice(3000)])).toBe(paise(-3000));
  });

  test('a thousand small movements still sum exactly', () => {
    const entries: LedgerEntry[] = [];
    for (let index = 0; index < 1000; index++) entries.push(recharge(0.01, 1));
    expect(balance(entries)).toBe(1000);
    expect(rupees(balance(entries))).toBe(10);
  });
});

describe('entries are append-only', () => {
  test('an entry carries what it is for, so a balance can be explained', () => {
    const one = recharge(5000);
    expect(one.kind).toBe('recharge');
    expect(one.reference).toBe('RCG-1');
    expect(one.amountPaise).toBe(500000);
  });

  test('a negative amount is refused: direction comes from the kind', () => {
    expect(() => recharge(-100)).toThrow(/negative/i);
  });

  test('a zero-value entry is refused, because it records nothing', () => {
    expect(() => recharge(0)).toThrow(/zero/i);
  });

  test('a mistake is corrected by a reversal that names the entry it undoes', () => {
    const wrong = recharge(5000);
    const fix = reverseOf(wrong, 'keyed twice');
    expect(fix.kind).toBe('reversal');
    expect(fix.reversalOf).toBe(wrong.id);
    expect(fix.note).toContain('keyed twice');
    expect(balance([wrong, fix])).toBe(0);
  });

  test('a reversal of a reversal is refused, so an entry cannot be un-undone', () => {
    const fix = reverseOf(recharge(5000), 'keyed twice');
    expect(() => reverseOf(fix, 'changed my mind')).toThrow(/reversal/i);
  });

  test('every entry has an id, so a reversal has something to point at', () => {
    expect(recharge(1).id).not.toBe(recharge(1).id);
  });
});

describe('creditPosition', () => {
  const terms = { creditLimit: 50000, paymentTermsDays: 45 };

  test('an unpaid invoice consumes credit', () => {
    const position = creditPosition(terms, [invoice(20000)], at(10));
    expect(position.outstanding).toBe(paise(20000));
    expect(position.available).toBe(paise(30000));
  });

  test('paying an invoice releases the credit again', () => {
    const entries = [
      invoice(20000),
      entry({ customerCode: 'AMOL', kind: 'payment', amount: 20000, reference: 'UTR-1', against: 'INV-2', at: at(5) }),
    ];
    const position = creditPosition(terms, entries, at(10));
    expect(position.outstanding).toBe(0);
    expect(position.available).toBe(paise(50000));
  });

  test('a part payment releases only what was paid', () => {
    const entries = [
      invoice(20000),
      entry({ customerCode: 'AMOL', kind: 'payment', amount: 8000, reference: 'UTR-1', against: 'INV-2', at: at(5) }),
    ];
    expect(creditPosition(terms, entries, at(10)).outstanding).toBe(paise(12000));
  });

  test('a wallet balance does not count as credit, and credit is not spendable cash', () => {
    const position = creditPosition(terms, [recharge(9000)], at(10));
    expect(position.walletBalance).toBe(paise(9000));
    expect(position.available).toBe(paise(50000));
  });

  test('no credit limit means no credit, not unlimited credit', () => {
    const position = creditPosition({ creditLimit: null, paymentTermsDays: 30 }, [], at(10));
    expect(position.limit).toBe(0);
    expect(position.available).toBe(0);
  });

  test('credit already exceeded reports zero available, never a negative headroom', () => {
    const position = creditPosition(terms, [invoice(70000)], at(10));
    expect(position.available).toBe(0);
    expect(position.overLimit).toBe(true);
  });

  /** Payment terms are what makes an invoice overdue, and overdue money is the real risk. */
  test('an invoice past its payment terms is reported overdue', () => {
    const position = creditPosition(terms, [invoice(20000, 2)], new Date(Date.UTC(2026, 9, 1)));
    expect(position.overdue).toBe(paise(20000));
    expect(position.oldestOverdueDays).toBeGreaterThan(45);
  });

  test('an invoice inside its payment terms is outstanding but not overdue', () => {
    const position = creditPosition(terms, [invoice(20000, 2)], at(20));
    expect(position.outstanding).toBe(paise(20000));
    expect(position.overdue).toBe(0);
  });
});

describe('bookability', () => {
  const terms = { creditLimit: 50000, paymentTermsDays: 45 };
  const shipment = 12000;

  test('a prepaid customer with enough wallet can book', () => {
    const position = creditPosition({ creditLimit: null, paymentTermsDays: 0 }, [recharge(20000)], at(10));
    expect(bookability(position, shipment).allowed).toBe(true);
  });

  test('a prepaid customer without the money cannot, and is told to recharge', () => {
    const position = creditPosition({ creditLimit: null, paymentTermsDays: 0 }, [recharge(5000)], at(10));
    const check = bookability(position, shipment);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('insufficient-wallet');
    expect(check.shortfall).toBe(paise(7000));
    expect(check.message).toMatch(/recharge/i);
  });

  test('a credit customer books against the limit, not the wallet', () => {
    const position = creditPosition(terms, [], at(10));
    expect(position.walletBalance).toBe(0);
    expect(bookability(position, shipment).allowed).toBe(true);
  });

  test('a credit customer over the limit cannot book', () => {
    const position = creditPosition(terms, [invoice(45000)], at(10));
    const check = bookability(position, shipment);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('credit-limit-exceeded');
    expect(check.shortfall).toBe(paise(7000));
  });

  test('money already paid in reduces what is owed, so credit goes further', () => {
    const position = creditPosition(terms, [recharge(10000), invoice(45000)], at(10));
    // Invoiced 45,000 but 10,000 was paid in, so 35,000 is owed and 15,000 of credit is
    // left — enough for a 12,000 shipment.
    expect(position.outstanding).toBe(paise(45000));
    expect(position.owed).toBe(paise(35000));
    expect(position.available).toBe(paise(15000));
    expect(bookability(position, shipment).allowed).toBe(true);
  });

  /**
   * Overdue money stops further booking whatever the limit says. A customer 60 days late is
   * not a customer with headroom; that is how a receivable becomes a bad debt.
   */
  test('an overdue invoice blocks booking even inside the credit limit', () => {
    const position = creditPosition(terms, [invoice(5000, 2)], new Date(Date.UTC(2026, 9, 1)));
    const check = bookability(position, shipment);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('overdue');
    expect(check.message).toMatch(/overdue/i);
  });

  test('a booking of nothing is allowed, so a zero-rated job is never blocked', () => {
    const position = creditPosition({ creditLimit: null, paymentTermsDays: 0 }, [], at(10));
    expect(bookability(position, 0).allowed).toBe(true);
  });
});

describe('statement', () => {
  const entries = [recharge(10000, 1), invoice(3000, 2), recharge(1000, 3)];

  test('runs a balance down the entries, oldest first', () => {
    const rows = statement(entries);
    expect(rows.map((row) => rupees(row.balanceAfter))).toEqual([10000, 7000, 8000]);
  });

  test('orders by date regardless of the order they arrive in', () => {
    const rows = statement([entries[2]!, entries[0]!, entries[1]!]);
    expect(rows.map((row) => row.entry.reference)).toEqual(['RCG-1', 'INV-2', 'RCG-3']);
  });

  test('the closing balance is the balance', () => {
    const rows = statement(entries);
    expect(rows[rows.length - 1]?.balanceAfter).toBe(balance(entries));
  });
});

/**
 * A payment has two identities: its own transaction reference, and the invoice it settles.
 * Conflating them means a second part payment looks like a repeat of the first.
 */
describe('a payment names both itself and the invoice it settles', () => {
  const terms = { creditLimit: 50000, paymentTermsDays: 45 };

  const payment = (amount: number, reference: string, against: string, day: number) =>
    entry({ customerCode: 'AMOL', kind: 'payment', amount, reference, against, at: at(day) });

  test('two part payments against one invoice both count', () => {
    const entries = [
      invoice(20000),
      payment(8000, 'UTR-111', 'INV-2', 5),
      payment(12000, 'UTR-222', 'INV-2', 6),
    ];
    expect(creditPosition(terms, entries, at(10)).outstanding).toBe(0);
    expect(balance(entries)).toBe(0);
  });

  test('the same transaction reference twice is the same payment, not two', () => {
    const first = payment(8000, 'UTR-111', 'INV-2', 5);
    const second = payment(8000, 'UTR-111', 'INV-2', 5);
    expect(first.reference).toBe(second.reference);
    expect(first.against).toBe('INV-2');
  });

  test('a payment with no invoice named settles nothing in particular', () => {
    const onAccount = entry({
      customerCode: 'AMOL',
      kind: 'payment',
      amount: 5000,
      reference: 'UTR-999',
      at: at(5),
    });
    // It is still money in — it just does not release any one invoice.
    expect(balance([invoice(20000), onAccount])).toBe(paise(-15000));
    expect(creditPosition(terms, [invoice(20000), onAccount], at(10)).outstanding).toBe(paise(20000));
  });
});

describe('ageing', () => {
  const terms = { creditLimit: 500000, paymentTermsDays: 30 };
  const asOf = new Date('2026-08-09T00:00:00Z');
  const daysAgo = (days: number) => new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000);

  const invoice = (reference: string, rupees: number, days: number) =>
    entry({
      customerCode: 'KIRLOSKAR',
      kind: 'invoice',
      reference,
      amount: rupees,
      at: daysAgo(days),
      note: 'test',
    });

  test('an unpaid invoice lands in the bucket for its age', () => {
    const buckets = ageing(terms, [invoice('INV-1', 1000, 5), invoice('INV-2', 2000, 20)], asOf);

    expect(buckets[0]?.amountPaise).toBe(paise(1000));
    expect(buckets[1]?.amountPaise).toBe(paise(2000));
    expect(buckets[2]?.amountPaise).toBe(0);
  });

  test('a settled invoice ages out of the buckets entirely', () => {
    const buckets = ageing(
      terms,
      [
        invoice('INV-1', 1000, 5),
        entry({
          customerCode: 'KIRLOSKAR',
          kind: 'payment',
          reference: 'PAY-1',
          against: 'INV-1',
          amount: 1000,
          at: daysAgo(1),
          note: 'paid',
        }),
      ],
      asOf,
    );

    expect(buckets.every((bucket) => bucket.amountPaise === 0)).toBe(true);
  });

  test('a part payment leaves only the unpaid remainder ageing', () => {
    const buckets = ageing(
      terms,
      [
        invoice('INV-1', 1000, 5),
        entry({
          customerCode: 'KIRLOSKAR',
          kind: 'payment',
          reference: 'PAY-1',
          against: 'INV-1',
          amount: 400,
          at: daysAgo(1),
          note: 'part',
        }),
      ],
      asOf,
    );

    expect(buckets[0]?.amountPaise).toBe(paise(600));
  });

  test('whether a bucket is overdue depends on the terms, not on the bucket', () => {
    // 20 days is current on 30-day terms and a fortnight late on 5-day ones.
    const generous = ageing(terms, [invoice('INV-2', 2000, 20)], asOf);
    const tight = ageing({ ...terms, paymentTermsDays: 5 }, [invoice('INV-2', 2000, 20)], asOf);

    expect(generous[1]?.overdue).toBe(false);
    expect(tight[1]?.overdue).toBe(true);
  });

  test('ageing and the credit position are computed from the same replay', () => {
    const entries = [invoice('INV-1', 1000, 5), invoice('INV-2', 2000, 40)];
    const buckets = ageing(terms, entries, asOf);
    const total = buckets.reduce((sum, bucket) => sum + bucket.amountPaise, 0);

    expect(total).toBe(creditPosition(terms, entries, asOf).outstanding);
  });
});

/**
 * A partial `commercial` block must not turn into NaN money.
 *
 * A customer stored as `commercial: {}` reached `bookability` with `creditLimit:
 * undefined`. That is not `null`, so the no-facility branch was skipped, `paise(undefined)`
 * gave NaN, every comparison against it was silently false, and the customer was refused
 * with "This would exceed the credit limit by ₹NaN" — a real refusal, shown to a real
 * customer, computed from nothing.
 */
describe('credit terms that are missing rather than zero', () => {
  const noFacility = { creditLimit: null, paymentTermsDays: 30 };

  test('an absent credit limit is treated as no facility, not as NaN', () => {
    const absent = { paymentTermsDays: 30 } as unknown as Parameters<typeof creditPosition>[0];
    const position = creditPosition(absent, [], new Date('2026-08-22'));
    expect(Number.isFinite(position.limit)).toBe(true);
    expect(position.limit).toBe(0);
    expect(Number.isFinite(position.available)).toBe(true);
  });

  test('the refusal message never contains NaN', () => {
    const absent = { paymentTermsDays: 30 } as unknown as Parameters<typeof creditPosition>[0];
    const position = creditPosition(absent, [], new Date('2026-08-22'));
    const decision = bookability(position, 5000);
    expect(decision.allowed).toBe(false);
    expect(decision.message ?? '').not.toContain('NaN');
  });

  test('an explicit null still means no facility', () => {
    const position = creditPosition(noFacility, [], new Date('2026-08-22'));
    expect(position.limit).toBe(0);
  });
});
