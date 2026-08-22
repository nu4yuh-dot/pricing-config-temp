import { NextResponse } from 'next/server';
import { BillLineMark } from '../../../../../../../../../api/contracts';
import { authenticatedJson, badRequest } from '../../../../../../../_auth';
import { markLine, billFor } from '../../../../../../../../../data/customer-billing';
import { portalActor, customerOr404 } from '../../../../../../../../../customers/portal-actor';
import { commercialTerms } from '../../../../../../../../../domain/customers';

/**
 * The customer accepting or disputing one line of their bill.
 *
 * Replaces `reconcile/{shipmentId}/accept` and `/dispute`. One route rather than two,
 * because it is one decision with two answers — and a dispute must carry a reason, which
 * a bare `/dispute` path has nowhere to put.
 *
 * A dispute here is what later proposes reopening the billing period, so the reason
 * travels all the way to the person deciding whether to reopen it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string; periodId: string; awb: string }> },
) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;

  const parsed = BillLineMark.safeParse(auth.body);
  if (!parsed.success) return badRequest('Invalid mark.', parsed.error.flatten());

  const { code, periodId, awb } = await params;
  const found = await customerOr404(code, auth.caller);
  if ('response' in found) return found.response;

  const terms = commercialTerms(found.customer.commercial);
  const bill = await billFor(found.customer.code, periodId, terms.paymentTermsDays);
  if (!bill) {
    return NextResponse.json({ success: false, message: `No bill for ${periodId}.` }, { status: 404 });
  }

  // A line that is not on this bill cannot be disputed on it. Accepting the mark anyway
  // would leave an opinion attached to nothing.
  if (!bill.lines.some((line) => line.reference === awb)) {
    return NextResponse.json(
      { success: false, message: `${awb} is not on the bill for ${periodId}.` },
      { status: 404 },
    );
  }

  await markLine(
    found.customer.code,
    periodId,
    {
      awb,
      state: parsed.data.state,
      at: new Date(),
      by: parsed.data.by,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    },
    portalActor(auth.caller),
  );

  return NextResponse.json({ success: true, data: { awb, state: parsed.data.state } });
}
