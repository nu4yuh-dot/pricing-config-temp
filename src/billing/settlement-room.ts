import { paise, formatRupees, type CreditPosition } from './ledger';
import type { EffectiveSettlement } from './settlement';
import { BREACH_EFFECTS } from './settlement';

/**
 * The half of settlement that needs to know a balance.
 *
 * Separated from the types and labels so a screen can import those without dragging the
 * ledger — and `node:crypto` with it — into a browser bundle.
 */

export interface Room {
  /** What is available, in paise. Negative means already past the arrangement. */
  paise: number;
  /** How that figure was arrived at, for showing an operator. */
  why: string;
}

/**
 * How much room a customer has.
 *
 * Prepaid and credit are not two spellings of one sum. On prepaid the balance is money
 * paid in and the allowance is how far past it a booking may go. On credit the balance
 * *is* the outstanding, as a negative, and the limit is how negative it may get.
 */
export function roomFor(terms: EffectiveSettlement, position: CreditPosition): Room {
  if (terms.mode === 'prepaid') {
    const allowance = paise(terms.prepaid.negativeAllowance);
    return {
      paise: position.walletBalance + allowance,
      why: allowance
        ? `a balance of ₹${formatRupees(position.walletBalance)} plus a ₹${formatRupees(allowance)} negative allowance`
        : `a balance of ₹${formatRupees(position.walletBalance)}, with no negative allowance`,
    };
  }

  const limit = paise(terms.credit.limit);
  const outstanding = Math.max(position.outstanding, 0);
  return {
    paise: limit - outstanding,
    why: `a ₹${formatRupees(limit)} limit less ₹${formatRupees(outstanding)} outstanding`,
  };
}

export interface SettlementDecision {
  allowed: boolean;
  /** True when a named role could release this one booking. */
  overridable: boolean;
  /** True when the booking proceeded only because the profile allows exceeding. */
  flagged: boolean;
  room: number;
  shortfall: number;
  /** Prepaid only: the balance after this booking is at or below the alert level. */
  lowBalance: boolean;
  reasons: string[];
  /** What would make this bookable. Empty when it already is. */
  clearsIf: string[];
}

/**
 * May this booking go ahead?
 *
 * Overdue is checked before room, and on credit only: money already late is a different
 * problem from not having room, and paying it is the only thing that clears it. On prepaid
 * there is nothing to be late with — the money is in first.
 */
export function decideBooking(
  terms: EffectiveSettlement,
  position: CreditPosition,
  amount: number,
): SettlementDecision {
  const needed = paise(amount);
  const room = roomFor(terms, position);
  const shortfall = needed - room.paise;
  const withinRoom = shortfall <= 0;
  const heldForAge = terms.mode === 'credit' && position.overdue > 0;

  const lowBalance =
    terms.mode === 'prepaid' &&
    terms.prepaid.lowBalanceAlertAt !== null &&
    position.walletBalance - needed <= paise(terms.prepaid.lowBalanceAlertAt);

  if (needed <= 0 || (withinRoom && !heldForAge)) {
    return {
      allowed: true,
      overridable: false,
      flagged: false,
      room: room.paise,
      shortfall: 0,
      lowBalance,
      reasons: [],
      clearsIf: [],
    };
  }

  const reasons: string[] = [];
  const clearsIf: string[] = [];

  if (!withinRoom) {
    reasons.push(
      `₹${formatRupees(needed)} exceeds the ₹${formatRupees(Math.max(room.paise, 0))} available ` +
        `(${room.why}) by ₹${formatRupees(shortfall)}.`,
    );
    clearsIf.push(
      terms.mode === 'prepaid'
        ? `a recharge of ₹${formatRupees(shortfall)} or more`
        : `₹${formatRupees(shortfall)} of the outstanding paid, or a higher limit approved`,
    );
  }

  if (heldForAge) {
    reasons.push(
      `₹${formatRupees(position.overdue)} is overdue by ${position.oldestOverdueDays} days.`,
    );
    clearsIf.push(`the ₹${formatRupees(position.overdue)} overdue settled`);
  }

  const effect = BREACH_EFFECTS[terms.onBreach];

  // Being overdue is never waved through by a breach action: `allowAndFlag` is about not
  // having room, not about money already late. Letting late payers keep booking is how an
  // account reaches the point of not being collectable at all.
  const allowed = effect.allows && !heldForAge;

  return {
    allowed,
    overridable: effect.overridable && !heldForAge,
    flagged: allowed,
    room: room.paise,
    shortfall: Math.max(shortfall, 0),
    lowBalance,
    reasons,
    clearsIf,
  };
}
