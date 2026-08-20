import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiKey, badRequest } from '../../_auth';
import { receiveShipments, type ShipmentIntake } from '../../../../data/shipments';
import { findCustomer } from '../../../../data/customers';
import { MODES } from '../../../../domain/types';

/**
 * Shipments in, from the core.
 *
 * A contract rather than just an endpoint: the caller is a different system written by
 * different people, and the failure mode is not a crash. It is a shipment accepted against
 * a field this service quietly ignored, which then bills wrong.
 *
 * So it is strict in a particular way — it names every field, **refuses unknown fields**
 * rather than ignoring them, and **refuses a field that is present but empty** rather than
 * treating it as absent. A caller sending `mode: ""` believing it said something has to be
 * told it did not.
 *
 * The amounts are the caller's: what the customer was quoted at booking, from this engine,
 * at the configuration in force that day. We do not reprice here — see `data/shipments.ts`.
 */

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
  })
  .strict();

const Body = z.object({ shipments: z.array(Shipment).min(1).max(500) }).strict();

export async function POST(request: Request) {
  const unauthorised = requireApiKey(request);
  if (unauthorised) return unauthorised;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest('Body must be JSON.');
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    // The whole batch is refused rather than the good half taken: a caller that thinks it
    // sent fifty and finds forty-one recorded has a reconciliation problem it cannot see.
    return badRequest(
      'No shipment was accepted. Every field is named and unknown or empty fields are refused.',
      parsed.error.flatten(),
    );
  }

  // A shipment for a customer we do not hold cannot be billed by us, and accepting it
  // would put a row in the ledger that no invoice can ever carry.
  const unknownCustomers: string[] = [];
  for (const code of new Set(parsed.data.shipments.map((s) => s.customerCode))) {
    if (!(await findCustomer(code))) unknownCustomers.push(code);
  }
  if (unknownCustomers.length > 0) {
    return NextResponse.json(
      {
        success: false,
        message: `No shipment was accepted. Unknown customer(s): ${unknownCustomers.join(', ')}.`,
        unknownCustomers,
      },
      { status: 409 },
    );
  }

  const batch: ShipmentIntake[] = parsed.data.shipments.map((s) => ({
    awb: s.awb,
    coreShipmentId: s.coreShipmentId,
    customerCode: s.customerCode,
    bookedAt: new Date(s.bookedAt),
    ...(s.deliveredAt === undefined ? {} : { deliveredAt: new Date(s.deliveredAt) }),
    mode: s.mode,
    originPincode: s.originPincode,
    destinationPincode: s.destinationPincode,
    chargeableWeight: s.chargeableWeight,
    booked: s.booked,
  }));

  const result = await receiveShipments(batch);

  // A conflict is a real disagreement about a shipment already recorded, so it is reported
  // as one — 409 — while retries of identical rows are simply accepted.
  return NextResponse.json(
    { success: result.conflicting.length === 0, ...result },
    { status: result.conflicting.length === 0 ? 200 : 409 },
  );
}
