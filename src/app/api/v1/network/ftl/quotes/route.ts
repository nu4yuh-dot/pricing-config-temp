import { NextResponse } from 'next/server';
import { FtlQuoteQuery } from '../../../../../../api/contracts';
import { authenticatedRequest, badRequest } from '../../../../_auth';
import { findCustomer, baseCardFor, contractedCard } from '../../../../../../data/customers';
import { findPincodePair } from '../../../../../../data/pincodes';
import { liveCardsFromSource } from '../../../../../../data/rate-cards';
import { quoteFtl, VEHICLE_TYPES } from '../../../../../../pricing/ftl';

export async function GET(request: Request) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const parsed = FtlQuoteQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return badRequest('Invalid FTL quote query.', parsed.error.flatten());
  }
  const q = parsed.data;

  const { origin, destination } = await findPincodePair(q.from, q.to);
  if (!origin || !destination) {
    return NextResponse.json(
      {
        bookable: false,
        error: origin ? 'unknown-destination-pincode' : 'unknown-origin-pincode',
        message: `${origin ? 'Destination' : 'Origin'} pincode ${
          origin ? q.to : q.from
        } is not serviceable.`,
      },
      { status: 404 },
    );
  }

  const endpoints = { origin, destination };
  const ask = { vehicle: q.vehicle };

  /* ------------------------------------------------- no customer: base cards */

  if (!q.customer) {
    const cards = await liveCardsFromSource('dns');
    return NextResponse.json({
      bookable: true,
      pricing: 'base',
      vehicles: VEHICLE_TYPES,
      cards: cards.map((card) => {
        const result = quoteFtl(ask, endpoints, card.data);
        return {
          key: card.key,
          name: card.name,
          ...(result.available
            ? { available: true, breakdown: result.breakdown }
            : { available: false, reason: result.reason, message: result.message }),
        };
      }),
    });
  }

  /* ---------------------------------------------------------- with customer */

  const customer = await findCustomer(q.customer);
  if (!customer) {
    return NextResponse.json(
      {
        bookable: false,
        error: 'unknown-customer',
        message: `Customer ${q.customer} is not registered with the pricing service.`,
      },
      { status: 404 },
    );
  }
  if (customer.status !== 'active') {
    return NextResponse.json(
      { bookable: false, error: 'customer-suspended', message: `Customer ${customer.code} is suspended.` },
      { status: 403 },
    );
  }

  const billing = customer.commercial
    ? {
        billingType: customer.commercial.billingType,
        gstApplicable: customer.commercial.gstApplicable,
      }
    : undefined;

  const contracted = await contractedCard(customer);
  const contractQuote = quoteFtl(ask, endpoints, contracted.data, billing);

  if (contractQuote.available) {
    const base = await baseCardFor(customer);
    const baseQuote = quoteFtl(ask, endpoints, base.data, billing);
    return NextResponse.json({
      bookable: true,
      pricing: 'contract',
      customer: { code: customer.code, name: customer.name },
      breakdown: contractQuote.breakdown,
      baseTotal: baseQuote.available ? baseQuote.breakdown.total : null,
      billing: customer.commercial ?? null,
      warnings: contractQuote.warnings,
    });
  }

  /**
   * No contracted rate for this truck on this lane. Unlike partload there is no base price
   * to fall back to — an unrated FTL lane has no standard price, it simply has not been
   * quoted — so the honest answer is that it needs quoting, not that it costs something.
   */
  return NextResponse.json(
    {
      bookable: false,
      pricing: 'out-of-contract',
      customer: { code: customer.code, name: customer.name },
      reason: contractQuote.reason,
      message: contractQuote.message,
      requiresApproval: true,
      approvalEndpoint: '/api/bookings/exceptions',
      note:
        'FTL has no standard price to fall back on. This lane and vehicle need to be rated ' +
        'and approved before it can be booked.',
    },
    { status: 409 },
  );
}
