/**
 * The month-end rehearsal, as a command a scheduler can run.
 *
 * Railway crons run a command, not an HTTP request, so this is what the cron points at. It
 * calls the same `rehearseMonthEnd` the endpoint does — one implementation, so the schedule
 * and the API can never disagree about what is billable.
 *
 *   npx tsx scripts/month-end.ts                       the month that just closed
 *   npx tsx scripts/month-end.ts 2026-05-01 2026-05-31 a window, for a re-run
 *
 * It **prepares and does not raise**. Exits 0 when it has an answer, whether or not anything
 * is ready to bill — a schedule that failed because there was nothing to do would page
 * somebody every quiet month. It exits 1 only when it could not produce an answer at all.
 */

import { rehearseMonthEnd } from '../src/data/month-end';

const rupees = (value: number) =>
  `Rs. ${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const [from, to] = process.argv.slice(2);
  const window =
    from && to ? { from: new Date(from), to: new Date(to) } : undefined;

  const report = await rehearseMonthEnd(
    { id: 'scheduler', email: 'scheduler@service', name: 'Month-end schedule' },
    new Date(),
    window,
  );

  const day = (d: Date) => d.toISOString().slice(0, 10);
  console.log(`Month-end rehearsal · ${day(report.from)} to ${day(report.to)}`);
  console.log('');

  for (const entry of report.ready) {
    console.log(
      `  ready    ${entry.customerCode.padEnd(14)} ${rupees(entry.totalToBill).padStart(16)}` +
        `  over ${entry.billable.length} shipment(s)`,
    );
  }
  for (const entry of report.blocked) {
    const reasons = [...new Set(entry.held.map((line) => line.heldBecause).filter(Boolean))];
    console.log(`  blocked  ${entry.customerCode.padEnd(14)} ${entry.held.length} held`);
    for (const reason of reasons) console.log(`             ${reason}`);
  }
  for (const entry of report.failed) {
    console.log(`  FAILED   ${entry.customerCode.padEnd(14)} ${entry.error}`);
  }

  console.log('');
  console.log(
    `  ${report.ready.length} ready · ${report.blocked.length} blocked · ` +
      `${report.quiet.length} with nothing to bill · ${report.failed.length} failed`,
  );
  console.log(`  ${rupees(report.totalToBill)} would be billed. Nothing has been raised.`);
  if (report.ready.length > 0) console.log('  Raise them from /invoices.');

  process.exit(0);
}

main().catch((error) => {
  // Only a failure to produce an answer at all. A quiet month is a normal answer.
  console.error('The month-end rehearsal did not complete:', error);
  process.exit(1);
});
