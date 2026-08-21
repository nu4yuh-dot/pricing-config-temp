import { ObjectId, type Collection } from 'mongodb';
import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import { widenScope, widenedBy, type ScopeAsk } from '../customers/widen';
import type { ContractTerms, LaneKey, WeightBand } from '../domain/customers';
import type { Mode } from '../domain/types';
import type { Actor } from './workflow';
import type { CustomerDoc } from './customers';

/**
 * What a customer has asked for in their contract.
 *
 * Raised from the enterprise portal — "we ship to Chennai now, can you add it", "we need
 * air on this lane", "can we revisit the rate above 500 kg". It arrives through the core,
 * because the portal is part of the core and this service is not on the public internet.
 *
 * The important thing about a request is what accepting it does *not* do. A customer
 * asking for a lane cannot say what it costs — the rate is ours to set. So accepting is
 * not publishing: it writes the ask into the customer's **draft** contract, where the
 * pricing team rates it, and the existing contract approval is what makes it live. Two
 * gates, and the second one already existed.
 *
 * That also means an accepted request is a promise to price something, not a promise about
 * a price. The customer is told their request was accepted, never what it will cost.
 */

export type ContractRequestStatus = 'pending' | 'accepted' | 'declined';

export interface ContractRequestDoc {
  _id: ObjectId;
  reference: string;
  customerCode: string;
  /** Who asked, as the portal knows them. */
  raisedBy: string;
  raisedAt: Date;
  /** The customer's own words. Often the most useful part of the record. */
  note?: string;
  /** Coverage they want added. */
  ask: {
    modes?: Mode[];
    lanes?: LaneKey[];
    weightBands?: WeightBand[];
  };
  /**
   * Routes as the enterprise portal collects them, kept verbatim.
   *
   * Held alongside the resolved lanes rather than instead of them: the lanes are what
   * accepting writes into the draft, and these are what the customer actually asked for,
   * including the volumes and the hub names they used. When a rate is questioned a year
   * later, "they committed 500 kg a month on BOM→MAA" is the useful record.
   */
  routes?: {
    origHub: string;
    origCity?: string;
    destHub: string;
    destCity?: string;
    /** Kilograms per month the customer expects on this route. */
    estimatedMonthlyVolume?: number;
  }[];
  /** The term the customer asked for. Advisory: the contract's own dates decide. */
  effectiveFrom?: string;
  effectiveTo?: string;
  /**
   * Rates the customer has proposed, if they made an offer rather than a request.
   *
   * Written into the draft as a starting point for the negotiation, not as a decision.
   * Nothing here reaches a quote until the contract itself is approved.
   */
  proposedRates?: { bind: string; value: number }[];
  status: ContractRequestStatus;
  decidedBy?: Actor;
  decidedAt?: Date;
  comment?: string;
  /** What actually landed in the draft, so the outcome is readable later. */
  applied?: { widened: string[]; cells: number };
}

async function requests(): Promise<Collection<ContractRequestDoc>> {
  return (await db()).collection<ContractRequestDoc>(COLLECTIONS.contractRequests);
}

async function customers(): Promise<Collection<CustomerDoc>> {
  return (await db()).collection<CustomerDoc>(COLLECTIONS.customers);
}

function reference(): string {
  return `CR-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

/* ---------------------------------------------------------------- raising */

export async function raiseContractRequest(input: {
  customerCode: string;
  raisedBy: string;
  note?: string;
  ask: ContractRequestDoc['ask'];
  proposedRates?: { bind: string; value: number }[];
  routes?: ContractRequestDoc['routes'];
  effectiveFrom?: string;
  effectiveTo?: string;
}): Promise<ContractRequestDoc> {
  const doc: ContractRequestDoc = {
    _id: new ObjectId(),
    reference: reference(),
    customerCode: input.customerCode,
    raisedBy: input.raisedBy,
    raisedAt: new Date(),
    ...(input.note ? { note: input.note } : {}),
    ask: input.ask,
    ...(input.proposedRates?.length ? { proposedRates: input.proposedRates } : {}),
    ...(input.routes?.length ? { routes: input.routes } : {}),
    ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.effectiveTo ? { effectiveTo: input.effectiveTo } : {}),
    status: 'pending',
  };
  await (await requests()).insertOne(doc);
  return doc;
}

/* --------------------------------------------------------------- deciding */

/**
 * Accept a request: widen the draft, and write any proposed rates into it.
 *
 * Refuses while a contract proposal is already with a reviewer. The draft is frozen then,
 * and quietly writing into a frozen draft would put cells in front of an approver that
 * they never saw when they started reading.
 */
export async function acceptContractRequest(
  reference: string,
  actor: Actor,
  comment?: string,
): Promise<ContractRequestDoc> {
  const collection = await requests();
  const request = await collection.findOne({ reference });
  if (!request) throw new Error('That request no longer exists.');
  if (request.status !== 'pending') throw new Error('That request has already been decided.');

  const customerCollection = await customers();
  const customer = await customerCollection.findOne({ code: request.customerCode });
  if (!customer) throw new Error(`customer ${request.customerCode} not found`);

  if (customer.pendingProposalId) {
    throw new Error(
      'This customer has a contract awaiting approval, so their draft is frozen. ' +
        'Have that reviewed first, then accept this.',
    );
  }

  const before = customer.draftTerms.scope;
  const scope = widenScope(before, request.ask as ScopeAsk);

  const overrides = { ...customer.draftTerms.overrides };
  for (const rate of request.proposedRates ?? []) overrides[rate.bind] = rate.value;

  const draftTerms: ContractTerms = { ...customer.draftTerms, scope, overrides };
  await customerCollection.updateOne(
    { _id: customer._id },
    { $set: { draftTerms, lastEditedBy: actor, lastEditedAt: new Date() } },
  );

  const applied = {
    widened: widenedBy(before, scope),
    cells: request.proposedRates?.length ?? 0,
  };

  await collection.updateOne(
    { reference },
    {
      $set: {
        status: 'accepted',
        decidedBy: actor,
        decidedAt: new Date(),
        applied,
        ...(comment ? { comment } : {}),
      },
    },
  );

  await recordAudit({
    action: 'contract-request-accepted',
    actor,
    at: new Date(),
    detail: {
      customer: request.customerCode,
      reference,
      widened: applied.widened.join(', ') || 'nothing — already covered',
      cells: applied.cells,
    },
  });

  return { ...request, status: 'accepted', decidedBy: actor, decidedAt: new Date(), applied };
}

export async function declineContractRequest(
  reference: string,
  actor: Actor,
  comment: string,
): Promise<void> {
  const collection = await requests();
  const request = await collection.findOne({ reference });
  if (!request) throw new Error('That request no longer exists.');
  if (request.status !== 'pending') throw new Error('That request has already been decided.');

  await collection.updateOne(
    { reference },
    { $set: { status: 'declined', decidedBy: actor, decidedAt: new Date(), comment } },
  );

  await recordAudit({
    action: 'contract-request-declined',
    actor,
    at: new Date(),
    detail: { customer: request.customerCode, reference, reason: comment },
  });
}

/* ---------------------------------------------------------------- reading */

export async function pendingContractRequests(): Promise<ContractRequestDoc[]> {
  return (await requests()).find({ status: 'pending' }).sort({ raisedAt: 1 }).toArray();
}

export async function contractRequestByReference(
  reference: string,
): Promise<ContractRequestDoc | null> {
  return (await requests()).findOne({ reference });
}

export async function contractRequestsFor(customerCode: string): Promise<ContractRequestDoc[]> {
  return (await requests()).find({ customerCode }).sort({ raisedAt: -1 }).limit(20).toArray();
}
