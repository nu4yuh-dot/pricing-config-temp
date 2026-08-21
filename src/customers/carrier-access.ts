import type { CustomerDoc } from '../data/customers';

/**
 * Which carriers a customer may be quoted.
 *
 * The core gates this per customer — `carrierAccess: { bluedart, velocity }` on their
 * `CustomerUser`, switched on by an admin. We were ignoring it, which meant we would
 * happily quote a Bluedart rate to an account not enabled for Bluedart. A price nobody may
 * book is worse than no price: somebody plans around it.
 *
 * Our own network is never gated. It is not a carrier the customer opts into; it is the
 * thing they signed up for.
 */

/** The carrier a rate card's source prices for. */
export const SOURCE_CARRIERS: Record<string, string> = {
  dns: 'own',
  bluedart: 'bluedart',
  ups: 'ups',
};

/**
 * What a carrier is called when telling somebody they cannot use it.
 *
 * Separate from the card name on purpose. A card is named for what it is —
 * "Bluedart — franchise, directional zones" — which is right on a rate screen and clumsy in
 * a sentence refusing a booking. All four quoting routes read this, so they refuse in the
 * same words.
 */
export const CARRIER_NAMES: Record<string, string> = {
  own: 'the DNS network',
  bluedart: 'Bluedart',
  ups: 'UPS / MOVIN',
  velocity: 'velocity',
};

export function carrierName(carrierId: string): string {
  return CARRIER_NAMES[carrierId] ?? carrierId;
}

/** Never gated: it is the default network, not an opt-in partner. */
const ALWAYS_ALLOWED = 'own';

/**
 * Whether this customer may be quoted this carrier.
 *
 * Absent access for a named carrier is a refusal, not a permission. The core's own
 * fallback grandfathers enterprise accounts, but that is their decision to make about
 * their data — inferring it here would mean two systems disagreeing about who may book
 * what, and ours would be the one guessing.
 */
export function mayUseCarrier(customer: CustomerDoc | null, carrierId: string): boolean {
  if (carrierId === ALWAYS_ALLOWED) return true;
  // An anonymous quote is not a customer's quote; it is the book rate, and the book rate
  // is public.
  if (!customer) return true;
  const access = customer.carrierAccess;
  if (!access) return true;
  return access[carrierId] === true;
}

/** What to tell the caller, naming who can change it. */
export function carrierRefusedMessage(customerName: string, carrierName: string): string {
  return `${customerName} is not enabled for ${carrierName}. A SameX admin can turn it on for this account.`;
}
