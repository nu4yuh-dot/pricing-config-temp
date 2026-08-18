import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiKey, badRequest } from '../_auth';
import { recordSignup } from '../../../data/signups';

/**
 * A signup from dnslogistics.com/signup.
 *
 * Records a request to become a customer. Nothing is priced and nobody can book: the
 * signup waits in a queue until a person puts them on a product. That is deliberate —
 * the suggestion rules read a dropdown answer about what somebody sells, which is a fair
 * guess and not a thing to let activate itself.
 */

const NewSignup = z.object({
  legalName: z.string().trim().min(1).max(200),
  channel: z.enum(['own-website', 'marketplace', 'local-shop', 'other']),
  declaredVolume: z.number().int().nonnegative().optional(),
  gstin: z.string().trim().max(20).optional(),
  pan: z.string().trim().max(20).optional(),
  addressLine: z.string().trim().max(300).optional(),
  contactEmail: z.string().trim().email().optional(),
  contactPhone: z.string().trim().max(20).optional(),
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

  const parsed = NewSignup.safeParse(body);
  if (!parsed.success) {
    return badRequest('Invalid signup payload.', parsed.error.flatten());
  }

  const signup = await recordSignup(parsed.data);
  return NextResponse.json(
    {
      reference: signup.reference,
      status: signup.status,
      message: 'Received. An account is opened once somebody has confirmed the product.',
    },
    { status: 201 },
  );
}
