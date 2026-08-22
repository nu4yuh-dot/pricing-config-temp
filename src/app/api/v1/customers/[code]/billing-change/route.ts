import { NextResponse } from 'next/server';
import { BillingChangeRequest } from '../../../../../../api/contracts';
import { authenticatedJson, badRequest } from '../../../../_auth';
import { raiseContractRequest } from '../../../../../../data/contract-requests';
import { recordAudit } from '../../../../../../data/audit';
import { portalActor, customerOr404 } from '../../../../../../customers/portal-actor';

/**
 * "Request Change" on the portal's Billing Config tab.
 *
 * The tab is read-only to the customer and marked "Managed by SameX", which is correct:
 * a billing cycle and a credit period decide what they are charged and when, and a
 * customer editing their own credit period is not a settings screen, it is a negotiation.
 *
 * So the button raises a request rather than making a change. It lands in the same queue
 * as a contract request, because it is one — the answer is a commercial decision by the
 * same people, and two queues for one kind of conversation is how one of them stops being
 * read.
 */
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;

  const parsed = BillingChangeRequest.safeParse(auth.body);
  if (!parsed.success) return badRequest('Invalid billing change request.', parsed.error.flatten());
  const input = parsed.data;

  const { code } = await params;
  const customer = await customerOr404(code, auth.caller);
  if ('response' in customer) return customer.response;

  const created = await raiseContractRequest({
    customerCode: customer.customer.code,
    raisedBy: input.raisedBy,
    // Prefixed so a reviewer opening the queue can see at a glance that this one is about
    // terms rather than lanes, without a second request type to maintain.
    note: `Billing configuration: ${input.note}`,
    ask: {},
  });

  await recordAudit({
    action: 'enterprise-billing-change-requested',
    actor: portalActor(auth.caller),
    at: created.raisedAt,
    detail: { customer: customer.customer.code, reference: created.reference, raisedBy: input.raisedBy },
  });

  return NextResponse.json(
    {
      success: true,
      data: {
        reference: created.reference,
        status: created.status,
        // The portal's own toast, said the same way we would say it.
        message: 'Change request submitted. Our team will contact you shortly.',
      },
    },
    { status: 201 },
  );
}
