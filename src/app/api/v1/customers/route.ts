import { NextResponse } from 'next/server';
import { CustomerRegistration } from '../../../../api/contracts';
import { authenticatedJson, authenticatedRequest, badRequest } from '../../_auth';

/** The most rows one page may carry, however large a limit is asked for. */
const MAX_PAGE = 200;
import { listCustomers, registerCustomer } from '../../../../data/customers';
import { listCards } from '../../../../data/rate-cards';

export async function POST(request: Request) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;
  const body = auth.body;

  const parsed = CustomerRegistration.safeParse(body);
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
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  /**
   * Paging, added without moving anything.
   *
   * This returned every customer in one array. Fine at today's volume and not a list a
   * portal can page through, so `limit` and `cursor` are accepted — and **omitting both
   * still returns everything**, because callers are installed against that and a list that
   * silently truncated would be worse than a long one.
   *
   * The cursor is the last `code` seen rather than an offset. An offset skips rows by
   * position, so a customer created while somebody is paging shifts every later page and one
   * account is read twice while another is missed entirely. Codes are unique and ordered, so
   * a cursor cannot do that.
   */
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get('limit');
  const cursor = url.searchParams.get('cursor');

  const requested = rawLimit === null ? null : Number(rawLimit);
  if (requested !== null && (!Number.isFinite(requested) || requested < 1)) {
    return badRequest('limit must be a positive whole number.');
  }
  // Capped: a caller asking for a million rows gets a page, not the database.
  const limit = requested === null ? null : Math.min(Math.floor(requested), MAX_PAGE);

  const all = await listCustomers();
  const ordered = [...all].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const after = cursor === null ? ordered : ordered.filter((customer) => customer.code > cursor);
  const page = limit === null ? after : after.slice(0, limit);
  const last = page[page.length - 1];

  return NextResponse.json({
    customers: page.map((customer) => ({
      code: customer.code,
      name: customer.name,
      baseCardKey: customer.baseCardKey,
      status: customer.status,
      negotiatedCells: Object.keys(customer.liveTerms.overrides).length,
    })),
    /**
     * Present only when paging was asked for, so the unpaged response is byte-for-byte what
     * it always was. `nextCursor` is null on the last page — the signal to stop.
     */
    ...(limit === null
      ? {}
      : {
          page: {
            limit,
            returned: page.length,
            nextCursor: last !== undefined && after.length > page.length ? last.code : null,
          },
        }),
  });
}
