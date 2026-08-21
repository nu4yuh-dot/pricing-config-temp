import { previewBillRun, type BillRunPreview } from './bill-run';
import { listCustomers } from './customers';
import { recordAudit } from './audit';
import type { Actor } from './workflow';

/**
 * The month-end rehearsal.
 *
 * Nothing in this deployment runs on a timer, so nothing happened at month end unless
 * somebody remembered. This is what a schedule calls — and it **prepares rather than
 * raises**, which is the whole design decision.
 *
 * Raising is deliberate here: a run that fires unattended and gets it wrong has already
 * reached the customer before anybody looks, and an invoice is a numbered document in a
 * gapless series that cannot simply be deleted afterwards. So the schedule does the part
 * that is safe to automate — working out what *would* be billed for every customer whose
 * period has closed, and what is held and why — and leaves the irreversible part to a
 * person, who now has the answer in front of them instead of a blank form.
 *
 * The output is deliberately the same `BillRunPreview` the screen already shows, so the
 * rehearsal and the button cannot disagree about what is billable.
 */

export interface MonthEndReport {
  from: Date;
  to: Date;
  ranAt: Date;
  /** Customers with something to bill, worth somebody's attention first. */
  ready: BillRunPreview[];
  /** Nothing billable — usually everything held, and the reasons say why. */
  blocked: BillRunPreview[];
  /** Nothing moved at all in the period. Not a problem, and not worth a row on a screen. */
  quiet: string[];
  /** A customer whose preview threw. Reported rather than skipped silently. */
  failed: { customerCode: string; error: string }[];
  totalToBill: number;
  heldTotal: number;
}

/**
 * The calendar month that has just ended, relative to a date.
 *
 * Taken from the date the run happens rather than passed in, because a scheduler that fires
 * at 02:00 on the 1st means "last month" and should not have to work out the boundaries.
 * UTC throughout, like everything else here.
 */
export function lastClosedMonth(asOf: Date): { from: Date; to: Date } {
  const from = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 1, 1));
  // Day 0 of this month is the last day of the previous one.
  const to = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 0));
  return { from, to };
}

export async function rehearseMonthEnd(
  actor: Actor,
  asOf: Date = new Date(),
  window?: { from: Date; to: Date },
): Promise<MonthEndReport> {
  const { from, to } = window ?? lastClosedMonth(asOf);
  const customers = await listCustomers();

  const ready: BillRunPreview[] = [];
  const blocked: BillRunPreview[] = [];
  const quiet: string[] = [];
  const failed: { customerCode: string; error: string }[] = [];

  for (const customer of customers) {
    try {
      const preview = await previewBillRun(customer.code, from, to);
      const nothingAtAll = preview.billable.length === 0 && preview.held.length === 0;
      if (nothingAtAll) quiet.push(customer.code);
      else if (preview.billable.length > 0) ready.push(preview);
      else blocked.push(preview);
    } catch (cause) {
      // One customer's bad data must not stop the other forty being looked at.
      failed.push({
        customerCode: customer.code,
        error: cause instanceof Error ? cause.message : 'The preview did not complete.',
      });
    }
  }

  // Largest first: the biggest bill is the one worth checking before it goes out.
  ready.sort((a, b) => b.totalToBill - a.totalToBill);

  const report: MonthEndReport = {
    from,
    to,
    ranAt: asOf,
    ready,
    blocked,
    quiet,
    failed,
    totalToBill: ready.reduce((sum, entry) => sum + entry.totalToBill, 0),
    heldTotal: [...ready, ...blocked].reduce((sum, entry) => sum + entry.heldTotal, 0),
  };

  await recordAudit({
    action: 'month-end-rehearsed',
    actor,
    at: asOf,
    detail: {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      ready: ready.length,
      blocked: blocked.length,
      quiet: quiet.length,
      failed: failed.length,
      totalToBill: report.totalToBill,
    },
  });

  return report;
}
