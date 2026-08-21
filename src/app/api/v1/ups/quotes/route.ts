import { NextResponse } from 'next/server';
import { UpsQuoteQuery } from '../../../../../api/contracts';
import { authenticatedRequest, badRequest } from '../../../_auth';
import { liveCardsFromSource } from '../../../../../data/rate-cards';
import { quoteUps } from '../../../../../pricing/ups';
import { UPS_PRODUCTS } from '../../../../../domain/ups';

export async function GET(request: Request) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const parsed = UpsQuoteQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return badRequest('Invalid UPS quote query.', parsed.error.flatten());
  }
  const q = parsed.data;

  /**
   * Partner carriers are gated per customer by a SameX admin. Quoting one the customer is
   * not enabled for hands them a price they cannot book, which is worse than no price.
   */
  if (q.customer) {
    const { findCustomer } = await import('../../../../../data/customers');
    const { mayUseCarrier, carrierRefusedMessage } = await import('../../../../../customers/carrier-access');
    const customer = await findCustomer(q.customer);
    if (customer && !mayUseCarrier(customer, 'ups')) {
      return NextResponse.json(
        {
          bookable: false,
          reason: 'carrier-not-enabled',
          message: carrierRefusedMessage(customer.name, 'UPS / MOVIN'),
        },
        { status: 403 },
      );
    }
  }

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
