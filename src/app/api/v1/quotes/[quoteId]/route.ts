import { NextResponse } from 'next/server';
import { authenticatedRequest } from '../../../_auth';
import { quoteById } from '../../../../../data/quotes';

/**
 * Read back one quote we answered.
 *
 * This is what makes the identifier worth returning. The handbook's reason for asking for
 * one is that "six weeks later someone will ask why a consignment was charged what it
 * was" — which needs somewhere to ask. Without this route the identifier would be a
 * receipt number for a shop with no records.
 *
 * It returns what was quoted, not what the card says now. Re-pricing on read would answer
 * a different question — today's rate for that lane — and would quietly hide exactly the
 * case the record exists for: a rate that has changed since.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ quoteId: string }> },
) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const { quoteId } = await params;
  const quote = await quoteById(quoteId);

  if (!quote) {
    return NextResponse.json(
      { success: false, message: `No quote ${quoteId}.` },
      { status: 404 },
    );
  }

  return NextResponse.json({
    success: true,
    data: {
      quoteId: quote.quoteId,
      quotedAt: quote.createdAt.toISOString(),
      validUntil: quote.validUntil?.toISOString() ?? null,
      // Read back long after the fact is the normal case here, so say plainly whether the
      // number may still be used or is only a record of what was said.
      expired: quote.validUntil ? quote.validUntil.getTime() < Date.now() : null,
      request: quote.request,
      pricedAgainst: quote.pricedAgainst,
      tiers: quote.tiers,
    },
  });
}
