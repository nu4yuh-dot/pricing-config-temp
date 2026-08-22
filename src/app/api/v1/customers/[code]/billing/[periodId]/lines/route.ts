import { NextResponse } from 'next/server';
import { BillAcceptAll } from '../../../../../../../../api/contracts';
import { authenticatedJson, badRequest } from '../../../../../../_auth';
import { acceptAll } from '../../../../../../../../data/customer-billing';
import { portalActor, customerOr404 } from '../../../../../../../../customers/portal-actor';
import { commercialTerms } from '../../../../../../../../domain/customers';

/**
 * Accepting every outstanding line at once — the portal's "accept all".
 *
 * Only the lines nobody has looked at. Accepting everything must not quietly withdraw a
 * dispute the customer already raised, which is what a blanket overwrite would do.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string; periodId: string }> },
) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;

  const parsed = BillAcceptAll.safeParse(auth.body);
  if (!parsed.success) return badRequest('Who is accepting?', parsed.error.flatten());

  const { code, periodId } = await params;
  const found = await customerOr404(code, auth.caller);
  if ('response' in found) return found.response;

  const terms = commercialTerms(found.customer.commercial);

  try {
    const accepted = await acceptAll(
      found.customer.code,
      periodId,
      parsed.data.by,
      terms.paymentTermsDays,
      portalActor(auth.caller),
    );
    return NextResponse.json({
      success: true,
      data: {
        accepted,
        message:
          accepted === 0
            ? 'Every line had already been looked at; nothing changed.'
            : `${accepted} line${accepted === 1 ? '' : 's'} accepted.`,
      },
    });
  } catch (cause) {
    return badRequest(cause instanceof Error ? cause.message : 'Could not accept those lines.');
  }
}
