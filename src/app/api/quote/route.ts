import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiKey, badRequest } from '../_auth';
import { findCustomer, baseCardFor, contractedCard } from '../../../data/customers';
import { offersFor } from '../../../data/offers';
import { findPincodePair } from '../../../data/pincodes';
import { liveCardsFromSource } from '../../../data/rate-cards';
import { quote } from '../../../pricing/quote';
import { checkContract } from '../../../customers/contract';
import { MODES, type Mode } from '../../../domain/types';
import { canBook } from '../../../data/billing';
import { DEFAULT_COMMERCIAL_TERMS } from '../../../domain/customers';

/**
 * Quoting for the booking website.
 *
 * Behaviour the booking flow depends on:
 *
 *  - With a customer code, the contracted card is used, and the shipment is checked
 *    against the contract scope.
 *  - Outside the contract, the response is `bookable: false` with an explanation
 *    *and* the base-card price, so the operator can see what it would cost anyway.
 *    Booking at that price needs an approved exception first.
 *  - Without a customer code, all base cards are returned for comparison.
 *  - A price in contract is still not bookable if the customer has no money for it:
 *    an exhausted credit limit or an overdue balance holds the booking, with the
 *    shortfall stated so the operator can act on it.
 *
 * Quotes always read approved values — a pending edit or an unapproved contract
 * proposal can never reach this endpoint.
 */

const Query = z.object({
  customer: z.string().trim().min(1).optional(),
  mode: z.enum(MODES),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
  weight: z.coerce.number().positive(),
  length: z.coerce.number().nonnegative().optional(),
  breadth: z.coerce.number().nonnegative().optional(),
  height: z.coerce.number().nonnegative().optional(),
  pieces: z.coerce.number().int().positive().optional(),
  singlePackageOver100kg: z.coerce.boolean().optional(),
});

export async function GET(request: Request) {
  const unauthorised = requireApiKey(request);
  if (unauthorised) return unauthorised;

  const url = new URL(request.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return badRequest('Invalid quote query.', parsed.error.flatten());
  }
  const q = parsed.data;

  const { origin, destination } = await findPincodePair(q.from, q.to);
  if (!origin) {
    return NextResponse.json(
      {
        bookable: false,
        error: 'unknown-origin-pincode',
        message: `Origin pincode ${q.from} is not serviceable.`,
      },
      { status: 404 },
    );
  }
  if (!destination) {
    return NextResponse.json(
      {
        bookable: false,
        error: 'unknown-destination-pincode',
        message: `Destination pincode ${q.to} is not serviceable.`,
      },
      { status: 404 },
    );
  }

  const shipment = {
    mode: q.mode as Mode,
    actualWeight: q.weight,
    ...(q.length === undefined ? {} : { length: q.length }),
    ...(q.breadth === undefined ? {} : { breadth: q.breadth }),
    ...(q.height === undefined ? {} : { height: q.height }),
    ...(q.pieces === undefined ? {} : { pieces: q.pieces }),
    ...(q.singlePackageOver100kg === undefined
      ? {}
      : { singlePackageOver100kg: q.singlePackageOver100kg }),
  };
  const endpoints = { origin, destination };

  /* ------------------------------------------------- no customer: base cards */

  if (!q.customer) {
    const cards = await liveCardsFromSource('dns');
    return NextResponse.json({
      bookable: true,
      pricing: 'base',
      cards: cards.map((card) => {
        const result = quote(shipment, endpoints, card);
        return {
          key: card.key,
          name: card.name,
          freightMethod: card.freightMethod,
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
      {
        bookable: false,
        error: 'customer-suspended',
        message: `Customer ${customer.code} is suspended.`,
      },
      { status: 403 },
    );
  }

  const base = await baseCardFor(customer);
  const contracted = await contractedCard(customer);

  // Reverse charge and GST exemption change the total, so they belong on the quote.
  const billing = customer.commercial
    ? {
        billingType: customer.commercial.billingType,
        gstApplicable: customer.commercial.gstApplicable,
      }
    : undefined;

  // Offers that reach this customer at this moment. Resolved here rather than in the
  // engine because whether one applies depends on their product and their tags, which are
  // customer facts — the pricing engine has never needed to know them.
  const offers = await offersFor({
    at: new Date(),
    customerCode: customer.code,
    ...(customer.tags ? { tags: customer.tags } : {}),
    ...(customer.appliedProduct ? { productKey: customer.appliedProduct.key } : {}),
  });

  // The contract quote carries the customer's own cell map so its breakdown can say
  // which lanes were negotiated; the base quote has none by definition.
  const contractQuote = quote(
    shipment,
    endpoints,
    contracted,
    billing,
    customer.liveTerms.overrides,
    customer.liveTerms.laneRules,
    offers,
  );
  // Deliberately without offers: this is the standard price, and an offer is a discount
  // against it. Applying one to both sides would hide the discount it exists to show.
  const baseQuote = quote(shipment, endpoints, base, billing);

  // Zones and chargeable weight come from the quote, so the contract is checked
  // against exactly what would be billed.
  const resolved = contractQuote.available
    ? contractQuote.breakdown
    : baseQuote.available
      ? baseQuote.breakdown
      : null;

  if (!resolved) {
    return NextResponse.json(
      {
        bookable: false,
        error: 'lane-not-served',
        message:
          contractQuote.available === false
            ? contractQuote.message
            : 'This lane is not served by the requested mode.',
      },
      { status: 409 },
    );
  }

  const check = checkContract(customer.liveTerms.scope, {
    mode: q.mode as Mode,
    origin: resolved.originZone,
    destination: resolved.destinationZone,
    chargeableWeight: resolved.chargeableWeight,
  });

  const negotiated = Object.keys(customer.liveTerms.overrides).length;

  if (check.inContract && contractQuote.available) {
    // Being in contract settles the price. Whether it can be booked also depends on the
    // customer having the money for it — an exhausted limit or an overdue balance holds
    // the booking even though the rate is agreed.
    const terms = customer.commercial ?? DEFAULT_COMMERCIAL_TERMS;
    const funds = await canBook(
      customer.code,
      { creditLimit: terms.creditLimit, paymentTermsDays: terms.paymentTermsDays },
      contractQuote.breakdown.total,
    );

    return NextResponse.json(
      {
        bookable: funds.allowed,
        pricing: 'contract',
        customer: { code: customer.code, name: customer.name },
        inContract: true,
        negotiatedCells: negotiated,
        breakdown: contractQuote.breakdown,
        /** What the same shipment costs on the base card, for reference. */
        baseTotal: baseQuote.available ? baseQuote.breakdown.total : null,
        billing: customer.commercial ?? null,
        account: funds.allowed
          ? { clear: true }
          : {
              clear: false,
              reason: funds.reason,
              shortfall: funds.shortfall === undefined ? null : funds.shortfall / 100,
              message: funds.message,
            },
        warnings: contractQuote.warnings,
      },
      // 402 says the price is right but the money is not: a distinct case from a lane
      // that is out of contract, and the booking site has to handle it differently.
      { status: funds.allowed ? 200 : 402 },
    );
  }

  /**
   * Out of contract. The booking must not proceed on contract prices — but the
   * operator is shown the base price and told that booking at it needs approval,
   * which is the flow the business asked for.
   */
  return NextResponse.json(
    {
      bookable: false,
      pricing: 'out-of-contract',
      customer: { code: customer.code, name: customer.name },
      inContract: false,
      reasons: check.reasons,
      messages: check.messages,
      requiresApproval: true,
      approvalEndpoint: '/api/bookings/exceptions',
      fallback: baseQuote.available
        ? {
            pricing: 'base',
            breakdown: baseQuote.breakdown,
            note:
              'These are the standard prices, not this customer’s contracted rates. ' +
              'Booking at them requires an approved exception.',
          }
        : null,
    },
    { status: 409 },
  );
}
