import { NextResponse } from 'next/server';
import { authenticatedRequest } from '../../../../_auth';
import { billHistory, currentBill } from '../../../../../../data/customer-billing';
import { customerOr404 } from '../../../../../../customers/portal-actor';
import { DEFAULT_COMMERCIAL_TERMS } from '../../../../../../domain/customers';

/**
 * The customer's bills, for the enterprise portal's Billing tab.
 *
 * Replaces `billing/customer/current` and `billing/customer/history` in one call, because
 * their screen shows the current bill and the list beneath it together — and two calls
 * would let one arrive without the other.
 *
 * "Current" is the newest period that has actually been billed. An open period is not a
 * bill: nothing has been claimed about it, and showing one invites a customer to query a
 * total that is still moving.
 */
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const { code } = await params;
  const found = await customerOr404(code);
  if ('response' in found) return found.response;

  const terms = found.customer.commercial ?? DEFAULT_COMMERCIAL_TERMS;
  const [current, history] = await Promise.all([
    currentBill(found.customer.code, terms.paymentTermsDays),
    billHistory(found.customer.code, terms.paymentTermsDays),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      current,
      // Lines are on the individual bill, not here — a year of history with every AWB
      // would be a large response nobody asked for.
      history: history.map(({ lines, ...bill }) => ({ ...bill, lineCount: lines.length })),
    },
  });
}
