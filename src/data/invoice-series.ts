import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import { financialYear, formatNumber, reconcile, type SeriesState } from '../billing/series';
import type { Actor } from './workflow';

/**
 * Handing out invoice numbers, one at a time, without ever handing one out twice.
 *
 * The allocation is a single `findOneAndUpdate` with `$inc`. That is the whole mechanism,
 * and it is chosen because it is atomic in the database rather than in this process: two
 * bill runs racing on two instances cannot both receive the same sequence, which a
 * read-then-write would allow and which would put two tax invoices at the same position.
 *
 * A number is spent the moment it is handed out. If the invoice it was meant for never
 * gets written, the number is not returned to the series — it is recorded as a gap with a
 * reason, so the series can still be reconciled. See `billing/series.ts` for why that is
 * the honest trade rather than the lazy one.
 */

/** One series today. A per-state registration would add a prefix, not a new mechanism. */
export const DEFAULT_SERIES_PREFIX = process.env.INVOICE_SERIES_PREFIX ?? 'DNS';

async function series() {
  return (await db()).collection<SeriesState>(COLLECTIONS.invoiceSeries);
}

/**
 * Takes the next number in the series for the financial year the invoice falls in.
 *
 * The year comes from the invoice date, not from today: a bill run in April for March's
 * shipments belongs to the year that has just closed, and numbering it into the new one
 * would put it in the wrong return.
 */
export async function allocateNumber(
  invoiceDate: Date,
  prefix: string = DEFAULT_SERIES_PREFIX,
): Promise<{ number: string; sequence: number }> {
  const year = financialYear(invoiceDate);
  const collection = await series();

  /**
   * `after`, not `before`.
   *
   * With `before`, the first allocation for a year returns null — there is no prior
   * document — and any default supplied for that case collides with the second
   * allocation, which reads the value the first one wrote. That put two invoices at
   * sequence 1, which is the exact failure the series exists to prevent. Caught by running
   * three allocations against an empty series and reading the numbers.
   *
   * With `after`, the increment itself is the sequence: `$inc` on a missing field yields
   * 1, so the first call gets 1, the second 2, and there is no branch to get wrong. The
   * stored value is therefore the *last issued* number, which is why the field is called
   * `issued` rather than `next`.
   */
  const updated = await collection.findOneAndUpdate(
    { prefix, financialYear: year },
    { $inc: { issued: 1 }, $setOnInsert: { prefix, financialYear: year, gaps: [] } },
    { upsert: true, returnDocument: 'after' },
  );

  const sequence = updated!.issued;
  return { number: formatNumber({ prefix, financialYear: year }, sequence), sequence };
}

/**
 * Records that an allocated number never became an invoice.
 *
 * Called when a raise fails after the number was taken. The reason is required: a gap
 * without one is exactly the thing an auditor asks about, and "unknown" recorded at the
 * time is still better than reconstructing it a year later.
 */
export async function recordGap(
  number: string,
  sequence: number,
  reason: string,
  invoiceDate: Date,
  prefix: string = DEFAULT_SERIES_PREFIX,
): Promise<void> {
  const year = financialYear(invoiceDate);
  await (await series()).updateOne(
    { prefix, financialYear: year },
    { $push: { gaps: { number, sequence, at: new Date(), reason } } },
  );
}

export async function seriesState(
  year: string,
  prefix: string = DEFAULT_SERIES_PREFIX,
): Promise<SeriesState | null> {
  return (await series()).findOne({ prefix, financialYear: year });
}

export async function allSeries(): Promise<SeriesState[]> {
  return (await series()).find().sort({ financialYear: -1 }).toArray();
}

/** Every number either on an invoice or explained, for one series and year. */
export async function reconcileSeries(year: string, prefix: string = DEFAULT_SERIES_PREFIX) {
  const state = await seriesState(year, prefix);
  if (!state) return null;

  const invoices = await (await db())
    .collection<{ number: string }>(COLLECTIONS.invoices)
    .find({}, { projection: { number: 1 } })
    .toArray();

  return reconcile(state, invoices.map((invoice) => invoice.number));
}

/**
 * Notes that a series was reconciled, so the check itself leaves a trail.
 *
 * Worth recording rather than being a read-only screen: "we checked on the 3rd and it
 * balanced" is what makes a later discrepancy datable.
 */
export async function noteReconciliation(
  year: string,
  balanced: boolean,
  unaccounted: number,
  actor: Actor,
): Promise<void> {
  await recordAudit({
    action: 'invoice-series-reconciled',
    actor,
    at: new Date(),
    detail: { financialYear: year, balanced, unaccounted },
  });
}
