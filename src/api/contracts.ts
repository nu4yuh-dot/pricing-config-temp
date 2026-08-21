import { z } from 'zod';
import { MODES } from '../domain/types';
import { BLUEDART_SERVICES } from '../domain/bluedart';
import { UPS_PRODUCTS } from '../domain/ups';
import { TEAM_ROLES, TEAM_STATUSES, ADDRESS_USES } from '../domain/enterprise';

/**
 * What every machine-facing endpoint accepts.
 *
 * These schemas live here rather than beside their routes for one reason: the published
 * API spec is generated from them. The platform handbook praises the core's reference for
 * being "generated from the running code, so it can't be out of date", and requires the
 * pricing service to publish its own contract the same way. A spec written by hand beside
 * schemas maintained separately is a spec that is wrong within a month — and wrong in the
 * direction that matters, because the caller believes it.
 *
 * (Next.js also refuses any export from a route file that is not a handler, so a route
 * module cannot be the home for something the spec needs to import.)
 *
 * Every field here is permanent. Adding one is free; renaming or removing one breaks a
 * caller that is already deployed, which is the single thing the platform's append-only
 * rule forbids outright. Where a field has been superseded, both names stay and the old
 * one is marked deprecated — never deleted.
 */

/* ------------------------------------------------------------------ quoting */

export const QuoteRequest = z.object({
  originPincode: z.union([z.string(), z.number()]),
  destinationPincode: z.union([z.string(), z.number()]).optional(),
  /** @deprecated Use `destinationPincode`. Accepted permanently. */
  destPincode: z.union([z.string(), z.number()]).optional(),
  actualWeight: z.coerce.number().positive(),
  length: z.coerce.number().nonnegative().optional(),
  width: z.coerce.number().nonnegative().optional(),
  height: z.coerce.number().nonnegative().optional(),
  /**
   * A chargeable weight the caller has already worked out.
   *
   * The handbook says the core sends chargeable weight; this service has always derived
   * its own from the dimensions. Both are now possible, and when a caller supplies one we
   * price on it — the caller is closer to the consignment than we are. What we will not do
   * is take it silently: the response reports the weight used, the weight we would have
   * derived, and the divisor we used, so a disagreement surfaces in the quote rather than
   * as an invoice that does not match it.
   */
  chargeableWeight: z.coerce.number().positive().optional(),
  /** Our customer code. Absent quotes the base card. */
  customerCode: z.string().trim().min(1).optional(),
  /** @deprecated Use `customerCode`. Accepted permanently. */
  customerId: z.string().trim().min(1).optional(),
  declaredValue: z.coerce.number().nonnegative().optional(),
  codValue: z.coerce.number().nonnegative().optional(),
  /** One of ECONOMY / EXPRESS / CRITICAL / RAIL, or a mode name. Absent returns all. */
  transportMode: z.string().trim().optional(),
});

export const NetworkQuoteQuery = z.object({
  customer: z.string().trim().min(1).optional(),
  mode: z.enum(MODES),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
  weight: z.coerce.number().positive(),
  length: z.coerce.number().nonnegative().optional(),
  breadth: z.coerce.number().nonnegative().optional(),
  height: z.coerce.number().nonnegative().optional(),
  pieces: z.coerce.number().int().positive().optional(),
  singlePackageOver100kg: z.coerce.boolean().optional(),
});

export const FtlQuoteQuery = z.object({
  customer: z.string().trim().min(1).optional(),
  vehicle: z.string().trim().min(1),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});

export const BluedartQuoteQuery = z.object({
  /** Whose quote this is. Absent asks for the book rate, which is not gated. */
  customer: z.string().trim().min(1).optional(),
  to: z.coerce.number().int().positive(),
  weight: z.coerce.number().positive(),
  service: z.enum(BLUEDART_SERVICES).optional(),
  value: z.coerce.number().nonnegative().optional(),
  length: z.coerce.number().nonnegative().optional(),
  breadth: z.coerce.number().nonnegative().optional(),
  height: z.coerce.number().nonnegative().optional(),
  pieces: z.coerce.number().int().positive().optional(),
});

export const UpsQuoteQuery = z.object({
  /** Whose quote this is. Absent asks for the book rate, which is not gated. */
  customer: z.string().trim().min(1).optional(),
  country: z.string().trim().min(2).max(3),
  /** Needed only where the card zones a country by postal code. China, today. */
  postal: z.string().trim().max(12).optional(),
  weight: z.coerce.number().positive(),
  product: z.enum(UPS_PRODUCTS).optional(),
  length: z.coerce.number().nonnegative().optional(),
  breadth: z.coerce.number().nonnegative().optional(),
  height: z.coerce.number().nonnegative().optional(),
  /** Comma-separated accessorial ids to apply on top of the defaults. */
  accessorials: z.string().trim().optional(),
});

/* ------------------------------------------------------------ shipments in */

const Amounts = z
  .object({
    taxableValue: z.number().nonnegative(),
    gst: z.number().nonnegative(),
    gstRate: z.number().min(0).max(1),
    sac: z.string().trim().min(1, 'sac must not be empty'),
    rcm: z.boolean(),
    total: z.number().nonnegative(),
  })
  .strict();

const Shipment = z
  .object({
    awb: z.string().trim().min(1, 'awb must not be empty'),
    coreShipmentId: z.string().trim().min(1, 'coreShipmentId must not be empty'),
    customerCode: z.string().trim().min(1, 'customerCode must not be empty'),
    bookedAt: z.string().datetime({ offset: true }),
    deliveredAt: z.string().datetime({ offset: true }).optional(),
    mode: z.enum(MODES),
    originPincode: z.string().trim().regex(/^\d{6}$/, 'originPincode must be six digits'),
    destinationPincode: z.string().trim().regex(/^\d{6}$/, 'destinationPincode must be six digits'),
    chargeableWeight: z.number().positive(),
    booked: Amounts,
    /**
     * Proof of delivery, when the core already has it.
     *
     * Optional because a shipment is usually pushed at booking, long before it is
     * delivered. Later changes come through the status update rather than a fresh batch.
     */
    pod: z
      .object({
        status: z.enum(['clear', 'unclear', 'pending', 'disputed']),
        verifiedAt: z.string().datetime({ offset: true }).optional(),
        verifiedBy: z.string().trim().min(1).optional(),
        method: z.enum(['signature', 'otp', 'digital', 'photo']).optional(),
        receiverName: z.string().trim().min(1).optional(),
        deliveredAt: z.string().datetime({ offset: true }).optional(),
        boxCount: z.number().int().positive().optional(),
        disputeStatus: z.enum(['open', 'investigating', 'resolved', 'rejected']).optional(),
        disputeAmount: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ShipmentIntakeBody = z
  .object({ shipments: z.array(Shipment).min(1).max(500) })
  .strict();

/* ----------------------------------------------------------------- the rest */

export const CustomerRegistration = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  /** Optional; defaults to the first card if the caller does not care. */
  baseCardKey: z.string().trim().optional(),
});

export const BookingExceptionRequest = z.object({
  customer: z.string().trim().min(1),
  mode: z.enum(MODES),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
  weight: z.coerce.number().positive(),
  requestedBy: z.string().trim().min(1).max(200),
  /** The quote the customer was shown. Ties the request to a price we can reproduce. */
  quoteId: z.string().trim().min(1).max(40).optional(),
  /**
   * Who accepted the out-of-contract price, if the customer was asked.
   *
   * Sent when the enterprise portal has told the customer the lane is outside their
   * contract, shown them what it would cost, and they have gone ahead. Optional because an
   * exception can equally be raised by a hub clerk on the phone — but where it is present
   * it is what makes the eventual charge defensible.
   */
  acceptedBy: z.string().trim().min(1).max(200).optional(),
  acceptedTotal: z.coerce.number().nonnegative().optional(),
});

/* ------------------------------------------------- what a customer asks for */

/**
 * A negotiation request raised by a customer in the enterprise portal.
 *
 * Deliberately allows an ask with no rates in it, because that is the common case: a
 * customer knows the lane they want covered and cannot know what it should cost. Rates are
 * accepted when they are making a counter-offer rather than a request.
 */
export const ContractRequestIntake = z
  .object({
    customer: z.string().trim().min(1).max(40),
    /** Who asked, as the portal knows them. Recorded, never used to authenticate. */
    raisedBy: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).optional(),
    modes: z.array(z.enum(MODES)).max(10).optional(),
    /** `mode:ORIGIN>DESTINATION`, the same lane key the contract screens use. */
    lanes: z.array(z.string().trim().min(3).max(80)).max(200).optional(),
    weightBands: z
      .array(z.object({ from: z.coerce.number().nonnegative(), to: z.coerce.number().positive().nullable() }))
      .max(20)
      .optional(),
    proposedRates: z
      .array(z.object({ bind: z.string().trim().min(1).max(200), value: z.coerce.number() }))
      .max(500)
      .optional(),
    /**
     * Routes as the enterprise portal's Rate Agreement form collects them.
     *
     * Hub-to-hub with a monthly volume, because hubs are what the core knows and volume is
     * what a rate is negotiated against. We resolve hubs to our zones; a hub we cannot
     * place is refused with a message naming it, never silently mapped to a neighbour.
     *
     * `city` is optional on both ends and defaults to ALL on their form — a route is
     * agreed at hub level, and the city is context for whoever prices it.
     */
    routes: z
      .array(
        z.object({
          /** The core's `IContractRequestRoute` field names, adopted verbatim. */
          origHub: z.string().trim().min(1).max(20).optional(),
          /** @deprecated Use `origHub`. Accepted permanently. */
          originHub: z.string().trim().min(1).max(20).optional(),
          origCity: z.string().trim().max(80).optional(),
          /** @deprecated Use `origCity`. Accepted permanently. */
          originCity: z.string().trim().max(80).optional(),
          destHub: z.string().trim().min(1).max(20),
          destCity: z.string().trim().max(80).optional(),
          /** Expected kilograms per month on this route. */
          estimatedMonthlyVolume: z.coerce.number().nonnegative().optional(),
          /** @deprecated Use `estimatedMonthlyVolume`. Accepted permanently. */
          volumeKgPerMonth: z.coerce.number().nonnegative().optional(),
        }).refine((route) => Boolean(route.origHub ?? route.originHub), {
          message: 'origHub is required on every route.',
        }),
      )
      .max(100)
      .optional(),
    /** When the customer wants the agreement to run from and to. */
    effectiveFrom: z.string().trim().optional(),
    effectiveTo: z.string().trim().optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.note ||
          value.modes?.length ||
          value.lanes?.length ||
          value.weightBands?.length ||
          value.proposedRates?.length ||
          value.routes?.length,
      ),
    { message: "A request needs to ask for something — coverage, rates, or a note saying what is wanted." },
  );

/* ------------------------------------------- the enterprise account settings */

/**
 * What the customer's own settings screens write back.
 *
 * These are mastered here and pushed to the core, so the portal has one place to read and
 * one place to write. Note what is absent: no password field on a team member, and no
 * field that could carry one. The core issues the credential; this is the roster naming
 * who should have it.
 */

const PhoneCountry = z.string().trim().regex(/^\+\d{1,4}$/, 'A dialling code looks like +91.');

/**
 * An address as the core's `SavedAddress` names its fields.
 *
 * `address`, `type`, `isDefault` and `phoneCode` are the core's, adopted so the portal can
 * send one shape to either system. The names we used first — `addressLine`, `usedFor`,
 * `defaultPickup`, `contactPhoneCountry` — are still accepted and always will be; a caller
 * sending either is understood.
 */
export const AddressUpsert = z.object({
  /** Absent creates; present edits that entry. */
  id: z.string().trim().min(1).max(64).optional(),
  label: z.string().trim().min(1).max(120),
  company: z.string().trim().max(200).optional(),
  type: z.enum(ADDRESS_USES).optional(),
  /** @deprecated Use `type`. Accepted permanently. */
  usedFor: z.enum(ADDRESS_USES).optional(),
  contactName: z.string().trim().max(200).optional(),
  phoneCode: PhoneCountry.optional(),
  /** @deprecated Use `phoneCode`. Accepted permanently. */
  contactPhoneCountry: PhoneCountry.optional(),
  contactPhone: z.string().trim().max(20).optional(),
  address: z.string().trim().min(1).max(500).optional(),
  /** @deprecated Use `address`. Accepted permanently. */
  addressLine: z.string().trim().min(1).max(500).optional(),
  /** Where the door actually is, when the core has geocoded it. Not used in pricing. */
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  flat: z.string().trim().max(120).optional(),
  sector: z.string().trim().max(120).optional(),
  pincode: z.coerce.number().int().min(100000).max(999999).optional(),
  gstin: z.string().trim().length(15).optional(),
  /** India Post grid code, e.g. 38J-7GH-42K. Recorded, not used for pricing. */
  digipin: z.string().trim().max(20).optional(),
  isDefault: z.boolean().optional(),
  /** @deprecated Use `isDefault`. Accepted permanently. */
  defaultPickup: z.boolean().optional(),
})
  .refine((value) => Boolean(value.address ?? value.addressLine), {
    message: 'address is required.',
  });

/** A plant, named as the core's `Plant` model names it. Our earlier names still work. */
export const PlantUpsert = z.object({
  code: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(200),
  /** "Mumbai, Maharashtra" as the portal collects it; split on the last comma. */
  location: z.string().trim().min(1).max(200),
  pincode: z.coerce.number().int().min(100000).max(999999).optional(),
  gstNumber: z.string().trim().length(15).optional(),
  /** @deprecated Use `gstNumber`. Accepted permanently. */
  gstin: z.string().trim().length(15).optional(),
  contactName: z.string().trim().max(200).optional(),
  /** @deprecated Use `contactName`. Accepted permanently. */
  contactPerson: z.string().trim().max(200).optional(),
  contactPhone: z.string().trim().max(20).optional(),
  isActive: z.boolean().optional(),
  /** @deprecated Use `isActive`. Accepted permanently. */
  active: z.boolean().optional(),
});

export const DepartmentUpsert = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(200),
  /** The plant this belongs to. A department cannot exist without one. */
  plantCode: z.string().trim().min(1).max(40),
  /**
   * Whether it is in use. Omitted means active — which is what a caller that predates this
   * field sends, and a department it created should not arrive withdrawn.
   *
   * `active` is also how a withdrawn department is brought back: `DELETE` deactivates rather
   * than destroying, so the row is still here to reactivate.
   */
  isActive: z.boolean().optional(),
  /** @deprecated Use `isActive`. Accepted permanently. */
  active: z.boolean().optional(),
});

export const TeamMemberUpsert = z.object({
  /** Who is asking. Only the account owner may change the team. */
  actorRole: z.enum(TEAM_ROLES),
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(1).max(200),
  role: z.enum(TEAM_ROLES),
  status: z.enum(TEAM_STATUSES).optional(),
}).strict();

export const BillingChangeRequest = z.object({
  raisedBy: z.string().trim().min(1).max(200),
  /** What they want changed, in their own words. Free text on the portal. */
  note: z.string().trim().min(1).max(2000),
});

/**
 * The portal's Configs tab.
 *
 * One switch today. Kept as an object rather than a bare boolean so the next preference is
 * an added field rather than a new endpoint.
 */
export const AccountConfigUpdate = z
  .object({
    /** Whether SameX staff may find this account when booking for the customer. */
    adminBookingAccess: z.boolean(),
  })
  .strict();

/**
 * A change to a shipment we already hold — in practice, proof of delivery arriving.
 *
 * Its own endpoint rather than a re-push of the whole batch: POD lands days after booking,
 * one shipment at a time, and asking the core to resend a 500-shipment batch to record one
 * signature would be absurd.
 */
export const ShipmentUpdate = z
  .object({
    pod: z
      .object({
        status: z.enum(['clear', 'unclear', 'pending', 'disputed']),
        verifiedAt: z.string().datetime({ offset: true }).optional(),
        verifiedBy: z.string().trim().min(1).optional(),
        method: z.enum(['signature', 'otp', 'digital', 'photo']).optional(),
        receiverName: z.string().trim().min(1).optional(),
        deliveredAt: z.string().datetime({ offset: true }).optional(),
        boxCount: z.number().int().positive().optional(),
        disputeStatus: z.enum(['open', 'investigating', 'resolved', 'rejected']).optional(),
        disputeAmount: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    deliveredAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((value) => value.pod !== undefined || value.deliveredAt !== undefined, {
    message: 'Send something to change — pod or deliveredAt.',
  });

/* ------------------------------------------- the customer reconciling a bill */

/**
 * A customer accepting or disputing one line of their bill.
 *
 * `by` is who at the customer said so, as their portal knows them. Recorded, never used to
 * authenticate — the service key already proved which system is asking.
 */
export const BillLineMark = z
  .object({
    by: z.string().trim().min(1).max(200),
    state: z.enum(['accepted', 'disputed']),
    /** Required on a dispute: a rejection nobody explained cannot be investigated. */
    reason: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((value) => value.state !== 'disputed' || Boolean(value.reason), {
    message: 'Say what is wrong with the line — a dispute with no reason cannot be looked into.',
  });

/** Accepting every outstanding line at once. */
export const BillAcceptAll = z.object({ by: z.string().trim().min(1).max(200) }).strict();
