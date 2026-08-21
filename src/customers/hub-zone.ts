/**
 * Turning the core's hub codes into our zones.
 *
 * The enterprise portal's rate-agreement form asks for an Origin Hub and a Dest Hub,
 * because hubs are what the core knows. Pricing is by zone, which is ours. Something has
 * to translate, and it lives here rather than at the edge of a route so both the API and
 * any screen get the same answer.
 *
 * Today the two vocabularies happen to coincide — all 21 of our hub codes are also zone
 * names — so the default is the identity. That is a convenience, not a guarantee: the core
 * can open a hub tomorrow that we have no zone for.
 *
 * Which is why an unknown hub is reported, never guessed. A hub quietly mapped to the
 * wrong zone prices a real consignment at another lane's rate, and nothing about the
 * answer looks wrong.
 */

export interface HubMapping {
  /** The core's code, as it appears on their form. */
  hub: string;
  /** Our zone. */
  zone: string;
}

export interface HubResolution {
  /** Hubs we could place, in the order asked. */
  zones: string[];
  /** Hubs we could not. Empty means every hub resolved. */
  unknown: string[];
}

const normalise = (code: string) => code.trim().toUpperCase();

/**
 * Resolves hub codes against our zones.
 *
 * `overrides` wins over the identity rule, so a hub whose code collides with an unrelated
 * zone name can be corrected without renaming anything.
 */
export function resolveHubs(
  hubs: readonly string[],
  knownZones: readonly string[],
  overrides: readonly HubMapping[] = [],
): HubResolution {
  const zoneSet = new Set(knownZones.map(normalise));
  const map = new Map(overrides.map((entry) => [normalise(entry.hub), normalise(entry.zone)]));

  const zones: string[] = [];
  const unknown: string[] = [];

  for (const raw of hubs) {
    const hub = normalise(raw);
    const mapped = map.get(hub);

    if (mapped !== undefined) {
      // An override pointing at a zone we do not have is a broken mapping, not a hub we
      // cannot place — and saying so is what makes it fixable.
      if (zoneSet.has(mapped)) zones.push(mapped);
      else unknown.push(raw);
      continue;
    }

    if (zoneSet.has(hub)) zones.push(hub);
    else unknown.push(raw);
  }

  return { zones, unknown };
}

/** A sentence for the caller when a hub could not be placed. */
export function unknownHubMessage(unknown: readonly string[]): string {
  const list = unknown.join(', ');
  return unknown.length === 1
    ? `We do not serve a zone for hub ${list}. Tell us which zone it belongs to and we will add it.`
    : `We do not serve zones for hubs ${list}. Tell us which zones they belong to and we will add them.`;
}
