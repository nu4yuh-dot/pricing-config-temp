/**
 * The enterprise customer's own account: who works there, where they ship from, and how
 * they are billed.
 *
 * All of this is presented to the customer in the SameX enterprise portal, and all of it
 * is mastered here. The split that governs every type below:
 *
 *   We hold the record. Addresses, plants, departments, the team roster, the billing
 *   arrangement, the credit position. These decide what a shipment costs and what an
 *   invoice says, which makes them pricing data wearing an account-settings hat.
 *
 *   The core holds the credential. A password never reaches this service — not stored,
 *   not forwarded, not logged. We say *who* may sign in and as what; the core is the only
 *   system that can say *how* they prove it.
 *
 * That boundary is the reason `TeamMember` has no password field and never will.
 */

import type { Address, Contact } from './company';

/* ------------------------------------------------------------------- people */

/**
 * What someone at the customer may do.
 *
 * `owner` is the account holder — the enterprise portal shows them as "Supply Chain Head".
 * They are the only role that can create the other three, which is why it is a role here
 * rather than a flag: a permission that lives in one place cannot drift from the list it
 * governs.
 */
/**
 * The core's own role values, adopted verbatim.
 *
 * `supply_chain_head` rather than a tidier `owner`, because these strings already exist in
 * the core's `CustomerUser` documents and in every session it has issued. Renaming them
 * here would buy a nicer identifier and cost a migration of live accounts — and the two
 * systems would disagree in the meantime about what a person is allowed to do.
 */
export const TEAM_ROLES = [
  'supply_chain_head',
  'logistics_head',
  'booking',
  'tracking',
] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Names we used before reading the core's model. Accepted forever on input, never emitted.
 *
 * Cheaper than deciding who is deployed against which: a caller sending either is
 * understood, and everything we send out uses the core's vocabulary.
 */
export const TEAM_ROLE_ALIASES: Record<string, TeamRole> = {
  owner: 'supply_chain_head',
  logisticsHead: 'logistics_head',
  supplyChainHead: 'supply_chain_head',
};

export function asTeamRole(value: string): TeamRole | null {
  if ((TEAM_ROLES as readonly string[]).includes(value)) return value as TeamRole;
  return TEAM_ROLE_ALIASES[value] ?? null;
}

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  supply_chain_head: 'Supply Chain Head',
  logistics_head: 'Logistics Head',
  booking: 'Booking',
  tracking: 'Tracking',
};

export const TEAM_ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  supply_chain_head: 'Owns the account. The only role that can add or remove team members.',
  logistics_head: 'Manage shipments & team',
  booking: 'Create shipments, manage quotes',
  tracking: 'View & track delivery status',
};

/** Only the account owner may build the team. */
export function canManageTeam(role: TeamRole): boolean {
  return role === 'supply_chain_head';
}

export const TEAM_STATUSES = ['active', 'invited', 'disabled'] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

/**
 * Somebody at the customer who may sign in.
 *
 * No password, and no field that could hold one. The core issues and checks the
 * credential; this is the roster that tells it whom to issue one to.
 *
 * Disabling rather than deleting, because a member who booked shipments last quarter is
 * named on those records, and a roster that forgets them makes the history unreadable.
 */
export interface TeamMember {
  /** Their email, lower-cased. The identity the core signs them in by. */
  email: string;
  name: string;
  role: TeamRole;
  status: TeamStatus;
  addedAt: Date;
  /** Who added them. The owner, in practice, since nobody else may. */
  addedBy?: string;
}

/* ---------------------------------------------------------------- addresses */

/**
 * What an address in the book is for.
 *
 * Kept as three values rather than two booleans so it cannot express "neither", which is
 * an address the booking form would offer and then refuse.
 */
export const ADDRESS_USES = ['pickup', 'delivery', 'both'] as const;
export type AddressUse = (typeof ADDRESS_USES)[number];

export const ADDRESS_USE_LABELS: Record<AddressUse, string> = {
  pickup: 'Pickup only',
  delivery: 'Delivery only',
  both: 'Pickup & Delivery',
};

/**
 * A saved place, for the booking form to offer.
 *
 * Distinct from a plant, and deliberately so: a plant is a site the customer operates and
 * has a GST registration at, while an address book entry is anywhere they happen to send
 * things — a customer's warehouse, a trade show, a port. Collapsing them would either
 * demand a GSTIN for a delivery address that has none, or let a plant exist with no
 * registration behind it.
 */
export interface BookAddress {
  /** Stable id, ours. The portal edits by this. */
  id: string;
  /** What the customer calls it: "Pune Plant", "Chennai Warehouse". */
  label: string;
  company?: string;
  /** Named as the core names it. `pickup`, `delivery` or `both`. */
  type: AddressUse;
  contactName?: string;
  /** Dialling code held apart from the number, as the portal collects it. */
  phoneCode?: string;
  contactPhone?: string;
  /** Street / area / city / state, as one line, exactly as the portal asks for it. */
  address: string;
  flat?: string;
  sector?: string;
  /** Six digits. What resolves this address to a zone, and so to a price. */
  pincode?: number;
  gstin?: string;
  /**
   * India Post's DIGIPIN — a grid code for the exact doorway, like `38J-7GH-42K`.
   *
   * Carried because the customer types it and the core may use it for the last mile. It
   * plays no part in pricing: zones come from the pincode.
   */
  digipin?: string;
  /** Where the door actually is, when the core has geocoded it. Not used in pricing. */
  lat?: number;
  lng?: number;
  /**
   * The one that auto-fills every new booking.
   *
   * At most one per customer — enforced when writing, not by hoping. Two defaults is a
   * booking form that silently picks one of them.
   */
  isDefault?: boolean;
}

/* -------------------------------------------------------- plants & departments */

/**
 * A department within a plant.
 *
 * Cannot exist without one, which is why it carries the plant's code rather than an
 * address of its own — "Production" is meaningless until you know at which site.
 */
export interface Department {
  id: string;
  name: string;
  /** The `code` of a plant on this customer. */
  plantCode: string;
  /**
   * Whether this department is in use.
   *
   * Optional so records written before this field existed read as active — absent means
   * active, and treating an old department as withdrawn would hide shipments' cost centres
   * from whoever is reconciling them.
   */
  active?: boolean;
}

/* ------------------------------------------------------------------ billing */

/**
 * How much of a period's shipping is billed.
 *
 * "Only confirmed" bills what has actually been accepted; the alternative bills everything
 * booked, including what may still be cancelled. The difference is who carries the risk of
 * a cancellation after invoicing, so it is a commercial term, not a display preference.
 */
export const BILLING_BASES = [
  'POD Verified',
  'Delivery Date',
  'Dispatch Date',
  'Invoice Date',
] as const;
export type BillingBasis = (typeof BILLING_BASES)[number];

/**
 * The value is already the label. These read as sentences because that is what the core
 * stores and what an operator picked from a dropdown — turning them into codes would mean
 * migrating live `CustomerMaster` rows to gain nothing a person can see.
 */
export const BILLING_BASIS_LABELS: Record<BillingBasis, string> = {
  'POD Verified': 'POD Verified — billed once delivery is proven',
  'Delivery Date': 'Delivery Date',
  'Dispatch Date': 'Dispatch Date',
  'Invoice Date': 'Invoice Date',
};

/**
 * Which GST applies.
 *
 * `auto` is the honest default: whether a movement is inter- or intra-state is decided by
 * the two GSTINs on the consignment, not by an account setting. Holding it as a fixed
 * value is for the accounts that have agreed one, and `auto` says "work it out per
 * shipment" rather than pretending nobody chose.
 */
export const GST_TREATMENTS = [
  '18% IGST Interstate',
  '9% CGST + 9% SGST Intrastate',
  'Exempt',
  'Reverse Charge',
] as const;
export type GstTreatment = (typeof GST_TREATMENTS)[number];

export const GST_TREATMENT_LABELS: Record<GstTreatment, string> = {
  '18% IGST Interstate': '18% IGST — interstate',
  '9% CGST + 9% SGST Intrastate': '9% CGST + 9% SGST — intrastate',
  Exempt: 'Exempt',
  'Reverse Charge': 'Reverse charge — the consignee accounts for the GST',
};

/** When the credit clock starts. */
/**
 * How long the customer has to pay. The core stores this as a phrase, not a number.
 *
 * Kept as their strings, with a parser rather than a second field: two representations of
 * the same term is how one of them goes stale.
 */
export const CREDIT_PERIODS = [
  '7 Days',
  '15 Days',
  '30 Days',
  '45 Days',
  '60 Days',
  '90 Days',
] as const;
export type CreditPeriod = (typeof CREDIT_PERIODS)[number];

/** The number of days in a credit period, for anything that has to do arithmetic. */
export function creditPeriodDays(period: string | undefined): number | null {
  const match = /^(\d+)\s*Days?$/i.exec((period ?? '').trim());
  return match ? Number(match[1]) : null;
}

/** Billing cycles, as the core's admin screen offers them. */
export const BILLING_CYCLE_OPTIONS = [
  '1st → Last Day Monthly',
  '16th → 15th Monthly',
  'Weekly (Mon-Sun)',
] as const;
export type BillingCycleOption = (typeof BILLING_CYCLE_OPTIONS)[number];

/**
 * The commercial tier an account sits in.
 *
 * `walkIn` is where an account starts: no negotiated agreement, priced from the base card.
 * The rest are named so a person reading an invoice knows which arrangement produced it.
 */
export const ACCOUNT_TIERS = [
  'ENTERPRISE',
  'PREMIUM',
  'STANDARD',
  'SME',
  'STARTUP',
] as const;
export type AccountTier = (typeof ACCOUNT_TIERS)[number];

export const ACCOUNT_TIER_LABELS: Record<AccountTier, string> = {
  ENTERPRISE: 'Enterprise',
  PREMIUM: 'Premium',
  STANDARD: 'Standard',
  SME: 'SME',
  STARTUP: 'Startup',
};

/**
 * GST profiles, as the core's admin screen offers them.
 *
 * Separate from `GST_TREATMENTS`: the profile decides how tax is *computed* for the
 * account, the treatment records what was agreed. The core holds both, so we do too.
 */
export const GST_PROFILES = [
  'STANDARD',
  'FREIGHT_ONLY',
  'REDUCED',
  'EXEMPT',
  'INCLUSIVE',
] as const;
export type GstProfile = (typeof GST_PROFILES)[number];

/**
 * The billing arrangement as the customer's own portal shows it.
 *
 * Read-only to them — the portal marks it "Managed by SameX" and offers a Request Change
 * button, which is right: these decide what they are charged and when, and a customer
 * editing their own credit period is not a settings screen, it is a negotiation.
 */
export interface BillingConfig {
  /**
   * Free text, not the enum.
   *
   * The core's own data holds values its dropdown never offered — the account in the
   * screenshots is on "Walk-in", which is not one of the five. Typing this as the enum
   * would refuse to read rows that already exist, so the list is a suggestion for a form,
   * not a constraint on the data.
   */
  tier: string;
  basis?: BillingBasis;
  gstTreatment?: GstTreatment;
  gstProfile?: GstProfile;
  creditPeriod?: string;
  cycle?: string;
}

/** Everything above, as it hangs off a customer. */
export interface EnterpriseAccount {
  team: TeamMember[];
  addresses: BookAddress[];
  departments: Department[];
  billing?: BillingConfig;
}

export type { Address, Contact };
