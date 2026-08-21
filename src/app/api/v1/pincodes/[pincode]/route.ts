import { NextResponse } from 'next/server';
import { authenticatedRequest, badRequest } from '../../../_auth';
import { findPincode } from '../../../../../data/pincodes';
import { toLegacyPincode } from '../../../../../core/legacy-shapes';

/**
 * One pincode, in the shape the core's own `Pincode` documents have.
 *
 * This is the single most-called replacement. Seven places in the core do
 * `Pincode.findOne({ pincode })` today — booking, shipment creation, hub routes, the
 * e-way bill state lookup — and every one of them keeps working by calling this instead,
 * because the document that comes back has the same fields under the same names.
 *
 * Serviceability is the useful signal here: a 404 means we do not serve it, which is a
 * different answer from a pincode that exists and is out of zone.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ pincode: string }> },
) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const { pincode } = await params;
  if (!/^\d{6}$/.test(pincode)) return badRequest('A pincode is six digits.');

  const found = await findPincode(Number(pincode));
  if (!found) {
    return NextResponse.json(
      { success: false, message: `${pincode} is not serviceable.` },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, data: toLegacyPincode(found) });
}
