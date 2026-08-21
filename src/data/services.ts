import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import { BUILT_IN_SERVICES, serviceIsValid, type Service } from '../domain/services';
import type { Actor } from './workflow';

/**
 * The services on sale.
 *
 * The four built-ins are always present and always first, because they are what the engine
 * prices directly — a system with no records here behaves exactly as it did before this
 * existed. Anything added rides one of them at a multiplier.
 *
 * A built-in may be edited (renamed, given a different SAC) but not removed, because the
 * engine still prices its mode whatever the row says.
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

async function services() {
  return (await db()).collection<Service>(COLLECTIONS.services);
}

const BUILT_IN_KEYS = new Set(BUILT_IN_SERVICES.map((service) => service.key));

export function isBuiltIn(key: string): boolean {
  return BUILT_IN_KEYS.has(key);
}

export async function listServices(): Promise<Service[]> {
  const stored = await (await services()).find().toArray();
  const byKey = new Map<string, Service>(stored.map((service) => [service.key, stripId(service)]));

  // Built-ins fill any gap, so the four modes always have a service.
  for (const built of BUILT_IN_SERVICES) {
    if (!byKey.has(built.key)) byKey.set(built.key, built);
  }

  const all = [...byKey.values()];
  return [
    ...BUILT_IN_SERVICES.map((built) => all.find((service) => service.key === built.key)!),
    ...all.filter((service) => !isBuiltIn(service.key)).sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

export async function saveService(input: Service, actor: Actor): Promise<Service> {
  const key = input.key.trim().toLowerCase();
  const service: Service = { ...input, key };

  const problem = serviceIsValid(service);
  if (problem) throw new Error(problem);

  await (await services()).updateOne({ key }, { $set: service }, { upsert: true });
  await recordAudit({
    action: 'service-saved',
    actor,
    at: new Date(),
    detail: {
      service: key,
      mode: service.mode,
      multiplier: service.multiplier,
      builtIn: isBuiltIn(key),
    },
  });
  return service;
}

/** A built-in cannot be removed: the engine prices its mode regardless. */
export async function deleteService(key: string, actor: Actor): Promise<void> {
  if (isBuiltIn(key)) {
    throw new Error(
      `${key} is one of the four networks this service prices. It can be renamed, but not removed.`,
    );
  }
  await (await services()).deleteOne({ key });
  await recordAudit({ action: 'service-saved', actor, at: new Date(), detail: { service: key, deleted: true } });
}
