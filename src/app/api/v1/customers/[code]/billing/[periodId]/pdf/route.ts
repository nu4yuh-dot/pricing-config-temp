import { NextResponse } from 'next/server';
import { authenticatedRequest } from '../../../../../../_auth';
import { billFor } from '../../../../../../../../data/customer-billing';
import { customerOr404 } from '../../../../../../../../customers/portal-actor';
import { commercialTerms } from '../../../../../../../../domain/customers';
import { renderStatement } from '../../../../../../../../billing/statement-pdf';

/**
 * A period's charges as a PDF, for the portal's `bill/{cycleId}/pdf`.
 *
 * A **statement**, not a tax invoice, and the response says so in its own filename. Two
 * reasons, both in `billing/statement-pdf.ts`: a cycle holds several invoice numbers because
 * invoices are raised per mode, and this service holds no record of our own GSTIN or
 * registered address — so a tax invoice would carry a registration somebody invented.
 *
 * Rendered on demand rather than stored. The figures come from the same `billFor` the JSON
 * endpoint uses, so the page and the document can never disagree; a stored PDF would be a
 * second copy that goes stale the moment a credit note is raised against the period.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string; periodId: string }> },
) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const { code, periodId } = await params;
  const found = await customerOr404(code, auth.caller);
  if ('response' in found) return found.response;

  const terms = commercialTerms(found.customer.commercial);
  const bill = await billFor(found.customer.code, periodId, terms.paymentTermsDays);
  if (!bill) {
    return NextResponse.json(
      { success: false, message: `No bill for ${periodId}.` },
      { status: 404 },
    );
  }

  const pdf = renderStatement(bill, found.customer.name);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      // `inline` so the portal can show it in a viewer; the filename is what a browser uses
      // when somebody saves it, and it names the customer and period rather than the id.
      'content-disposition': `inline; filename="statement-${found.customer.code}-${periodId}.pdf"`,
      'content-length': String(pdf.byteLength),
      // Never cached: a credit note raised against this period changes it.
      'cache-control': 'no-store',
    },
  });
}
