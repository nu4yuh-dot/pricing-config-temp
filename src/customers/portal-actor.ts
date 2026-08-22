import { NextResponse } from 'next/server';
import { findCustomer, type CustomerDoc } from '../data/customers';
import type { ServiceCaller } from '../app/api/_auth';
import type { Actor } from '../data/workflow';

/**
 * Who a change from the enterprise portal is attributed to.
 *
 * The caller is a service key, not a person — the core is asking on a customer's behalf,
 * and a service key can never prove which person. So the audit trail says which service
 * asked, and the portal supplies the person's name in the payload where it matters (a
 * team change, a request). Inventing a person here would put a name in the audit log that
 * nobody could stand behind.
 */
export function portalActor(caller: ServiceCaller): Actor {
  return {
    id: `service:${caller.keyId}`,
    email: `${caller.keyId}@service`,
    name: `${caller.keyId} (enterprise portal)`,
  };
}

/**
 * The 403 for a caller reaching outside its scope, or null when it may proceed.
 *
 * Separate from `customerOr404` for the endpoints that take the customer in a query string
 * or a body rather than the path, and answer a 404 in their own shape — quoting says
 * `{bookable: false, error: 'unknown-customer'}`, not `{success: false}`. Forcing them
 * through the path helper would change a published response shape to add a check.
 */
export function outOfScope(
  caller: Pick<ServiceCaller, 'customerScope'>,
  code: string,
): NextResponse | null {
  if (caller.customerScope === null || caller.customerScope === code) return null;
  return NextResponse.json(
    {
      success: false,
      error: 'out-of-scope',
      message: `This key may only act for ${caller.customerScope}.`,
    },
    { status: 403 },
  );
}

/**
 * Resolves the customer in the path, or the response to return instead.
 *
 * The caller is a required argument, not an optional one. Every customer-scoped endpoint
 * already funnels through here, so this is the one place a tenant check cannot be
 * forgotten — and an optional parameter would mean the next endpoint added silently skips
 * it, which is the failure mode `_auth` avoids for rate limiting for the same reason.
 *
 * 403 rather than 404 for a customer that exists but is out of scope. A 404 would be a
 * small lie that leaks the same fact anyway: a scoped caller can distinguish "no such
 * customer" from "not yours" by timing and by the code it already knows, so pretending
 * otherwise buys nothing and makes a real misconfiguration look like a typo.
 */
export async function customerOr404(
  code: string,
  caller: Pick<ServiceCaller, 'customerScope'>,
): Promise<{ customer: CustomerDoc } | { response: NextResponse }> {
  if (caller.customerScope !== null && caller.customerScope !== code) {
    return {
      response: NextResponse.json(
        {
          success: false,
          error: 'out-of-scope',
          message: `This key may only act for ${caller.customerScope}.`,
        },
        { status: 403 },
      ),
    };
  }

  const customer = await findCustomer(code);
  if (!customer) {
    return {
      response: NextResponse.json(
        { success: false, message: `Unknown customer ${code}.` },
        { status: 404 },
      ),
    };
  }
  return { customer };
}
