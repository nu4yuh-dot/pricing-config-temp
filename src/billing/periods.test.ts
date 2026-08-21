import { describe, expect, test } from 'vitest';
import {
  isFrozen,
  canAttribute,
  canBill,
  canReopen,
  canRelock,
  restatementFor,
  restatementNote,
  netRestatementPaise,
  type BillingPeriod,
  type PeriodState,
} from './periods';

const period = (state: PeriodState, over: Partial<BillingPeriod> = {}): BillingPeriod => ({
  customerCode: 'MAHLE',
  from: new Date('2026-08-01'),
  to: new Date('2026-08-31'),
  state,
  invoiceNumbers: [],
  restatements: [],
  ...over,
});

describe('what freezing protects', () => {
  test('billed and relocked are frozen; open and reopened are not', () => {
    expect(isFrozen('billed')).toBe(true);
    expect(isFrozen('relocked')).toBe(true);
    expect(isFrozen('open')).toBe(false);
    expect(isFrozen('reopened')).toBe(false);
  });

  test('a shipment cannot land in a billed period', () => {
    // The whole point: a bill the customer has seen must not quietly grow.
    const refusal = canAttribute(period('billed'));
    expect(refusal?.message).toMatch(/has been billed/);
  });

  test('and the refusal says where the shipment should go instead', () => {
    // "No" without a next step just moves the problem to whoever is holding the shipment.
    expect(canAttribute(period('billed'))?.message).toMatch(/open period, or reopen/);
  });

  test('a reopened period accepts shipments again — that is what reopening is for', () => {
    expect(canAttribute(period('reopened'))).toBeNull();
  });

  test('a relocked period refuses, and says to reopen rather than repeating itself', () => {
    expect(canAttribute(period('relocked'))?.message).toMatch(/corrected and closed again/);
  });
});

describe('the state machine', () => {
  test('an open period can be billed; a billed one cannot be billed twice', () => {
    expect(canBill(period('open'))).toBeNull();
    expect(canBill(period('billed'))?.message).toBe('Already billed.');
  });

  test('a relocked period must be reopened before it is billed again', () => {
    expect(canBill(period('relocked'))?.message).toMatch(/Reopen it before billing/);
  });

  test('a reopened period can be billed — that is how a correction becomes invoices', () => {
    expect(canBill(period('reopened'))).toBeNull();
  });

  test('only a closed period can be reopened', () => {
    expect(canReopen(period('billed'))).toBeNull();
    expect(canReopen(period('relocked'))).toBeNull();
    expect(canReopen(period('open'))?.message).toMatch(/already open/);
    expect(canReopen(period('reopened'))?.message).toMatch(/already reopened/);
  });

  test('only a reopened period can be relocked', () => {
    expect(canRelock(period('reopened'))).toBeNull();
    for (const state of ['open', 'billed', 'relocked'] as const) {
      expect(canRelock(period(state))?.message).toMatch(/Only a reopened period/);
    }
  });
});

describe('as billed against as corrected', () => {
  const reopenedAt = new Date('2026-09-10');

  test('the original figure is what the customer was told, not what they should have been', () => {
    // Recomputing the invoices would give the other number in the comparison, not this one.
    const billed = period('reopened', { asBilledPaise: 250_000 });
    const restatement = restatementFor(billed, 310_000, 'Two shipments arrived late.', reopenedAt);
    expect(restatement.asBilledPaise).toBe(250_000);
    expect(restatement.asCorrectedPaise).toBe(310_000);
    expect(restatement.differencePaise).toBe(60_000);
  });

  test('a correction downwards is negative, and reads as less than', () => {
    const billed = period('reopened', { asBilledPaise: 250_000 });
    const restatement = restatementFor(billed, 200_000, 'A shipment was cancelled.', reopenedAt);
    expect(restatement.differencePaise).toBe(-50_000);
    expect(restatementNote(restatement)).toMatch(/₹500 less than the ₹2,500 first billed/);
  });

  test('a correction that changes nothing says so rather than showing a zero', () => {
    const billed = period('reopened', { asBilledPaise: 250_000 });
    const restatement = restatementFor(billed, 250_000, 'Reclassified a lane.', reopenedAt);
    expect(restatementNote(restatement)).toMatch(/the total is unchanged/);
  });

  test('the reason is carried into the note, because that is what gets asked', () => {
    const billed = period('reopened', { asBilledPaise: 100_000 });
    const restatement = restatementFor(billed, 120_000, 'Fuel was restated.', reopenedAt);
    expect(restatementNote(restatement)).toContain('Fuel was restated.');
  });
});

describe('a period corrected more than once', () => {
  test('the net movement is measured from the original bill, not the last correction', () => {
    // A period corrected twice has moved once: from what the customer was billed to where
    // it stands now.
    const twice = period('relocked', {
      asBilledPaise: 100_000,
      restatements: [
        {
          asBilledPaise: 100_000,
          asCorrectedPaise: 120_000,
          differencePaise: 20_000,
          reason: 'first',
          reopenedAt: new Date('2026-09-05'),
        },
        {
          asBilledPaise: 100_000,
          asCorrectedPaise: 90_000,
          differencePaise: -10_000,
          reason: 'second',
          reopenedAt: new Date('2026-09-20'),
        },
      ],
    });
    expect(netRestatementPaise(twice)).toBe(-10_000);
  });

  test('a period never corrected has moved by nothing', () => {
    expect(netRestatementPaise(period('billed', { asBilledPaise: 100_000 }))).toBe(0);
  });
});
