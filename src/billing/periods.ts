/**
 * Billing periods — the window a bill covers, and whether it can still change.
 *
 * A period is not a date range. It is a claim about a set of shipments: that these are the
 * ones billed for August, that they were billed at these amounts, and that the total was
 * agreed. Once a customer has that bill, the set cannot quietly acquire another shipment.
 *
 * The states, and what each one protects:
 *
 *   open      — shipments are still landing in it. Nothing has been claimed.
 *   billed    — invoices are raised. The set is fixed; the amounts are stated.
 *   reopened  — deliberately unfixed, by somebody, for a reason, with the original kept.
 *   relocked  — closed again after a reopening, carrying the record of what changed.
 *
 * The word that matters is *deliberately*. A period does not drift back to open because a
 * late shipment arrived; somebody decides to reopen it and says why, and what the bill said
 * before is kept so the two can be compared. That comparison — as billed against as
 * corrected — is the whole reason the states exist rather than a boolean.
 */

export const PERIOD_STATES = ['open', 'billed', 'reopened', 'relocked'] as const;
export type PeriodState = (typeof PERIOD_STATES)[number];

export const PERIOD_STATE_LABELS: Record<PeriodState, string> = {
  open: 'Open — shipments still landing',
  billed: 'Billed — the set is fixed',
  reopened: 'Reopened — being corrected',
  relocked: 'Relocked — corrected and closed',
};

/** A period is frozen when nothing new may be attributed to it. */
export function isFrozen(state: PeriodState): boolean {
  return state === 'billed' || state === 'relocked';
}

export interface Restatement {
  /** What the bill said when it was first raised. */
  asBilledPaise: number;
  /** What it says now, after the corrections. */
  asCorrectedPaise: number;
  /** Signed. Positive means the customer owes more than the original bill said. */
  differencePaise: number;
  /** Why it was reopened, as recorded at the time. */
  reason: string;
  reopenedAt: Date;
  relockedAt?: Date;
}

export interface BillingPeriod {
  customerCode: string;
  from: Date;
  to: Date;
  state: PeriodState;
  /** Invoice numbers raised for this period. */
  invoiceNumbers: string[];
  /** The total when first billed. Never overwritten — it is what the customer was told. */
  asBilledPaise?: number;
  billedAt?: Date;
  /** One entry per reopening. A period corrected twice has two. */
  restatements: Restatement[];
}

export interface Refusal {
  message: string;
}

/**
 * Whether a shipment may be attributed to this period.
 *
 * The check that stops a bill from quietly growing after a customer has seen it. A late
 * shipment is not refused outright — it belongs somewhere — but it belongs in the open
 * period, or in a reopening somebody has decided on.
 */
export function canAttribute(period: BillingPeriod): Refusal | null {
  if (!isFrozen(period.state)) return null;
  return {
    message:
      period.state === 'billed'
        ? 'This period has been billed. Put the shipment in the open period, or reopen this one and say why.'
        : 'This period was corrected and closed again. Reopen it to change it further.',
  };
}

export function canBill(period: BillingPeriod): Refusal | null {
  if (period.state === 'billed') return { message: 'Already billed.' };
  if (period.state === 'relocked') {
    return { message: 'This period is closed. Reopen it before billing again.' };
  }
  return null;
}

export function canReopen(period: BillingPeriod): Refusal | null {
  if (period.state === 'open') return { message: 'This period is already open.' };
  if (period.state === 'reopened') return { message: 'This period is already reopened.' };
  return null;
}

export function canRelock(period: BillingPeriod): Refusal | null {
  if (period.state !== 'reopened') {
    return { message: 'Only a reopened period can be closed again.' };
  }
  return null;
}

/**
 * The restatement a reopening produces once it is closed.
 *
 * `asBilled` comes from the period, not from recomputing the invoices — the point is what
 * the customer was *told*, and recomputing would give what they should have been told,
 * which is the other number in the comparison, not the same one.
 */
export function restatementFor(
  period: BillingPeriod,
  asCorrectedPaise: number,
  reason: string,
  reopenedAt: Date,
  relockedAt: Date = new Date(),
): Restatement {
  const asBilled = period.asBilledPaise ?? 0;
  return {
    asBilledPaise: asBilled,
    asCorrectedPaise,
    differencePaise: asCorrectedPaise - asBilled,
    reason,
    reopenedAt,
    relockedAt,
  };
}

/**
 * How a restatement reads to a person.
 *
 * Written out because "difference: -450000" is not something anybody can act on, and the
 * direction is the part that gets misread.
 */
export function restatementNote(restatement: Restatement): string {
  const rupees = (paise: number) => `₹${Math.abs(paise / 100).toLocaleString('en-IN')}`;
  if (restatement.differencePaise === 0) {
    return `Reopened and corrected; the total is unchanged at ${rupees(restatement.asBilledPaise)}.`;
  }
  const direction = restatement.differencePaise > 0 ? 'more than' : 'less than';
  return `Restated to ${rupees(restatement.asCorrectedPaise)} — ${rupees(
    restatement.differencePaise,
  )} ${direction} the ${rupees(restatement.asBilledPaise)} first billed. ${restatement.reason}`;
}

/** Every restatement a period has been through, oldest first. */
export function restatementHistory(period: BillingPeriod): Restatement[] {
  return [...period.restatements].sort(
    (a, b) => a.reopenedAt.getTime() - b.reopenedAt.getTime(),
  );
}

/** The net effect of every correction since the original bill. */
export function netRestatementPaise(period: BillingPeriod): number {
  if (period.restatements.length === 0) return 0;
  const latest = restatementHistory(period).at(-1)!;
  // Against the original, not against the previous restatement: a period corrected twice
  // has moved once, from what the customer was billed to where it now stands.
  return latest.asCorrectedPaise - (period.asBilledPaise ?? 0);
}
