import type { CoreCustomerPayload, CoreAddress } from '../core/contract';
import type { CompanyProfile, Address } from '../domain/company';
import type { CustomerDoc } from '../data/customers';

/**
 * Our customer, in the shape the core needs.
 *
 * A translation rather than a dump. Three things it decides:
 *
 *   Only master data crosses. Contract terms, negotiated rates and settlement
 *   arrangements stay here. The core does not price and has no use for them, and sending
 *   commercial terms to a system that does not need them is how they end up on a screen
 *   somebody should not be looking at.
 *
 *   Portal access is explicit. Only contacts marked for it are named as people who may
 *   sign in. A contact recorded so somebody knows who to ring is not thereby granted a view
 *   of that customer's rates.
 *
 *   Absent optional fields are omitted, not sent as empty strings. An empty GSTIN is a
 *   different claim from an unknown one, and a core that stores `""` will happily print it
 *   on an invoice.
 */

const address = (value: Address | undefined): CoreAddress | undefined =>
  value === undefined
    ? undefined
    : {
        line1: value.line1,
        ...(value.line2 ? { line2: value.line2 } : {}),
        city: value.city,
        state: value.state,
        pincode: value.pincode,
        country: value.country,
      };

const optional = (value: string | undefined) =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

/**
 * The sign-in list, from the roster first and legacy flagged contacts second.
 *
 * A disabled member is sent as inactive rather than omitted: omitting them would leave the
 * core with no instruction about somebody it already knows, and "no instruction" is not
 * "revoke".
 */
function portalLogins(customer: CustomerDoc): CoreCustomerPayload['portalLogins'] {
  const closed = customer.active === false;
  const logins = new Map<string, CoreCustomerPayload['portalLogins'][number]>();

  for (const contact of customer.profile?.contacts ?? []) {
    const email = contact.email?.trim().toLowerCase();
    if (!email || contact.portalAccess !== true) continue;
    logins.set(email, {
      email,
      name: contact.name,
      active: !closed,
      // The older route granted access without a role; booking is the least it could have
      // meant, and guessing higher would hand somebody the team screen by accident.
      role: 'booking',
    });
  }

  for (const member of customer.enterprise?.team ?? []) {
    const email = member.email.trim().toLowerCase();
    logins.set(email, {
      email,
      name: member.name,
      active: !closed && member.status === 'active',
      role: member.role,
    });
  }

  return [...logins.values()];
}

export function toCorePayload(customer: CustomerDoc): CoreCustomerPayload {
  const profile: CompanyProfile | undefined = customer.profile;

  const registered = address(profile?.registeredAddress);
  const billing = address(profile?.billingAddress);

  return {
    customerCode: customer.code,
    name: customer.name,
    // Absent means active: every customer written before the field existed is trading.
    active: customer.active !== false,
    ...(optional(profile?.legalName) ? { legalName: profile!.legalName } : {}),
    ...(optional(profile?.tradeName) ? { tradeName: profile!.tradeName! } : {}),
    ...(optional(profile?.gstin) ? { gstin: profile!.gstin! } : {}),
    ...(optional(profile?.pan) ? { pan: profile!.pan! } : {}),
    ...(optional(profile?.msmeNumber) ? { msmeNumber: profile!.msmeNumber! } : {}),
    ...(registered ? { registeredAddress: registered } : {}),
    ...(billing ? { billingAddress: billing } : {}),
    contacts: (profile?.contacts ?? []).map((contact) => ({
      name: contact.name,
      role: contact.role,
      ...(optional(contact.email) ? { email: contact.email! } : {}),
      ...(optional(contact.phone) ? { phone: contact.phone! } : {}),
    })),
    plants: (profile?.plants ?? []).map((plant) => ({
      code: plant.code,
      name: plant.name,
      address: address(plant.address)!,
      ...(optional(plant.gstin) ? { gstin: plant.gstin! } : {}),
      active: plant.active,
    })),
    /**
     * Who may sign in, and as what.
     *
     * Two sources, deliberately. The team roster is the customer's own list, managed by
     * their account owner in the portal. Company contacts marked for portal access are the
     * older route, from before the roster existed, and are folded in so nobody who could
     * sign in yesterday is locked out today — the roster wins where both name the same
     * person.
     *
     * A password appears nowhere in this payload, and there is no field for one. We name
     * who should have access; the core issues and checks the credential.
     */
    portalLogins: portalLogins(customer),
    addresses: (customer.enterprise?.addresses ?? []).map((entry) => ({
      id: entry.id,
      label: entry.label,
      ...(optional(entry.company) ? { company: entry.company! } : {}),
      usedFor: entry.type,
      ...(optional(entry.contactName) ? { contactName: entry.contactName! } : {}),
      ...(optional(entry.contactPhone)
        ? { contactPhone: `${entry.phoneCode ?? ''}${entry.contactPhone}`.trim() }
        : {}),
      addressLine: entry.address,
      ...(optional(entry.flat) ? { flat: entry.flat! } : {}),
      ...(optional(entry.sector) ? { sector: entry.sector! } : {}),
      ...(entry.pincode === undefined ? {} : { pincode: entry.pincode }),
      ...(optional(entry.gstin) ? { gstin: entry.gstin! } : {}),
      ...(optional(entry.digipin) ? { digipin: entry.digipin! } : {}),
      ...(entry.isDefault ? { defaultPickup: true } : {}),
    })),
    departments: (customer.enterprise?.departments ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      plantCode: entry.plantCode,
    })),
    // Off unless the customer turned it on. Absent means off, so a customer who has never
    // seen the switch is not quietly opted in.
    adminBookingAccess: customer.adminBookingAccess === true,
    revision: customer.coreRevision ?? 1,
    updatedAt: new Date().toISOString(),
  };
}
