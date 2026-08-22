import { NextResponse } from 'next/server';
import { authenticatedRequest } from '../../../../../_auth';
import { billFor } from '../../../../../../../data/customer-billing';
import { customerOr404 } from '../../../../../../../customers/portal-actor';
import { commercialTerms } from '../../../../../../../domain/customers';

/**
 * One bill, with every line.
 *
 * Replaces `billing/customer/bill/{cycleId}` and `billing/customer/reconcile/{cycleId}` —
 * the same document serves both screens, because reconciling a bill is reading it with the
 * intention of arguing.
 *
 * The period id is the date the period starts. Readable, stable, and it cannot be confused
 * with a database identifier that means nothing to anybody.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string; periodId: string }> },
) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const { code, periodId } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodId)) {
    return NextResponse.json(
      { success: false, message: 'A period is addressed by the date it starts, e.g. 2026-08-01.' },
      { status: 400 },
    );
  }

  const found = await customerOr404(code, auth.caller);
  if ('response' in found) return found.response;

  const terms = commercialTerms(found.customer.commercial);
  const bill = await billFor(found.customer.code, periodId, terms.paymentTermsDays);
  if (!bill) {
    return NextResponse.json({ success: false, message: `No bill for ${periodId}.` }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: bill });
}
