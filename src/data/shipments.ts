import { ObjectId, type Collection } from 'mongodb';
import { db, COLLECTIONS } from './mongo';

/**
 * Shipments, as the core tells us about them.
 *
 * This service prices shipments; it has never recorded one. Invoicing cannot work without
 * them — the ruling is that a bill carries a detailed AWB annexure and an invoice with no
 * annexure rows is refused at issue — so the AWBs have to arrive from the system that owns
 * bookings.
 *
 * **The amounts are the core's, not ours.** They are what the customer was quoted at
 * booking, from this engine, at the configuration in force that day. Repricing at invoice
 * time would bill a number nobody agreed to: a rate revised last week would silently
 * restate a shipment moved last month. So the booked figures are stored as sent and are
 * what the invoice bills, and a later reconciliation can report divergence without
 * changing anybody's bill.
 *
 * Idempotent on the AWB. The core may retry, and a retry that produced a second billable
 * shipment would bill the same consignment twice.
 */

export interface ShipmentDoc {
  _id: ObjectId;
  /** The AWB or docket. How a customer queries a line on their invoice. */
  awb: string;
  /** The core's own id, so a query there can be matched to a line here. */
  coreShipmentId: string;
  customerCode: string;
  bookedAt: Date;
  /** When it was delivered, if it has been. Billing may wait for this. */
  deliveredAt?: Date;
  mode: string;
  originPincode: string;
  destinationPincode: string;
  chargeableWeight: number;
  /** What the customer was quoted, in rupees, as the core priced it from this engine. */
  booked: {
    taxableValue: number;
    gst: number;
    gstRate: number;
    sac: string;
    rcm: boolean;
    total: number;
  };
  /** `billed` once an invoice carries it, so the same AWB cannot reach two invoices. */
  status: 'received' | 'billed' | 'cancelled';
  invoiceNumber?: string;
  receivedAt: Date;
}

async function shipments(): Promise<Collection<ShipmentDoc>> {
  return (await db()).collection<ShipmentDoc>(COLLECTIONS.shipments);
}

export type ShipmentIntake = Omit<ShipmentDoc, '_id' | 'status' | 'receivedAt' | 'invoiceNumber'>;

export interface IntakeResult {
  accepted: string[];
  /** Already held, with the same figures. A retry, and not an error. */
  duplicate: string[];
  /** Already held with DIFFERENT figures, which is a conflict somebody must look at. */
  conflicting: { awb: string; why: string }[];
}

/**
 * Take a batch of shipments.
 *
 * A repeat of an AWB we already hold is accepted silently when it says the same thing, and
 * refused when it does not: a changed amount on a shipment already recorded is either a
 * correction that needs a decision or a bug in the sender, and quietly overwriting it would
 * change what a customer is billed with nothing on the record.
 */
export async function receiveShipments(batch: ShipmentIntake[]): Promise<IntakeResult> {
  const collection = await shipments();
  const result: IntakeResult = { accepted: [], duplicate: [], conflicting: [] };

  for (const incoming of batch) {
    const existing = await collection.findOne({ awb: incoming.awb });

    if (existing) {
      const same =
        existing.booked.total === incoming.booked.total &&
        existing.customerCode === incoming.customerCode &&
        existing.chargeableWeight === incoming.chargeableWeight;
      if (same) {
        result.duplicate.push(incoming.awb);
      } else {
        result.conflicting.push({
          awb: incoming.awb,
          why:
            `already held for ${existing.customerCode} at ₹${existing.booked.total} ` +
            `and ${existing.chargeableWeight} kg`,
        });
      }
      continue;
    }

    await collection.insertOne({
      _id: new ObjectId(),
      ...incoming,
      status: 'received',
      receivedAt: new Date(),
    });
    result.accepted.push(incoming.awb);
  }

  return result;
}

/** Everything not yet on an invoice, for one customer and period. */
export async function billableFor(
  customerCode: string,
  from: Date,
  to: Date,
): Promise<ShipmentDoc[]> {
  return (await shipments())
    .find({ customerCode, status: 'received', bookedAt: { $gte: from, $lte: to } })
    .sort({ bookedAt: 1, awb: 1 })
    .toArray();
}

export async function findShipment(awb: string): Promise<ShipmentDoc | null> {
  return (await shipments()).findOne({ awb });
}
