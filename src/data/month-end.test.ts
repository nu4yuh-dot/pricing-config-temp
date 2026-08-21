import { describe, expect, test } from 'vitest';
import { lastClosedMonth } from './month-end';

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('which month a schedule means by "last month"', () => {
  test('firing on the 1st means the month that just ended', () => {
    // A scheduler firing at 02:00 on 1 August means July, and should not have to work out
    // the boundaries itself.
    const { from, to } = lastClosedMonth(new Date('2026-08-01T02:00:00Z'));
    expect(iso(from)).toBe('2026-07-01');
    expect(iso(to)).toBe('2026-07-31');
  });

  test('it lands on the real last day, not on the 30th of every month', () => {
    expect(iso(lastClosedMonth(new Date('2026-03-01T02:00:00Z')).to)).toBe('2026-02-28');
    expect(iso(lastClosedMonth(new Date('2026-05-01T02:00:00Z')).to)).toBe('2026-04-30');
    expect(iso(lastClosedMonth(new Date('2026-07-01T02:00:00Z')).to)).toBe('2026-06-30');
  });

  test('a leap February is 29 days', () => {
    expect(iso(lastClosedMonth(new Date('2028-03-01T02:00:00Z')).to)).toBe('2028-02-29');
  });

  test('January means December of the year before', () => {
    // The one that breaks if months are subtracted without touching the year.
    const { from, to } = lastClosedMonth(new Date('2027-01-01T02:00:00Z'));
    expect(iso(from)).toBe('2026-12-01');
    expect(iso(to)).toBe('2026-12-31');
  });

  test('a late run still means the same month, so a retry cannot bill a different one', () => {
    // A scheduler that missed its slot and fired on the 3rd must not silently move the
    // window; the answer depends on the month, not the day it was asked.
    for (const day of ['01', '03', '17', '28']) {
      const { from, to } = lastClosedMonth(new Date(`2026-08-${day}T09:00:00Z`));
      expect([iso(from), iso(to)]).toEqual(['2026-07-01', '2026-07-31']);
    }
  });

  test('the window is a whole month, start to end inclusive', () => {
    const { from, to } = lastClosedMonth(new Date('2026-08-01T02:00:00Z'));
    expect(from.getUTCDate()).toBe(1);
    expect(to.getUTCMonth()).toBe(from.getUTCMonth());
    expect(to > from).toBe(true);
  });
});
