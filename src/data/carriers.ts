import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import { listCards } from './rate-cards';
import { SOURCE_CARRIERS } from '../customers/carrier-access';
import type { Carrier, RateStructure } from '../domain/carriers';
import type { Actor } from './workflow';

/**
 * The carrier master.
 *
 * Seeded from the rate cards that already exist, so the screen is never empty on first
 * open and nobody has to retype what the system already knows. A carrier that has been
 * edited is left alone by the seed — it is a starting point, not a reset.
 */

/**
 * Mongo hands back an `_id` the domain type has no field for. Dropped on the way out so a
 * carrier read from the database is the same shape as one built in memory — otherwise the
 * two diverge and only one of them round-trips.
 */
function stripId<T extends object>(doc: T & { _id?: unknown }): T {
  const { _id, ...rest } = doc;
  return rest as T;
}

async function carriers() {
  return (await db()).collection<Carrier>(COLLECTIONS.carriers);
}

/** The rate structure a known source prices by. Anything new starts as zone × weight. */
const STRUCTURE_FOR_SOURCE: Record<string, RateStructure> = {
  dns: 'zoneWeight',
  bluedart: 'directionalZone',
  ups: 'countryProduct',
};

const NAME_FOR_CARRIER: Record<string, string> = {
  own: 'DNS own network',
  bluedart: 'Bluedart',
  ups: 'UPS / MOVIN',
};

/**
 * Every carrier, with the ones implied by existing cards filled in.
 *
 * Derived rather than stored on first run because the cards are the fact — a carrier we
 * price for exists whether or not anybody has opened this screen.
 */
export async function listCarriers(): Promise<Carrier[]> {
  const [stored, cards] = await Promise.all([(await carriers()).find().toArray(), listCards()]);
  const byId = new Map<string, Carrier>(
    stored.map((carrier) => [carrier.carrierId, stripId(carrier)]),
  );

  for (const card of cards) {
    const carrierId = SOURCE_CARRIERS[card.source ?? 'dns'] ?? 'own';
    const existing = byId.get(carrierId);

    if (existing) {
      // Keep the stored record, but never let its card list drift from reality.
      const cardKeys = [...new Set([...existing.cardKeys, card.key])];
      byId.set(carrierId, { ...existing, cardKeys });
      continue;
    }

    byId.set(carrierId, {
      carrierId,
      name: NAME_FOR_CARRIER[carrierId] ?? carrierId,
      active: true,
      rateStructure: STRUCTURE_FOR_SOURCE[card.source ?? 'dns'] ?? 'zoneWeight',
      cardKeys: [card.key],
    });
  }

  return [...byId.values()].sort((a, b) => (a.carrierId === 'own' ? -1 : a.name.localeCompare(b.name)));
}

export async function findCarrier(carrierId: string): Promise<Carrier | null> {
  return (await listCarriers()).find((carrier) => carrier.carrierId === carrierId) ?? null;
}

export async function saveCarrier(input: Carrier, actor: Actor): Promise<Carrier> {
  const carrierId = input.carrierId.trim().toLowerCase();
  const doc: Carrier = { ...input, carrierId };

  await (await carriers()).updateOne({ carrierId }, { $set: doc }, { upsert: true });
  await recordAudit({
    action: 'carrier-saved',
    actor,
    at: new Date(),
    detail: { carrier: carrierId, name: doc.name, structure: doc.rateStructure, active: doc.active },
  });
  return doc;
}

/**
 * Switched off rather than deleted.
 *
 * A carrier that moved freight last quarter is named on those shipments and invoices, and
 * a master that forgets them makes the history unreadable — the same reason a team member
 * is disabled rather than removed.
 */
export async function setCarrierActive(
  carrierId: string,
  active: boolean,
  actor: Actor,
): Promise<void> {
  const existing = await findCarrier(carrierId);
  if (!existing) throw new Error(`No carrier ${carrierId}.`);

  await (await carriers()).updateOne(
    { carrierId },
    { $set: { ...existing, active } },
    { upsert: true },
  );
  await recordAudit({
    action: 'carrier-saved',
    actor,
    at: new Date(),
    detail: { carrier: carrierId, active },
  });
}
