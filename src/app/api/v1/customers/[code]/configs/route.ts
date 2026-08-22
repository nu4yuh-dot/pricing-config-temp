import { NextResponse } from 'next/server';
import { AccountConfigUpdate } from '../../../../../../api/contracts';
import { authenticatedJson, badRequest } from '../../../../_auth';
import { setAdminBookingAccess } from '../../../../../../data/enterprise';
import { portalActor, customerOr404 } from '../../../../../../customers/portal-actor';

/**
 * The customer's own preferences — the portal's Configs tab.
 *
 * Held here rather than in the core so it travels with the rest of their account: one
 * place it is set, one place it is read, and it reaches the core on the same push as
 * everything else. Acting on it is entirely the core's, since booking is theirs.
 */
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;

  const parsed = AccountConfigUpdate.safeParse(auth.body);
  if (!parsed.success) return badRequest('Invalid config.', parsed.error.flatten());

  const { code } = await params;
  const customer = await customerOr404(code, auth.caller);
  if ('response' in customer) return customer.response;

  const saved = await setAdminBookingAccess(
    customer.customer.code,
    parsed.data.adminBookingAccess,
    portalActor(auth.caller),
  );

  return NextResponse.json({ success: true, data: { adminBookingAccess: saved } });
}
