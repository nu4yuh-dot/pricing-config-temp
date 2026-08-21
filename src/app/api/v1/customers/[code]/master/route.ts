import { NextResponse } from 'next/server';
import { authenticatedRequest } from '../../../../_auth';
import { findCustomer } from '../../../../../../data/customers';
import { toLegacyCustomerMaster } from '../../../../../../core/legacy-shapes';

/**
 * A customer in the core's `CustomerMaster` shape.
 *
 * Replaces `CustomerMaster.findOne({ custId })`, which four surviving places rely on —
 * the enterprise portal's billing configuration, the contract-request form, and two admin
 * lookups. `custId` is our customer code: the one key both systems already agree on.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const { code } = await params;
  const customer = await findCustomer(code);
  if (!customer) {
    return NextResponse.json(
      { success: false, message: `Unknown customer ${code}.` },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, data: toLegacyCustomerMaster(customer) });
}
