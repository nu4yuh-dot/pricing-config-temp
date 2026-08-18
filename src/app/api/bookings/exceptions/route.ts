import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiKey, badRequest } from '../../_auth';
import {
  createBookingException,
  findBookingException,
  findCustomer,
  baseCardFor,
} from '../../../../data/customers';
import { findPincodePair } from '../../../../data/pincodes';
import { quote } from '../../../../pricing/quote';
import { checkContract } from '../../../../customers/contract';
import { recordAudit } from '../../../../data/audit';
import { MODES, type Mode } from '../../../../domain/types';

/**
 * Booking exceptions.
 *
 * When a customer wants a shipment their contract does not cover, the booking site
 * posts here. That creates a request for an admin, and returns a reference the
 * booking site polls with GET. Until the reference reads `approved`, the booking
 * must not go ahead.
 */

const CreateException = z.object({
  customer: z.string().trim().min(1),
  mode: z.enum(MODES),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
  weight: z.coerce.number().positive(),
  requestedBy: z.string().trim().min(1).max(200),
});

export async function POST(request: Request) {
  const unauthorised = requireApiKey(request);
  if (unauthorised) return unauthorised;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Body must be JSON.');
  }

  const parsed = CreateException.safeParse(body);
  if (!parsed.success) return badRequest('Invalid exception payload.', parsed.error.flatten());
  const input = parsed.data;

  const customer = await findCustomer(input.customer);
  if (!customer) {
    return NextResponse.json(
      { error: 'unknown-customer', message: `Customer ${input.customer} is not registered.` },
      { status: 404 },
    );
  }

  const { origin, destination } = await findPincodePair(input.from, input.to);
  if (!origin || !destination) {
    return badRequest('Both pincodes must be serviceable.');
  }

  const base = await baseCardFor(customer);
  const baseQuote = quote(
    { mode: input.mode as Mode, actualWeight: input.weight },
    { origin, destination },
    base,
  );
  if (!baseQuote.available) {
    return NextResponse.json(
      {
        error: 'lane-not-served',
        message: baseQuote.message,
        detail: 'An exception cannot be raised for a lane nobody serves.',
      },
      { status: 409 },
    );
  }

  const check = checkContract(customer.liveTerms.scope, {
    mode: input.mode as Mode,
    origin: baseQuote.breakdown.originZone,
    destination: baseQuote.breakdown.destinationZone,
    chargeableWeight: baseQuote.breakdown.chargeableWeight,
  });

  // Nothing to except: refuse rather than create noise in the admin's queue.
  if (check.inContract) {
    return NextResponse.json(
      {
        error: 'already-in-contract',
        message: 'This shipment is already covered by the contract; book it normally.',
      },
      { status: 409 },
    );
  }

  const exception = await createBookingException({
    customerCode: customer.code,
    mode: input.mode as Mode,
    fromPincode: input.from,
    toPincode: input.to,
    weight: input.weight,
    reasons: check.reasons,
    quotedTotal: baseQuote.breakdown.total,
    requestedBy: input.requestedBy,
  });

  await recordAudit({
    action: 'booking-exception-requested',
    actor: { id: 'booking-site', email: 'api@dnslogistic.com', name: input.requestedBy },
    at: exception.requestedAt,
    detail: {
      reference: exception.reference,
      customer: customer.code,
      lane: `${baseQuote.breakdown.originZone}→${baseQuote.breakdown.destinationZone}`,
      reasons: check.reasons.join(', '),
    },
  });

  return NextResponse.json(
    {
      reference: exception.reference,
      status: exception.status,
      message:
        'An admin has been asked to approve this booking. ' +
        'Poll this endpoint with the reference until it reads approved.',
      quotedTotal: exception.quotedTotal,
      reasons: exception.reasons,
    },
    { status: 202 },
  );
}

/** Poll a reference. The booking site must see `approved` before it books. */
export async function GET(request: Request) {
  const unauthorised = requireApiKey(request);
  if (unauthorised) return unauthorised;

  const reference = new URL(request.url).searchParams.get('reference');
  if (!reference) return badRequest('A reference query parameter is required.');

  const exception = await findBookingException(reference);
  if (!exception) {
    return NextResponse.json(
      { error: 'unknown-reference', message: `No exception request ${reference}.` },
      { status: 404 },
    );
  }

  return NextResponse.json({
    reference: exception.reference,
    status: exception.status,
    bookable: exception.status === 'approved',
    customer: exception.customerCode,
    quotedTotal: exception.quotedTotal,
    reasons: exception.reasons,
    decidedBy: exception.decidedBy ?? null,
    decidedAt: exception.decidedAt ?? null,
    comment: exception.decisionComment ?? null,
  });
}
