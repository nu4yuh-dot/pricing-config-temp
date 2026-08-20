import { ObjectId, type Collection } from 'mongodb';
import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import {
  resolveSettlement,
  DEFAULT_CREDIT,
  DEFAULT_PREPAID,
  type EffectiveSettlement,
  type SettlementOverrides,
  type SettlementProfile,
} from '../billing/settlement';
import type { Actor } from './workflow';

/**
 * Settlement profiles, and which customer is on which.
 *
 * Stored rather than derived, unlike the charge library: a profile is a decision somebody
 * made about how an arrangement should work, and it exists before any customer is on it.
 * The assignment lives on the customer, so a customer carries the profile key and its own
 * sparse overrides — the same shape a contract uses for negotiated rates.
 */

export interface SettlementProfileDoc extends SettlementProfile {
  _id: ObjectId;
  createdBy: Actor;
  createdAt: Date;
}

/** What a customer stores: which arrangement, and where they depart from it. */
export interface CustomerSettlement {
  profileKey: string;
  overrides?: SettlementOverrides;
}

async function profiles(): Promise<Collection<SettlementProfileDoc>> {
  return (await db()).collection<SettlementProfileDoc>(COLLECTIONS.settlementProfiles);
}

export async function listProfiles(): Promise<SettlementProfileDoc[]> {
  return (await profiles()).find().sort({ name: 1 }).toArray();
}

export async function findProfile(key: string): Promise<SettlementProfileDoc | null> {
  return (await profiles()).findOne({ key });
}

export async function createProfile(
  input: Omit<SettlementProfile, 'prepaid' | 'credit'> & {
    prepaid?: SettlementProfile['prepaid'];
    credit?: SettlementProfile['credit'];
  },
  actor: Actor,
): Promise<SettlementProfileDoc> {
  const collection = await profiles();
  if (await collection.findOne({ key: input.key })) {
    throw new Error(`A settlement profile called ${input.key} already exists.`);
  }

  const doc: SettlementProfileDoc = {
    _id: new ObjectId(),
    ...input,
    // Both are stored whichever mode this is, so switching a profile's mode later does not
    // need the other half invented on the spot.
    prepaid: { ...DEFAULT_PREPAID, ...input.prepaid },
    credit: { ...DEFAULT_CREDIT, ...input.credit },
    createdBy: actor,
    createdAt: new Date(),
  };
  await collection.insertOne(doc);
  await recordAudit({
    action: 'settlement-profile-created',
    actor,
    at: doc.createdAt,
    detail: { key: input.key, mode: input.mode, cycle: input.cycle, onBreach: input.onBreach },
  });
  return doc;
}

/**
 * The arrangement in force for a customer.
 *
 * Null when they are on no profile at all, which is not the same as being on a permissive
 * one — a caller has to decide what to do about a customer nobody has put on terms, and
 * silently inventing terms here would make that decision invisible.
 */
export async function settlementFor(
  settlement: CustomerSettlement | undefined,
): Promise<EffectiveSettlement | null> {
  if (!settlement?.profileKey) return null;
  const profile = await findProfile(settlement.profileKey);
  if (!profile) return null;
  return resolveSettlement(profile, settlement.overrides ?? {});
}
