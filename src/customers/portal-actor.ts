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

/** Resolves the customer in the path, or the 404 to return. */
export async function customerOr404(
  code: string,
): Promise<{ customer: CustomerDoc } | { response: NextResponse }> {
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
