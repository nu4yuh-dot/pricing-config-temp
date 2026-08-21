import { NextResponse } from 'next/server';
import { authenticatedRequest } from '../../../_auth';
import { rehearseMonthEnd } from '../../../../../data/month-end';

/**
 * What a month-end scheduler calls.
 *
 * **It prepares; it does not raise.** Working out what would be billed is safe to automate;
 * issuing a numbered document in a gapless series is not, because a run that fires
 * unattended and gets it wrong has already reached the customer before anybody looks. So
 * this answers with the rehearsal and leaves the irreversible part to a person, who now has
 * the answer in front of them rather than a blank form.
 *
 * Authenticated like every other published endpoint, so pointing a cron at it needs the same
 * credential as anything else — a scheduler is just another caller. Safe to call twice: it
 * reads and reports, and calling it again on the 3rd because the 1st was missed produces the
 * same answer for the same month.
 */
export async function GET(request: Request) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  // A window can be given for a re-run of an older month; omitted, it is the month that has
  // just closed, worked out from today so a scheduler does not have to.
  let window: { from: Date; to: Date } | undefined;
  if (from !== null || to !== null) {
    if (from === null || to === null) {
      return NextResponse.json(
        { error: 'bad-request', message: 'Give both from and to, or neither.' },
        { status: 400 },
      );
    }
    const parsedFrom = new Date(from);
    const parsedTo = new Date(to);
    if (Number.isNaN(parsedFrom.getTime()) || Number.isNaN(parsedTo.getTime())) {
      return NextResponse.json(
        { error: 'bad-request', message: 'from and to must be dates, as YYYY-MM-DD.' },
        { status: 400 },
      );
    }
    if (parsedTo < parsedFrom) {
      return NextResponse.json(
        { error: 'bad-request', message: 'to is before from.' },
        { status: 400 },
      );
    }
    window = { from: parsedFrom, to: parsedTo };
  }

  const report = await rehearseMonthEnd(
    { id: auth.caller.keyId, email: `${auth.caller.keyId}@service`, name: `${auth.caller.keyId} (scheduled)` },
    new Date(),
    window,
  );

  return NextResponse.json({
    success: true,
    data: {
      from: report.from,
      to: report.to,
      ranAt: report.ranAt,
      /** Nothing was raised. Stated in the payload so it cannot be assumed either way. */
      raised: false,
      summary: {
        ready: report.ready.length,
        blocked: report.blocked.length,
        quiet: report.quiet.length,
        failed: report.failed.length,
        totalToBill: report.totalToBill,
        heldTotal: report.heldTotal,
      },
      ready: report.ready.map((entry) => ({
        customerCode: entry.customerCode,
        customerName: entry.customerName,
        basis: entry.basis,
        shipments: entry.billable.length,
        totalToBill: entry.totalToBill,
        held: entry.held.length,
        heldTotal: entry.heldTotal,
      })),
      blocked: report.blocked.map((entry) => ({
        customerCode: entry.customerCode,
        customerName: entry.customerName,
        basis: entry.basis,
        held: entry.held.length,
        heldTotal: entry.heldTotal,
        // The distinct reasons, which is what somebody acts on — forty lines all waiting on
        // proof of delivery is one problem, not forty.
        reasons: [...new Set(entry.held.map((line) => line.heldBecause).filter(Boolean))],
        ...(entry.refusal === undefined ? {} : { refusal: entry.refusal }),
      })),
      quiet: report.quiet,
      failed: report.failed,
    },
  });
}
