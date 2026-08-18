import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiKey, badRequest } from '../../_auth';
import { findCustomer, baseCardFor, contractedCard } from '../../../../data/customers';
import { findPincodePair } from '../../../../data/pincodes';
import { liveCardsFromSource } from '../../../../data/rate-cards';
import { quoteFtl, VEHICLE_TYPES } from '../../../../pricing/ftl';

/**
 * Quoting a full truck.
 *
 * A separate endpoint from `/api/quote` because the question is a different one: an FTL
 * booking names a vehicle, not a weight, and there is no chargeable weight, no volumetric
 * calculation and no weight band to check a contract against.
 *
 * For FTL, coverage *is* the rate matrix. A lane a customer has no rate for comes back
 * unavailable, which is the same answer as being outside contract — so there is no separate
 * scope check to make.
 */

const Query = z.object({
  customer: z.string().trim().min(1).optional(),
  vehicle: z.string().trim().min(1),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});

export async function GET(request: Request) {
  const unauthorised = requireApiKey(request);
  if (unauthorised) return unauthorised;

  const url = new URL(request.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
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
