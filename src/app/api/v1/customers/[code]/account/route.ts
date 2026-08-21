import { NextResponse } from 'next/server';
import { authenticatedRequest } from '../../../../_auth';
import { findCustomer } from '../../../../../../data/customers';
import { accountOf, creditSnapshot } from '../../../../../../data/enterprise';
import { settlementFor } from '../../../../../../data/settlement';
import {
  ACCOUNT_TIER_LABELS,
  BILLING_BASIS_LABELS,
  GST_TREATMENT_LABELS,
  CREDIT_PERIODS,
  BILLING_CYCLE_OPTIONS,
  GST_PROFILES,
  TEAM_ROLE_LABELS,
  TEAM_ROLE_DESCRIPTIONS,
  ADDRESS_USE_LABELS,
} from '../../../../../../domain/enterprise';
import { CYCLE_LABELS } from '../../../../../../billing/settlement';

/**
 * Everything the enterprise portal's Account Settings page shows, in one call.
 *
 * One request rather than eight, because it is one screen. Eight would make the page as
 * slow as its slowest section and give it eight ways to be half-loaded.
 *
 * It also returns the option lists — roles, address uses, billing cycles — rather than
 * leaving the portal to hard-code them. A dropdown built from a copied list is a dropdown
 * that eventually offers something this service will refuse, and the customer finds out
 * on save.
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
    return NextResponse.json({ success: false, message: `Unknown customer ${code}.` }, { status: 404 });
  }

  const account = accountOf(customer);
  const settlement = await settlementFor(customer.settlement);
  const credit = await creditSnapshot(customer);

  return NextResponse.json({
    success: true,
    data: {
      profile: {
        customerCode: customer.code,
        name: customer.name,
        legalName: customer.profile?.legalName ?? null,
        tradeName: customer.profile?.tradeName ?? null,
        gstin: customer.profile?.gstin ?? null,
        pan: customer.profile?.pan ?? null,
        msmeNumber: customer.profile?.msmeNumber ?? null,
        registeredAddress: customer.profile?.registeredAddress ?? null,
        billingAddress: customer.profile?.billingAddress ?? null,
        active: customer.active !== false,
      },
      configs: {
        // Off unless they turned it on, so a customer who has never seen the switch is
        // not quietly opted in.
        adminBookingAccess: customer.adminBookingAccess === true,
      },
      addresses: account.addresses,
      plants: customer.profile?.plants ?? [],
      departments: account.departments,
      team: account.team,
      billing: {
        // Read-only to the customer. The portal marks it "Managed by SameX" and offers a
        // change request, which is right: these decide what they are charged.
        managedBySameX: true,
        tier: account.billing?.tier ?? 'Walk-in',
        cycle: settlement?.cycle ?? null,
        basis: account.billing?.basis ?? null,
        gstTreatment: account.billing?.gstTreatment ?? null,
        creditPeriod: account.billing?.creditPeriod ?? null,
        gstProfile: account.billing?.gstProfile ?? null,
        creditPeriodDays: settlement?.credit.periodDays ?? null,
      },
      credit,
      options: {
        teamRoles: Object.entries(TEAM_ROLE_LABELS).map(([value, label]) => ({
          value,
          label,
          description: TEAM_ROLE_DESCRIPTIONS[value as keyof typeof TEAM_ROLE_DESCRIPTIONS],
          // Only the owner may build the team; the portal can grey the rest out rather
          // than letting somebody try and be refused.
          managesTeam: value === 'owner',
        })),
        addressUses: Object.entries(ADDRESS_USE_LABELS).map(([value, label]) => ({ value, label })),
        // The core's own cycle wording, plus ours from the settlement profiles. Both are
        // offered because a customer may be on either until the two are reconciled.
        billingCycles: [
          ...BILLING_CYCLE_OPTIONS.map((value) => ({ value, label: value })),
          ...Object.entries(CYCLE_LABELS).map(([value, label]) => ({ value, label })),
        ],
        accountTiers: Object.entries(ACCOUNT_TIER_LABELS).map(([value, label]) => ({ value, label })),
        billingBases: Object.entries(BILLING_BASIS_LABELS).map(([value, label]) => ({ value, label })),
        gstTreatments: Object.entries(GST_TREATMENT_LABELS).map(([value, label]) => ({ value, label })),
        creditPeriods: CREDIT_PERIODS.map((value) => ({ value, label: value })),
        gstProfiles: GST_PROFILES.map((value) => ({ value, label: value })),
      },
    },
  });
}
