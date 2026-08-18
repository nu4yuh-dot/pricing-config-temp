import { ObjectId, type Collection } from 'mongodb';
import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import type { Actor } from './workflow';
import { applicableOffers, type Offer, type OfferContext } from '../domain/offers';

/**
 * Offers, stored.
 *
 * An offer is the one thing here that moves a price without being a negotiated cell, so
 * it is deliberately not in the override map: putting it there would make it permanent,
 * which is the exact behaviour offers exist to avoid. It lives on its own, is read at
 * quote time, and expires by arithmetic rather than by somebody remembering.
 */

export interface OfferDoc extends Offer {
  _id: ObjectId;
}

async function offers(): Promise<Collection<OfferDoc>> {
  return (await db()).collection<OfferDoc>(COLLECTIONS.offers);
}

export async function listOffers(): Promise<OfferDoc[]> {
  return (await offers()).find().sort({ startsAt: -1 }).toArray();
}

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function createOffer(input: Omit<Offer, 'key' | 'enabled'> & { actor: Actor }): Promise<OfferDoc> {
  const key = slug(input.name);
  if (key === '') throw new Error('An offer needs a name.');
  if (await (await offers()).findOne({ key })) {
    throw new Error(`An offer called “${input.name}” already exists.`);
  }
  if (input.endsAt < input.startsAt) {
    throw new Error('An offer cannot end before it starts.');
  }
  if (input.kind === 'waive-charge' && !input.chargeId) {
    throw new Error('A waiver has to name the charge it waives.');
  }
  if (input.kind === 'percent-off-freight' && (input.value <= 0 || input.value >= 100)) {
    throw new Error('A percentage off has to be between 0 and 100.');
  }

  const doc: OfferDoc = {
    _id: new ObjectId(),
    key,
    name: input.name.trim(),
    kind: input.kind,
    value: input.value,
    ...(input.chargeId ? { chargeId: input.chargeId } : {}),
    startsAt: input.startsAt,
    // Inclusive of the whole last day: "1–15 Oct" is live all day on the 15th, and an
    // offer that stopped at midnight would end a day early without anyone noticing.
    endsAt: new Date(new Date(input.endsAt).setHours(23, 59, 59, 999)),
    audience: input.audience,
    enabled: true,
    createdBy: input.actor.name,
    createdAt: new Date(),
  };

  await (await offers()).insertOne(doc);
  await recordAudit({
    action: 'offer-scheduled',
    actor: input.actor,
    at: doc.createdAt as Date,
    detail: {
      offer: key,
      kind: doc.kind,
      value: doc.value,
      audience: `${doc.audience.kind}:${doc.audience.value}`,
      from: doc.startsAt.toISOString().slice(0, 10),
      to: doc.endsAt.toISOString().slice(0, 10),
    },
  });
  return doc;
}

/** Suspend or resume an offer without losing its dates. */
export async function setOfferEnabled(key: string, enabled: boolean, actor: Actor): Promise<void> {
  const result = await (await offers()).updateOne({ key }, { $set: { enabled } });
  if (result.matchedCount === 0) throw new Error(`offer ${key} not found`);
  await recordAudit({
    action: 'offer-scheduled',
    actor,
    at: new Date(),
    detail: { offer: key, enabled },
  });
}

/**
 * The offers that reach one customer right now.
 *
 * Read on the quote path, so it is a single indexed find rather than a scan of everything
 * ever scheduled — an expired campaign should cost nothing to have kept.
 */
export async function offersFor(context: OfferContext): Promise<Offer[]> {
  const live = await (await offers())
    .find({ enabled: true, startsAt: { $lte: context.at }, endsAt: { $gte: context.at } })
    .toArray();
  return applicableOffers(live, context);
}
