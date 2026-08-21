import { NextResponse } from 'next/server';
import { authenticatedRequest } from '../../../../_auth';
import { findCustomer, baseCardFor } from '../../../../../../data/customers';
import { effectiveCard } from '../../../../../../customers/contract';
import {
  toLegacyCustomerRateCards,
  toLegacyCustomerMaster,
} from '../../../../../../core/legacy-shapes';

/**
 * A customer's negotiated rates, in the shape the core's Contracts tab reads.
 *
 * Replaces `CustomerRateCard.find({ custId })` and the `/contracts` response around it:
 * the customer block plus the rate rows, together, because that endpoint returns both and
 * the portal destructures them.
 *
 * For display, not for pricing. Their slab shape is a single rate applied to the whole
 * weight; ours can be cumulative bands. The numbers are the customer's real rates and are
 * right to show them — but putting them through their engine would produce a different
 * total, and nothing here should ever become an input to a price.
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

  const base = await baseCardFor(customer);
  const contracted = effectiveCard(base, customer.liveTerms);

  /**
   * Which lanes were actually negotiated.
   *
   * Read from the override keys rather than from the whole grid: a contract is the base
   * card plus the cells that moved, and listing every lane on the card would present a
   * customer with thousands of rows they never agreed.
   */
  const negotiated = new Map<string, { mode: string; origin: string; destination: string }>();
  for (const key of Object.keys(customer.liveTerms.overrides)) {
    // `grids.surface.tier2.PNQ.NCR`
    const parts = key.split('.');
    if (parts[0] !== 'grids' || parts.length < 5) continue;
    const [, mode, , origin, destination] = parts;
    if (!mode || !origin || !destination) continue;
    negotiated.set(`${mode}:${origin}:${destination}`, { mode, origin, destination });
  }

  const { rates, notRepresentable } = toLegacyCustomerRateCards(
    customer,
    {
      grids: contracted.data.grids as never,
      minWeight: {
        surface: contracted.data.charges.minWeightSurface,
        air: contracted.data.charges.minWeightAir,
        rail: contracted.data.charges.minWeightRail ?? contracted.data.charges.minWeightSurface,
      },
    },
    [...negotiated.values()],
  );

  const master = toLegacyCustomerMaster(customer);

  return NextResponse.json({
    success: true,
    data: {
      customer: {
        custId: master.custId,
        name: master.name,
        tier: master.tier,
        segment: master.segment,
        payment: master.payment,
        discountPct: master.discountPct,
        validFrom: master.validFrom,
        validTo: master.validTo,
      },
      rates,
      // Said out loud when part of the contract cannot be expressed in their shape, so a
      // caller never mistakes what it received for the whole agreement.
      ...(notRepresentable > 0
        ? {
            notRepresentable,
            note: `${notRepresentable} rule${notRepresentable === 1 ? '' : 's'} agreed at a granularity this shape cannot express (pincode or group). Ask the pricing service directly for those.`,
          }
        : {}),
    },
  });
}
