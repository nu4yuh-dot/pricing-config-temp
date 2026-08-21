/**
 * What this service sends to the SameX core, and what it expects back.
 *
 * The direction here is new and worth stating plainly: everywhere else, the core calls us.
 * This is the one path where we call the core — because the customer master moves here, and
 * the core still needs customer records to attach shipments to and to let a customer sign
 * in to the enterprise portal.
 *
 * The core cannot be edited by us, so these endpoints are a *request* to their team, not an
 * assumption. Until they exist, every push queues and nothing is lost: `CORE_API_URL` unset
 * means the queue simply does not drain. The day the endpoints ship, the backlog goes.
 *
 * Two rules govern the payload:
 *
 *   We send the whole customer, every time. Not a patch. A patch needs both sides to
 *   agree about what the current state was, and when they disagree the customer ends up
 *   half-updated with nobody able to say which half. A full record is idempotent: sending
 *   it twice leaves the same result as sending it once.
 *
 *   The customer code is ours and is the key. It is minted here, it never changes, and
 *   the core should treat it as the identifier to upsert on rather than generating its own.
 */

export interface CoreAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: number;
  country: string;
}

export interface CoreContact {
  name: string;
  role: string;
  email?: string;
  phone?: string;
}

export interface CorePlant {
  code: string;
  name: string;
  address: CoreAddress;
  gstin?: string;
  active: boolean;
}

export interface CorePortalLogin {
  email: string;
  name: string;
  /** Whether this person should be able to sign in right now. */
  active: boolean;
  /**
   * What they may do in the enterprise portal.
   *
   * `supply_chain_head` is the account holder and the only role permitted to change the
   * team. These are the core's own values, adopted verbatim so both systems say the same
   * word for the same permission.
   *
   * Sent because the core enforces it: we say who may do what, the core is the only system
   * that can stop them. A roster without roles would leave every member equally able to do
   * everything, which is not what the customer configured.
   */
  role: 'supply_chain_head' | 'logistics_head' | 'booking' | 'tracking';
}

/** Everything the core needs to hold about a customer we own. */
export interface CoreCustomerPayload {
  /** Minted here. Stable for the life of the customer, and the key to upsert on. */
  customerCode: string;
  name: string;
  /** Whether the customer may transact. A closed account keeps its history. */
  active: boolean;
  legalName?: string;
  tradeName?: string;
  gstin?: string;
  pan?: string;
  msmeNumber?: string;
  registeredAddress?: CoreAddress;
  billingAddress?: CoreAddress;
  contacts: CoreContact[];
  /** Shipping locations. A plant in another state carries its own registration. */
  plants: CorePlant[];
  /**
   * Who may sign in to the enterprise portal as this customer.
   *
   * The core issues the credential — we never hold a portal password. We name the people
   * who should have access; how they authenticate stays entirely with the core, which is
   * already the only system that authenticates anybody.
   */
  portalLogins: CorePortalLogin[];
  /**
   * The customer's saved places, for the booking form to offer.
   *
   * Sent because booking happens in the core, so that is where the address book has to be
   * usable. Mastered here, because a pincode decides a zone and a zone decides a price.
   */
  addresses: CoreAddress2[];
  /** Departments within plants, for cost attribution on a booking. */
  /**
   * Cost centres, each belonging to a plant.
   *
   * `active` travels with them because withdrawing a department here deactivates it rather
   * than deleting it — matching how the core withdraws one — and a payload that omitted the
   * flag would leave the core showing a department this side has retired.
   */
  departments: { id: string; name: string; plantCode: string; active: boolean }[];
  /**
   * Whether SameX staff may find this account when booking on the customer's behalf.
   *
   * The customer's own choice, off unless they turn it on. Mastered here with the rest of
   * their account so there is one place it is set and one place it is read, but acted on
   * entirely by the core — booking is theirs, and this only says whether the account is
   * offered to their staff.
   */
  adminBookingAccess: boolean;
  /** Rises on every push. Lets the core ignore a stale message that arrives out of order. */
  revision: number;
  /** When this revision was approved here. */
  updatedAt: string;
}

/** What we hope to get back. Only `ok` is required; the rest helps diagnosis. */
export interface CoreUpsertResult {
  ok: boolean;
  /** The core's own id for the customer, if it keeps one. Stored for support. */
  coreCustomerId?: string;
  message?: string;
}

/** An address-book entry, as the booking form needs it. */
export interface CoreAddress2 {
  id: string;
  label: string;
  company?: string;
  usedFor: 'pickup' | 'delivery' | 'both';
  contactName?: string;
  contactPhone?: string;
  addressLine: string;
  flat?: string;
  sector?: string;
  pincode?: number;
  gstin?: string;
  /** India Post grid code for the doorway. Not used in pricing. */
  digipin?: string;
  /** At most one per customer. Auto-fills a new booking. */
  defaultPickup?: boolean;
}

export const CORE_ENDPOINTS = {
  /** PUT, idempotent on customerCode. Creates on first send, updates thereafter. */
  upsertCustomer: (code: string) => `/api/v1/customers/${encodeURIComponent(code)}`,
} as const;
