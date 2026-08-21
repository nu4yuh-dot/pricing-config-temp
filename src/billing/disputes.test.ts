import { describe, expect, test } from 'vitest';
import { reopeningProposals, isLive, suggestedReason, type DisputedLine } from './disputes';
import type { BillingPeriod, PeriodState } from './periods';

const period = (state: PeriodState, customerCode = 'MAHLE'): BillingPeriod => ({
  customerCode,
  from: new Date(Date.UTC(2026, 7, 1)),
  to: new Date(Date.UTC(2026, 7, 31)),
  state,
  invoiceNumbers: [],
  restatements: [],
});

const line = (over: Partial<DisputedLine> = {}): DisputedLine => ({
  awb: 'AWB-1',
  customerCode: 'MAHLE',
  bookedAt: new Date(Date.UTC(2026, 7, 15)),
  disputeStatus: 'open',
  billedTotal: 2100,
  ...over,
});

describe('which disputes are still live', () => {
  test('open and investigating are live; resolved and rejected are settled', () => {
    expect(isLive(line({ disputeStatus: 'open' }))).toBe(true);
    expect(isLive(line({ disputeStatus: 'investigating' }))).toBe(true);
    expect(isLive(line({ disputeStatus: 'resolved' }))).toBe(false);
    expect(isLive(line({ disputeStatus: 'rejected' }))).toBe(false);
  });

  test('a settled dispute proposes nothing', () => {
    expect(reopeningProposals([line({ disputeStatus: 'resolved' })], [period('billed')])).toEqual([]);
  });
});

describe('only a billed period needs reopening', () => {
  test('a dispute in a billed period proposes one', () => {
    const proposals = reopeningProposals([line()], [period('billed')]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.disputedAmount).toBe(2100);
  });

  test('a dispute in an open period proposes nothing — the bill has not been raised', () => {
    // The cheap case: correct it before anybody sees it, with no ceremony.
    expect(reopeningProposals([line()], [period('open')])).toEqual([]);
  });

  test('a relocked period can be reopened again, so it still proposes', () => {
    expect(reopeningProposals([line()], [period('relocked')])).toHaveLength(1);
  });

  test('a period already reopened proposes nothing — somebody is on it', () => {
    expect(reopeningProposals([line()], [period('reopened')])).toEqual([]);
  });
});

describe('what falls inside a period', () => {
  test('a shipment booked outside the window is not part of it', () => {
    const outside = line({ bookedAt: new Date(Date.UTC(2026, 8, 5)) });
    expect(reopeningProposals([outside], [period('billed')])).toEqual([]);
  });

  test('the boundary days are inside', () => {
    const first = line({ bookedAt: new Date(Date.UTC(2026, 7, 1)) });
    const last = line({ awb: 'AWB-2', bookedAt: new Date(Date.UTC(2026, 7, 31)) });
    expect(reopeningProposals([first, last], [period('billed')])[0]?.lines).toHaveLength(2);
  });

  test('another customer’s dispute does not touch this period', () => {
    const other = line({ customerCode: 'OTHER' });
    expect(reopeningProposals([other], [period('billed', 'MAHLE')])).toEqual([]);
  });
});

describe('what is under dispute', () => {
  test('a line disputed with no amount is disputed in full', () => {
    // The customer is rejecting the line, not haggling over part of it.
    const proposals = reopeningProposals([line({ billedTotal: 2100 })], [period('billed')]);
    expect(proposals[0]?.disputedAmount).toBe(2100);
  });

  test('a partial dispute counts only the part', () => {
    const proposals = reopeningProposals(
      [line({ billedTotal: 2100, amount: 500 })],
      [period('billed')],
    );
    expect(proposals[0]?.disputedAmount).toBe(500);
  });

  test('several lines in one period become one proposal, summed', () => {
    const proposals = reopeningProposals(
      [line({ awb: 'A', billedTotal: 1000 }), line({ awb: 'B', billedTotal: 2000 })],
      [period('billed')],
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.disputedAmount).toBe(3000);
    expect(proposals[0]?.lines).toHaveLength(2);
  });

  test('proposals are ordered by how much is at stake', () => {
    const periods = [period('billed', 'A'), period('billed', 'B')];
    const proposals = reopeningProposals(
      [
        line({ customerCode: 'A', billedTotal: 500 }),
        line({ customerCode: 'B', billedTotal: 9000 }),
      ],
      periods,
    );
    expect(proposals.map((item) => item.customerCode)).toEqual(['B', 'A']);
  });
});

describe('the reason offered to whoever reopens it', () => {
  test('it carries the customer’s own words', () => {
    const reason = suggestedReason({
      customerCode: 'MAHLE',
      periodFrom: new Date(),
      lines: [line({ reason: 'Delivered short by two boxes.' })],
      disputedAmount: 2100,
      suggestedReason: '',
    });
    expect(reason).toContain('Delivered short by two boxes.');
    expect(reason).toContain('1 line disputed');
  });

  test('an identical reason repeated is said once, not five times', () => {
    const same = Array.from({ length: 5 }, (_, at) =>
      line({ awb: `A${at}`, reason: 'Rate does not match the contract.' }),
    );
    const reason = suggestedReason({
      customerCode: 'MAHLE',
      periodFrom: new Date(),
      lines: same,
      disputedAmount: 10500,
      suggestedReason: '',
    });
    expect(reason.match(/Rate does not match/g)).toHaveLength(1);
    expect(reason).toContain('5 lines disputed');
  });

  test('no reason given says so rather than trailing off', () => {
    const reason = suggestedReason({
      customerCode: 'MAHLE',
      periodFrom: new Date(),
      lines: [line()],
      disputedAmount: 2100,
      suggestedReason: '',
    });
    expect(reason).toContain('No reason given.');
  });
});
