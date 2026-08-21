/**
 * Invoice numbering — a consecutive series, per financial year.
 *
 * A tax invoice number is not a name, it is a position in a sequence. GST expects the
 * series to run consecutively within a financial year, and expects any number that does
 * not appear on an invoice to be explainable.
 *
 * That second clause is the design. Gapless and crash-proof cannot both be absolute: a
 * number has to be reserved before the document is written, so a failure between the two
 * leaves a number spent on nothing. Pretending otherwise produces the worse outcome —
 * either two invoices sharing a number, or a silent hole nobody can account for.
 *
 * So: numbers are allocated one at a time and never reused, and an allocation that does
 * not become an invoice is *recorded as a gap with a reason*. A series can then be
 * reconciled — every number either on a document or explained — which is what an auditor
 * actually asks for.
 */

/** `2026-27`. The Indian financial year runs April to March. */
export function financialYear(date: Date): string {
  const year = date.getUTCFullYear();
  const startsThisYear = date.getUTCMonth() >= 3; // April is month 3
  const start = startsThisYear ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export interface SeriesKey {
  /** Which series. One today; per-state registrations would add more. */
  prefix: string;
  financialYear: string;
}

/**
 * A number that was taken from the series and did not become an invoice.
 *
 * Kept rather than reused. Reissuing it would put two different documents at the same
 * position in the sequence at different times, which is precisely what the series exists
 * to prevent.
 */
export interface SeriesGap {
  number: string;
  sequence: number;
  at: Date;
  reason: string;
}

export interface SeriesState {
  prefix: string;
  financialYear: string;
  /**
   * How many numbers this series has handed out. The last issued sequence, and zero
   * before the first.
   *
   * Named for what it holds. It was `next` when the counter was read before incrementing;
   * fixing that bug made the stored value the *last issued* number instead, and leaving
   * the old name behind produced an off-by-one in the reconciliation — which then reported
   * one number issued and two on documents, and still called it balanced.
   */
  issued: number;
  gaps: SeriesGap[];
}

/**
 * `DNS/2026-27/000042`.
 *
 * Zero-padded to six so the series sorts as text, which is how it will be read in a
 * spreadsheet whatever anybody intended.
 */
export function formatNumber(key: SeriesKey, sequence: number): string {
  return `${key.prefix}/${key.financialYear}/${String(sequence).padStart(6, '0')}`;
}

export function parseNumber(
  value: string,
): { prefix: string; financialYear: string; sequence: number } | null {
  const match = /^(.+)\/(\d{4}-\d{2})\/(\d{6})$/.exec(value.trim());
  if (!match) return null;
  return { prefix: match[1]!, financialYear: match[2]!, sequence: Number(match[3]) };
}

export interface Reconciliation {
  /** Every sequence the series has handed out. */
  allocated: number;
  /** How many are on an invoice. */
  onDocuments: number;
  /** How many were explained away. */
  explained: number;
  /** Numbers on neither — the ones an auditor would ask about. */
  unaccounted: number[];
  balanced: boolean;
}

/**
 * Checks that every number handed out is either on an invoice or explained.
 *
 * The whole point of a series is that this comes out balanced. When it does not, the
 * unaccounted numbers are named, because "there is a gap somewhere" is not something
 * anybody can act on.
 */
export function reconcile(
  state: SeriesState,
  invoiceNumbers: readonly string[],
): Reconciliation {
  const key: SeriesKey = { prefix: state.prefix, financialYear: state.financialYear };

  const onDocument = new Set<number>();
  for (const number of invoiceNumbers) {
    const parsed = parseNumber(number);
    if (!parsed) continue;
    if (parsed.prefix !== state.prefix || parsed.financialYear !== state.financialYear) continue;
    onDocument.add(parsed.sequence);
  }

  const explained = new Set(state.gaps.map((gap) => gap.sequence));
  const unaccounted: number[] = [];

  // Sequences run from 1 to the last issued; anything beyond has not been handed out.
  for (let sequence = 1; sequence <= state.issued; sequence++) {
    if (!onDocument.has(sequence) && !explained.has(sequence)) unaccounted.push(sequence);
  }

  return {
    allocated: Math.max(state.issued, 0),
    onDocuments: onDocument.size,
    explained: explained.size,
    unaccounted,
    balanced: unaccounted.length === 0,
  };
}

/** A sentence for whoever has to explain the series. */
export function reconciliationNote(state: SeriesState, result: Reconciliation): string {
  const key = `${state.prefix}/${state.financialYear}`;
  if (result.allocated === 0) return `${key}: nothing issued yet.`;
  if (result.balanced) {
    return `${key}: ${result.allocated} numbers issued, all accounted for${
      result.explained > 0 ? ` (${result.explained} explained)` : ''
    }.`;
  }
  const missing = result.unaccounted
    .slice(0, 5)
    .map((sequence) => formatNumber({ prefix: state.prefix, financialYear: state.financialYear }, sequence))
    .join(', ');
  return `${key}: ${result.unaccounted.length} number(s) on neither an invoice nor a recorded gap — ${missing}${
    result.unaccounted.length > 5 ? ', …' : ''
  }.`;
}
