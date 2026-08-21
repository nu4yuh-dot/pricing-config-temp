import { NextResponse } from 'next/server';
import { ShipmentUpdate } from '../../../../../api/contracts';
import { authenticatedJson, authenticatedRequest, badRequest } from '../../../_auth';
import { findShipment, updateShipment } from '../../../../../data/shipments';

/**
 * One shipment we hold, and changes to it.
 *
 * PATCH exists for proof of delivery. It lands days after booking, one shipment at a time,
 * and a billing basis of "POD Verified" holds the invoice until it does — so this is the
 * call that decides whether a consignment is billable this period.
 *
 * A whole-batch re-push would be the alternative, and asking the core to resend five
 * hundred shipments to record one signature is not a design, it is a shrug.
 */
export async function GET(request: Request, { params }: { params: Promise<{ awb: string }> }) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const { awb } = await params;
  const shipment = await findShipment(awb);
  if (!shipment) {
    return NextResponse.json({ success: false, message: `No shipment ${awb}.` }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    data: {
      awb: shipment.awb,
      customerCode: shipment.customerCode,
      status: shipment.status,
      bookedAt: shipment.bookedAt,
      deliveredAt: shipment.deliveredAt ?? null,
      pod: shipment.pod ?? null,
      booked: shipment.booked,
      invoiceNumber: shipment.invoiceNumber ?? null,
    },
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ awb: string }> }) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;

  const parsed = ShipmentUpdate.safeParse(auth.body);
  if (!parsed.success) return badRequest('Invalid shipment update.', parsed.error.flatten());
  const input = parsed.data;

  const { awb } = await params;
  const updated = await updateShipment(awb, {
    // Dates arrive as ISO strings and are stored as dates — spreading the parsed object
    // would leave strings in the record, and a string never compares as a date.
    ...(input.pod === undefined
      ? {}
      : {
          pod: {
            status: input.pod.status,
            ...(input.pod.verifiedAt ? { verifiedAt: new Date(input.pod.verifiedAt) } : {}),
            ...(input.pod.verifiedBy ? { verifiedBy: input.pod.verifiedBy } : {}),
            ...(input.pod.method ? { method: input.pod.method } : {}),
            ...(input.pod.receiverName ? { receiverName: input.pod.receiverName } : {}),
            ...(input.pod.deliveredAt ? { deliveredAt: new Date(input.pod.deliveredAt) } : {}),
            ...(input.pod.boxCount === undefined ? {} : { boxCount: input.pod.boxCount }),
            ...(input.pod.disputeStatus ? { disputeStatus: input.pod.disputeStatus } : {}),
            ...(input.pod.disputeAmount === undefined
              ? {}
              : { disputeAmount: input.pod.disputeAmount }),
          },
        }),
    ...(input.deliveredAt === undefined ? {} : { deliveredAt: new Date(input.deliveredAt) }),
  });

  if (!updated) {
    // A POD for a shipment we were never told about: the push has not arrived, or never
    // will. Saying so is better than creating a shipment out of a signature.
    return NextResponse.json(
      { success: false, message: `No shipment ${awb}. Push the shipment before its POD.` },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, data: { awb: updated.awb, pod: updated.pod ?? null } });
}
