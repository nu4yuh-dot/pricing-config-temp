import { NextResponse } from 'next/server';
import { authenticatedRequest } from '../../_auth';
import { allPincodes } from '../../../../data/pincodes';
import { toLegacyCities } from '../../../../core/legacy-shapes';

/**
 * The city reference list, in the core's shape.
 *
 * Replaces `CityReference.find().sort({ hub: 1, cityName: 1 })`, which fills the city
 * dropdowns on the contract-request form. Sorted the same way, so their form renders
 * identically without sorting again.
 *
 * Derived from the pincode master rather than stored: a second list of cities would go
 * stale the first time a pincode changed hub, and nothing would say so.
 */
export async function GET(request: Request) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const cities = toLegacyCities(await allPincodes());
  return NextResponse.json({ success: true, data: cities });
}
