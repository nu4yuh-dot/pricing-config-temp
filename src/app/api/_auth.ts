import { NextResponse } from 'next/server';

/**
 * Machine-to-machine auth for the booking website.
 *
 * A shared key in a header, compared in constant time. These endpoints carry
 * commercial rates, so an absent or misconfigured key fails closed — never open.
 */
export function requireApiKey(request: Request): NextResponse | null {
  const expected = process.env.BOOKING_API_KEY;
  if (!expected || expected.length < 24) {
    return NextResponse.json(
      {
        error: 'api-not-configured',
        message: 'BOOKING_API_KEY is not set on the pricing service.',
      },
      { status: 503 },
    );
  }

  const presented = request.headers.get('x-api-key') ?? '';
  if (!timingSafeEqual(presented, expected)) {
    return NextResponse.json(
      { error: 'unauthorised', message: 'A valid x-api-key header is required.' },
      { status: 401 },
    );
  }

  return null;
}

/** Compares without leaking length or position through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function badRequest(message: string, detail?: unknown): NextResponse {
  return NextResponse.json({ error: 'bad-request', message, detail }, { status: 400 });
}
