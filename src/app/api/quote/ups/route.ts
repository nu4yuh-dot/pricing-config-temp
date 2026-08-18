import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiKey, badRequest } from '../../_auth';
import { liveCardsFromSource } from '../../../../data/rate-cards';
import { quoteUps } from '../../../../pricing/ups';
import { UPS_PRODUCTS } from '../../../../domain/ups';

/**
 * Quoting the UPS / MOVIN international export card.
 *
 * A separate endpoint because the question has a different shape again: the origin is
 * fixed at Mumbai, the destination is a country rather than a pincode, and the choice is
 * a product — envelope, document or package — rather than a mode.
 *
 * Asking for a product returns that one; asking for none returns all three that can carry
 * the shipment, so a desk can see what the alternatives cost without three round trips.
 */

const Query = z.object({
  country: z.string().trim().min(2).max(3),
  /** Needed only where the card zones a country by postal code. China, today. */
  postal: z.string().trim().max(12).optional(),
  weight: z.coerce.number().positive(),
  product: z.enum(UPS_PRODUCTS).optional(),
  length: z.coerce.number().nonnegative().optional(),
  breadth: z.coerce.number().nonnegative().optional(),
  height: z.coerce.number().nonnegative().optional(),
  /** Comma-separated accessorial ids to apply on top of the defaults. */
  accessorials: z.string().trim().optional(),
});

export async function GET(request: Request) {
  const unauthorised = requireApiKey(request);
  if (unauthorised) return unauthorised;

  const url = new URL(request.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return badRequest('Invalid UPS quote query.', parsed.error.flatten());
  }
  const q = parsed.data;

  const [card] = await liveCardsFromSource('ups');
  const data = card?.data.ups;
  if (!data) {
    return NextResponse.json(
      {
        bookable: false,
        error: 'product-not-configured',
        message: 'The UPS rate card is not configured.',
      },
      { status: 503 },
    );
  }

  const accessorials = q.accessorials
    ? q.accessorials.split(',').map((id) => id.trim()).filter(Boolean)
    : [];

  const wanted = q.product ? [q.product] : [...UPS_PRODUCTS];
  const priced = wanted.map((product) => ({
    product,
    result: quoteUps(
      {
        product,
        countryCode: q.country,
        ...(q.postal === undefined ? {} : { postalCode: q.postal }),
        actualWeight: q.weight,
        ...(q.length === undefined ? {} : { length: q.length }),
        ...(q.breadth === undefined ? {} : { breadth: q.breadth }),
        ...(q.height === undefined ? {} : { height: q.height }),
        accessorials,
      },
      data,
    ),
  }));

  const available = priced.filter((entry) => entry.result.available);

  if (available.length === 0) {
    // Every product refused for the same reason — an unserved country, a missing postal
    // code — so report that reason rather than an empty list the caller has to interpret.
    const first = priced[0]?.result;
    return NextResponse.json(
      {
        bookable: false,
        error: first && !first.available ? first.reason : 'not-priced',
        message: first && !first.available ? first.message : 'This shipment cannot be priced.',
        origin: data.params.origin,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({
    bookable: true,
    origin: data.params.origin,
    country: q.country.trim().toUpperCase(),
    destination: data.destinationNames[q.country.trim().toUpperCase()] ?? null,
    quotes: available.map((entry) => ({
      product: entry.product,
      ...(entry.result.available
        ? { breakdown: entry.result.breakdown, warnings: entry.result.warnings }
        : {}),
    })),
    // What the other products refused, so a desk can see why a document was not offered.
    unavailable: priced
      .filter((entry) => !entry.result.available)
      .map((entry) => ({
        product: entry.product,
        reason: entry.result.available ? null : entry.result.reason,
        message: entry.result.available ? null : entry.result.message,
      })),
  });
}
