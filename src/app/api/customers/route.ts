import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiKey, badRequest } from '../_auth';
import { listCustomers, registerCustomer } from '../../../data/customers';
import { listCards } from '../../../data/rate-cards';

/**
 * Customer registration, called by the booking website when a customer is created
 * there.
 *
 * A new customer is put straight onto the base rate card with no overrides and no
 * scope restrictions — they are priced exactly like everyone else. Nothing about
 * their pricing changes until the team negotiates terms and an admin approves them,
 * so onboarding can never move a price on its own.
 *
 * Idempotent: posting the same code twice returns the existing customer with
 * `created: false` rather than erroring, because the booking site may retry.
 */

const CreateCustomer = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  /** Optional; defaults to the first card if the caller does not care. */
  baseCardKey: z.string().trim().optional(),
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

  const parsed = CreateCustomer.safeParse(body);
  if (!parsed.success) {
    return badRequest('Invalid customer payload.', parsed.error.flatten());
  }

  const cards = await listCards();
  if (cards.length === 0) {
    return NextResponse.json(
      { error: 'not-configured', message: 'No rate cards are seeded yet.' },
      { status: 503 },
    );
  }

  const requestedKey = parsed.data.baseCardKey;
  if (requestedKey && !cards.some((card) => card.key === requestedKey)) {
    return badRequest(
      `Unknown baseCardKey "${requestedKey}". Available: ${cards.map((c) => c.key).join(', ')}.`,
    );
  }
  const baseCardKey = requestedKey ?? (cards[0]?.key as string);

  const { customer, created } = await registerCustomer({
    code: parsed.data.code,
    name: parsed.data.name,
    baseCardKey,
    source: 'api',
    actor: { id: 'booking-site', email: 'api@dnslogistic.com', name: 'Booking site' },
  });

  return NextResponse.json(
    {
      created,
      customer: {
        code: customer.code,
        name: customer.name,
        baseCardKey: customer.baseCardKey,
        status: customer.status,
        // A fresh customer has none of either, which is the point.
        negotiatedCells: Object.keys(customer.liveTerms.overrides).length,
        billing: customer.commercial ?? null,
        contractRestricted:
          customer.liveTerms.scope.modes !== null ||
          customer.liveTerms.scope.lanes !== null ||
          customer.liveTerms.scope.weightBands !== null,
      },
    },
    { status: created ? 201 : 200 },
  );
}

export async function GET(request: Request) {
  const unauthorised = requireApiKey(request);
  if (unauthorised) return unauthorised;

  const customers = await listCustomers();
  return NextResponse.json({
    customers: customers.map((customer) => ({
      code: customer.code,
      name: customer.name,
      baseCardKey: customer.baseCardKey,
      status: customer.status,
      negotiatedCells: Object.keys(customer.liveTerms.overrides).length,
    })),
  });
}
