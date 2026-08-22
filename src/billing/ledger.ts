import { randomUUID } from 'node:crypto';

/**
 * The customer money ledger.
 *
 * Two decisions shape everything here.
 *
 * **Money is integer paise.** A wallet is summed every time it is displayed, over years of
 * entries, and rupees held as floating point drift: `0.1 + 0.2` is not `0.3`. In a pricing
 * calculation that rounds at the end this is harmless; in a running balance it accumulates
 * into somebody's money. Rupees appear only at the edges, via `paise()` and `rupees()`.
 *
 * **The ledger is append-only.** Nothing is edited and nothing is deleted. A wrong entry is
 * corrected by a reversing entry that names the one it undoes, so any balance can be
 * reconstructed from the entries that produced it. A balance nobody can reconstruct is not
 * a balance, it is a number.
 */

export const ENTRY_KINDS = [
  /** Money paid in by the customer. */
  'recharge',
  /** A bill raised against the customer. Takes the balance down and consumes credit. */
  'invoice',
  /** Money in, settling a named invoice. Releases the credit that invoice was using. */
  'payment',
  /** A manual correction with a reason, e.g. a goodwill credit. */
  'adjustment',
  /**
   * A credit note against an invoice. Reduces what the customer owes.
   *
   * Its own kind rather than an `adjustment`, because the two answer different questions.
   * An adjustment is a decision somebody made; a credit note is a tax document with a
   * number in the series, and a return has to list them separately.
   */
  'credit-note',
  /** A debit note against an invoice. Increases what the customer owes. */
  'debit-note',
  /** Money returned to the customer. */
  'refund',
  /** Undoes an earlier entry exactly. */
  'reversal',
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface LedgerEntry {
  id: string;
  customerCode: string;
  kind: EntryKind;
  /** Always positive. Direction comes from the kind, never from the sign. */
  amountPaise: number;
  /**
   * This entry's own identity: the gateway id for a recharge, the UTR for a payment, the
   * invoice number for an invoice. Unique per customer and kind, so a retried callback
   * cannot record the same money twice.
   */
  reference: string;
  /**
   * For a payment, the invoice it settles. Held apart from `reference` because a payment
   * has two identities, and conflating them makes a second part payment look like a repeat
   * of the first. Absent means paid on account, against no particular invoice.
   */
  against?: string;
  at: Date;
  note?: string;
  /** Set on a reversal: the id of the entry being undone. */
  reversalOf?: string;
  /** Set on a reversal: the direction the original moved, so it can be cancelled out. */
  reversedKind?: EntryKind;
}

/* ------------------------------------------------------------------------- money */

export function paise(amountInRupees: number): number {
  return Math.round(amountInRupees * 100);
}

export function rupees(amountInPaise: number): number {
  return amountInPaise / 100;
}

export const formatRupees = (amountInPaise: number): string =>
  rupees(amountInPaise).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/* ------------------------------------------------------------------------ entries */

export interface NewEntry {
  customerCode: string;
  kind: EntryKind;
  /** In rupees, as everything outside this module speaks rupees. */
  amount: number;
  reference: string;
  /** For a payment: the invoice being settled. */
  against?: string;
  at?: Date;
  note?: string;
}

export function entry(input: NewEntry): LedgerEntry {
  const amountPaise = paise(input.amount);
  if (amountPaise < 0) {
    throw new Error(
      `A ledger entry cannot be negative (${input.amount}). Direction comes from the kind: ` +
        `use an invoice or a refund rather than a negative recharge.`,
    );
  }
  if (amountPaise === 0) {
    throw new Error('A ledger entry of zero records nothing and is refused.');
  }

  return {
    id: randomUUID(),
    customerCode: input.customerCode,
    kind: input.kind,
    amountPaise,
    reference: input.reference,
    ...(input.against === undefined ? {} : { against: input.against }),
    at: input.at ?? new Date(),
    ...(input.note === undefined ? {} : { note: input.note }),
  };
}

/**
 * The entry that undoes another.
 *
 * A reversal cannot itself be reversed. Allowing it would make a balance a matter of
 * counting how many times an entry had been un-undone, and the correct way to restore a
 * reversed entry is to make a fresh one that says why.
 */
export function reverseOf(original: LedgerEntry, reason: string): LedgerEntry {
  if (original.kind === 'reversal') {
    throw new Error(
      'A reversal cannot be reversed. Raise a fresh entry stating why the money moves again.',
    );
  }
  return {
    id: randomUUID(),
    customerCode: original.customerCode,
    kind: 'reversal',
    amountPaise: original.amountPaise,
    reference: original.reference,
    at: new Date(),
    note: `Reverses ${original.kind} ${original.reference}: ${reason}`,
    reversalOf: original.id,
    reversedKind: original.kind,
  };
}

/* ----------------------------------------------------------------------- balances */

/**
 * How a kind moves the balance.
 *
 * There is one account, not a wallet and a separate receivable. Money in is a recharge
 * (paid in advance) or a payment (settling a bill); money out is an invoice raised or a
 * refund returned. A prepaid customer therefore runs a positive balance and simply has no
 * payment entries, while a credit customer runs negative between invoice and payment.
 *
 * Keeping them as one account is what stops a customer's exposure being counted twice —
 * money they have already paid in genuinely reduces what they owe.
 */
function walletDirection(kind: EntryKind): number {
  switch (kind) {
    case 'recharge':
    case 'payment':
    case 'adjustment':
    // A credit note reduces the bill, so it moves the balance the same way a payment does.
    case 'credit-note':
      return 1;
    case 'invoice':
    case 'refund':
    // A debit note is an additional charge, so it moves the balance like an invoice.
    case 'debit-note':
      return -1;
    case 'reversal':
      return 0;
  }
}

function movement(entry: LedgerEntry): number {
  if (entry.kind === 'reversal') {
    // Undo exactly what the original did, whichever direction that was.
    return entry.reversedKind ? -walletDirection(entry.reversedKind) * entry.amountPaise : 0;
  }
  return walletDirection(entry.kind) * entry.amountPaise;
}

/** The account balance in paise. Negative means the customer owes that much. */
export function balance(entries: LedgerEntry[]): number {
  return entries.reduce((total, item) => total + movement(item), 0);
}

export interface CreditTerms {
  /** Null means the customer has no credit facility, which is not the same as unlimited. */
  creditLimit: number | null;
  paymentTermsDays: number;
}

export interface CreditPosition {
  limit: number;
  /** Invoiced and not yet settled, invoice by invoice. */
  outstanding: number;
  /**
   * Net exposure: what the customer actually owes once money already paid in is taken off.
   * This, not `outstanding`, is what credit is measured against.
   */
  owed: number;
  /** Outstanding past the payment terms. */
  overdue: number;
  oldestOverdueDays: number;
  walletBalance: number;
  /** Credit still usable. Never negative. */
  available: number;
  overLimit: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a customer can still spend, and what they already owe.
 *
 * Outstanding is worked out per invoice reference rather than in aggregate, so that a part
 * payment releases exactly what was paid, and so an overdue invoice can be named.
 */
export function creditPosition(
  terms: CreditTerms,
  entries: LedgerEntry[],
  asOf: Date = new Date(),
): CreditPosition {
  const invoiced = new Map<string, { amount: number; at: Date }>();
  const settled = new Map<string, number>();

  for (const item of entries) {
    if (item.kind === 'invoice') {
      const existing = invoiced.get(item.reference);
      invoiced.set(item.reference, {
        amount: (existing?.amount ?? 0) + item.amountPaise,
        at: existing?.at ?? item.at,
      });
    } else if (item.kind === 'payment') {
      // Only a payment that names an invoice releases that invoice. Money paid on account
      // still reduces the balance, and so what is owed, but settles nothing in particular.
      if (item.against !== undefined) {
        settled.set(item.against, (settled.get(item.against) ?? 0) + item.amountPaise);
      }
    } else if (item.kind === 'reversal' && item.reversedKind === 'invoice') {
      settled.set(item.reference, (settled.get(item.reference) ?? 0) + item.amountPaise);
    }
  }

  let outstanding = 0;
  let overdue = 0;
  let oldestOverdueDays = 0;

  for (const [reference, bill] of invoiced) {
    const unpaid = bill.amount - (settled.get(reference) ?? 0);
    if (unpaid <= 0) continue;
    outstanding += unpaid;

    const ageDays = Math.floor((asOf.getTime() - bill.at.getTime()) / DAY_MS);
    if (ageDays > terms.paymentTermsDays) {
      overdue += unpaid;
      oldestOverdueDays = Math.max(oldestOverdueDays, ageDays);
    }
  }

  // `=== null` alone is not enough. A customer document with a partial `commercial` block
  // yields `undefined` here, `paise(undefined)` is NaN, and NaN propagates into every
  // comparison below as a silent false — the customer was refused with "exceeds the credit
  // limit by ₹NaN". Absent and null both mean no credit facility.
  const limit =
    typeof terms.creditLimit === 'number' && Number.isFinite(terms.creditLimit)
      ? paise(terms.creditLimit)
      : 0;
  const walletBalance = balance(entries);
  const owed = Math.max(0, -walletBalance);

  return {
    limit,
    outstanding,
    owed,
    overdue,
    oldestOverdueDays,
    walletBalance,
    available: Math.max(0, limit - owed),
    overLimit: owed > limit,
  };
}

/* -------------------------------------------------------------------- bookability */

export type BookingBlock = 'insufficient-wallet' | 'credit-limit-exceeded' | 'overdue';

export interface Bookability {
  allowed: boolean;
  reason?: BookingBlock;
  /** How much more is needed, in paise. */
  shortfall?: number;
  message?: string;
}

/**
 * Whether a shipment can be booked against a customer's money.
 *
 * A positive wallet balance counts towards the spend as well as the credit limit, because a
 * customer who has paid in advance has genuinely funded that much — the two are not
 * alternatives, they add.
 */
export function bookability(position: CreditPosition, shipmentValue: number): Bookability {
  const needed = paise(shipmentValue);
  if (needed <= 0) return { allowed: true };

  if (position.overdue > 0) {
    return {
      allowed: false,
      reason: 'overdue',
      shortfall: position.overdue,
      message:
        `₹${formatRupees(position.overdue)} is overdue by ${position.oldestOverdueDays} days. ` +
        `Bookings are held until the overdue amount is settled.`,
    };
  }

  const spendable = Math.max(0, position.walletBalance) + position.available;
  if (spendable >= needed) return { allowed: true };

  const shortfall = needed - spendable;
  if (position.limit === 0) {
    return {
      allowed: false,
      reason: 'insufficient-wallet',
      shortfall,
      message:
        `The wallet holds ₹${formatRupees(Math.max(0, position.walletBalance))} against a ` +
        `shipment of ₹${formatRupees(needed)}. Recharge ₹${formatRupees(shortfall)} to book.`,
    };
  }

  return {
    allowed: false,
    reason: 'credit-limit-exceeded',
    shortfall,
    message:
      `This would exceed the credit limit by ₹${formatRupees(shortfall)}. ` +
      `₹${formatRupees(position.outstanding)} of ₹${formatRupees(position.limit)} is already in use.`,
  };
}

/* ----------------------------------------------------------------------- ageing */

export interface AgeingBucket {
  label: string;
  /** Inclusive lower bound in days since the invoice was raised. */
  fromDays: number;
  /** Exclusive upper bound, or null for "and older". */
  toDays: number | null;
  amountPaise: number;
  /** True when everything in this bucket is past the agreed payment terms. */
  overdue: boolean;
}

/**
 * Unpaid invoices sorted by how long they have been unpaid.
 *
 * `creditPosition` already answers "how much is overdue"; ageing answers the different
 * question a collections conversation actually starts from — how *old* it is. The two
 * are computed from the same replay of the same entries, so they cannot disagree.
 *
 * Buckets are fixed at 0–15, 16–30 and 31+ days because that is what the business already
 * reads. Whether a bucket is overdue depends on the customer's terms, not on the bucket:
 * 20 days is current on 30-day terms and a fortnight late on 5-day ones.
 */
export function ageing(
  terms: CreditTerms,
  entries: LedgerEntry[],
  asOf: Date = new Date(),
): AgeingBucket[] {
  const invoiced = new Map<string, { amount: number; at: Date }>();
  const settled = new Map<string, number>();

  for (const item of entries) {
    if (item.kind === 'invoice') {
      const existing = invoiced.get(item.reference);
      invoiced.set(item.reference, {
        amount: (existing?.amount ?? 0) + item.amountPaise,
        at: existing?.at ?? item.at,
      });
    } else if (item.kind === 'payment' && item.against !== undefined) {
      settled.set(item.against, (settled.get(item.against) ?? 0) + item.amountPaise);
    } else if (item.kind === 'reversal' && item.reversedKind === 'invoice') {
      settled.set(item.reference, (settled.get(item.reference) ?? 0) + item.amountPaise);
    }
  }

  const buckets: AgeingBucket[] = [
    { label: '0 – 15 days', fromDays: 0, toDays: 16, amountPaise: 0, overdue: false },
    { label: '16 – 30 days', fromDays: 16, toDays: 31, amountPaise: 0, overdue: false },
    { label: '31+ days', fromDays: 31, toDays: null, amountPaise: 0, overdue: false },
  ];

  for (const [reference, bill] of invoiced) {
    const unpaid = bill.amount - (settled.get(reference) ?? 0);
    if (unpaid <= 0) continue;

    const ageDays = Math.floor((asOf.getTime() - bill.at.getTime()) / DAY_MS);
    const bucket =
      buckets.find(
        (candidate) =>
          ageDays >= candidate.fromDays && (candidate.toDays === null || ageDays < candidate.toDays),
      ) ?? buckets[buckets.length - 1]!;

    bucket.amountPaise += unpaid;
    if (ageDays > terms.paymentTermsDays) bucket.overdue = true;
  }

  return buckets;
}

/* --------------------------------------------------------------------- statement */

export interface StatementRow {
  entry: LedgerEntry;
  balanceAfter: number;
}

/** The entries oldest first, each with the balance it produced. */
export function statement(entries: LedgerEntry[]): StatementRow[] {
  const ordered = [...entries].sort((a, b) => a.at.getTime() - b.at.getTime());
  let running = 0;
  return ordered.map((item) => {
    running += movement(item);
    return { entry: item, balanceAfter: running };
  });
}
