import { describe, expect, test } from 'vitest';
import {
  resolveSettlement,
  DEFAULT_CREDIT,
  DEFAULT_PREPAID,
  type SettlementProfile,
} from './settlement';
import { roomFor, decideBooking } from './settlement-room';
import type { CreditPosition } from './ledger';

const prepaidProfile: SettlementProfile = {
  key: 'ecom-prepaid',
  name: 'Ecommerce prepaid',
  mode: 'prepaid',
  cycle: 'perTransaction',
  onBreach: 'block',
  cancelPolicy: 'requireApproval',
  prepaid: { negativeAllowance: 0, lowBalanceAlertAt: 5_000, minRecharge: 10_000 },
};

const creditProfile: SettlementProfile = {
  key: 'oem-45',
  name: 'OEM 45-day credit',
  mode: 'credit',
  cycle: 'fortnightly',
  onBreach: 'blockWithOverride',
  cancelPolicy: 'requireApproval',
  overrideRole: 'manager',
  credit: { limit: 400_000, periodDays: 45, graceDays: 5 },
};

/** Paise in, because that is what the ledger deals in. */
const position = (over: Partial<CreditPosition> = {}): CreditPosition => ({
  limit: 0,
  outstanding: 0,
  owed: 0,
  overdue: 0,
  oldestOverdueDays: 0,
  walletBalance: 0,
  available: 0,
  overLimit: false,
  ...over,
});

describe('resolving a profile against a customer', () => {
  test('a customer with no overrides simply follows the profile', () => {
    const terms = resolveSettlement(creditProfile);
    expect(terms.mode).toBe('credit');
    expect(terms.cycle).toBe('fortnightly');
    expect(terms.credit.periodDays).toBe(45);
    expect(terms.overridden).toEqual([]);
  });

  test('an override changes one field and names it, leaving the rest following the profile', () => {
    const terms = resolveSettlement(creditProfile, { credit: { periodDays: 60 } });
    expect(terms.credit.periodDays).toBe(60);
    expect(terms.credit.limit).toBe(400_000);
    expect(terms.overridden).toEqual(['credit.periodDays']);
  });

  test('an override equal to the profile is not an override', () => {
    // Otherwise every screen that writes the whole form back would report a customer as
    // having negotiated terms identical to the profile they are on.
    const terms = resolveSettlement(creditProfile, { credit: { periodDays: 45 }, cycle: 'fortnightly' });
    expect(terms.overridden).toEqual([]);
  });

  test('both sub-objects are always present, so a caller need not test the mode first', () => {
    const terms = resolveSettlement(prepaidProfile);
    expect(terms.credit).toEqual(DEFAULT_CREDIT);
    expect(resolveSettlement(creditProfile).prepaid).toEqual(DEFAULT_PREPAID);
  });
});

describe('how much room there is', () => {
  test('prepaid room is the balance, and the allowance is how far past it a booking may go', () => {
    const flat = roomFor(resolveSettlement(prepaidProfile), position({ walletBalance: 50_000 }));
    expect(flat.paise).toBe(50_000);

    const withAllowance = roomFor(
      resolveSettlement(prepaidProfile, { prepaid: { negativeAllowance: 200 } }),
      position({ walletBalance: 50_000 }),
    );
    expect(withAllowance.paise).toBe(50_000 + 20_000);
  });

  test('credit room is the limit less what is outstanding', () => {
    const room = roomFor(
      resolveSettlement(creditProfile),
      position({ outstanding: 15_000_000 }),
    );
    // 400,000 rupees of limit, 150,000 rupees outstanding.
    expect(room.paise).toBe(40_000_000 - 15_000_000);
  });

  test('a credit customer already past the limit has negative room, not zero', () => {
    // Zero would read as "nothing available"; negative is the truth, and the shortfall on
    // the next booking has to include the amount already over.
    const room = roomFor(resolveSettlement(creditProfile), position({ outstanding: 45_000_000 }));
    expect(room.paise).toBeLessThan(0);
  });
});

describe('whether a booking may go ahead', () => {
  test('within room, it goes ahead', () => {
    const decision = decideBooking(
      resolveSettlement(prepaidProfile),
      position({ walletBalance: 50_000 }),
      300,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.shortfall).toBe(0);
  });

  test('block refuses, and says what would clear it', () => {
    const decision = decideBooking(
      resolveSettlement(prepaidProfile),
      position({ walletBalance: 10_000 }),
      500,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.overridable).toBe(false);
    expect(decision.shortfall).toBe(50_000 - 10_000);
    expect(decision.clearsIf.join(' ')).toContain('recharge');
  });

  test('blockWithOverride refuses but says a named role could release it', () => {
    const decision = decideBooking(
      resolveSettlement(creditProfile),
      position({ outstanding: 40_000_000 }),
      1_000,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.overridable).toBe(true);
  });

  test('allowAndFlag lets it through and flags the account', () => {
    const decision = decideBooking(
      resolveSettlement(creditProfile, { onBreach: 'allowAndFlag' }),
      position({ outstanding: 40_000_000 }),
      1_000,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.flagged).toBe(true);
    // Still reports the breach: allowed is not the same as fine.
    expect(decision.reasons).not.toEqual([]);
  });

  test('overdue holds a credit booking even when there is room, and even on allowAndFlag', () => {
    // Money already late is a different problem from not having room, and letting late
    // payers keep booking is how an account stops being collectable at all.
    const overdue = position({ outstanding: 0, overdue: 500_000, oldestOverdueDays: 12 });
    for (const onBreach of ['block', 'blockWithOverride', 'allowAndFlag'] as const) {
      const decision = decideBooking(
        resolveSettlement(creditProfile, { onBreach }),
        overdue,
        100,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.overridable).toBe(false);
      expect(decision.reasons.join(' ')).toContain('overdue');
    }
  });

  test('a prepaid customer is never held for age, because the money went in first', () => {
    const decision = decideBooking(
      resolveSettlement(prepaidProfile),
      position({ walletBalance: 100_000, overdue: 900_000, oldestOverdueDays: 40 }),
      200,
    );
    expect(decision.allowed).toBe(true);
  });

  test('the low-balance alert fires on what is left after the booking, not before it', () => {
    const terms = resolveSettlement(prepaidProfile); // alert at 5,000 rupees
    const before = decideBooking(terms, position({ walletBalance: 600_000 }), 100);
    expect(before.lowBalance).toBe(false);

    const after = decideBooking(terms, position({ walletBalance: 600_000 }), 1_500);
    // 6,000 in, 1,500 spent, 4,500 left — at or below the 5,000 alert.
    expect(after.lowBalance).toBe(true);
  });

  test('a nil-value shipment is bookable whatever the position', () => {
    const decision = decideBooking(
      resolveSettlement(creditProfile),
      position({ outstanding: 99_000_000, overdue: 50_000_000, oldestOverdueDays: 90 }),
      0,
    );
    expect(decision.allowed).toBe(true);
  });
});
