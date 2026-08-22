import { DEFAULT_CHARGES } from './tax';
import type { RateCardData } from './types';

/**
 * The charge library.
 *
 * The engine already prices any charge by its id, and a card or a contract can invent one
 * — but there was nowhere to *see* them, so the second customer to want a demurrage got a
 * second demurrage with its own name and its own spelling. A library is what stops a menu
 * of six becoming forty near-duplicates.
 *
 * It is derived rather than stored. Every charge anyone has defined is already on a card
 * or in a contract's override map, so a separate collection would be a second source of
 * truth that could disagree with the thing actually being billed. Deriving it means the
 * library cannot list a charge nobody has, or miss one somebody does.
 */

export interface LibraryCharge {
  id: string;
  name: string;
  basis: string;
  gstApplies?: boolean;
  fuelApplies?: boolean;
  /** May an operator add this to a single booking, for a customer with no standing term? */
  bookableOneOff?: boolean;
  /** How many cards and contracts carry it. Zero means standard but unused. */
  usedBy: number;
}

/** Bases that cannot be a one-off, because the amount is not a single number. */
const NOT_ONE_OFF = new Set(['per-destination', 'by-pincode']);

/**
 * A per-destination charge holds an amount per zone and a by-pincode charge is read off
 * the distance table, so neither has one figure an operator could be asked for at a
 * booking. Flagging one bookable is a configuration mistake, and refusing it here is
 * cheaper than discovering it at the counter.
 */
export function isBookableOneOff(charge: {
  basis: string;
  bookableOneOff?: boolean;
}): boolean {
  return charge.bookableOneOff === true && !NOT_ONE_OFF.has(charge.basis);
}

const CHARGE_PATH = /^chargeCatalog\.([^.]+)\./;

function chargeIdsIn(overrides: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const path of Object.keys(overrides)) {
    const match = CHARGE_PATH.exec(path);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

/** One place a charge is configured: a rate card, or one customer's contract. */
export interface ChargePlace {
  kind: 'card' | 'contract';
  /** The card key, or the customer code. What a link needs. */
  key: string;
  /** The card name, or the customer name. What a person reads. */
  label: string;
}

/**
 * Where each charge is actually configured, by charge id.
 *
 * `chargeLibrary` counts how many places carry a charge and deliberately does not say
 * which, because it is given anonymous data. That left the library able to report
 * "handling · 5 places" with no route to any of the five — you could see something needed
 * changing and had nowhere to go.
 *
 * Kept separate rather than folded into `chargeLibrary` so its four callers, three of which
 * only want the list of charges, are unaffected. The identity a link needs is a different
 * question from what exists.
 */
export function chargePlaces(
  cards: readonly { key: string; label: string; data: { chargeCatalog?: unknown } }[],
  contracts: readonly { key: string; label: string; overrides: Record<string, unknown> }[],
): Map<string, ChargePlace[]> {
  const places = new Map<string, ChargePlace[]>();
  const add = (id: string, place: ChargePlace) => {
    const list = places.get(id);
    if (list) list.push(place);
    else places.set(id, [place]);
  };

  for (const card of cards) {
    const declared = card.data.chargeCatalog;
    if (!declared || typeof declared !== 'object') continue;
    for (const id of Object.keys(declared as Record<string, unknown>)) {
      add(id, { kind: 'card', key: card.key, label: card.label });
    }
  }

  for (const contract of contracts) {
    for (const id of chargeIdsIn(contract.overrides)) {
      add(id, { kind: 'contract', key: contract.key, label: contract.label });
    }
  }

  return places;
}

/**
 * Every charge anyone has defined, standard or invented, with how many carry it.
 *
 * `cards` are rate card data; `contracts` are override maps. Both are read the same way,
 * because a contract that adds a charge has defined one just as much as a card has.
 */
export function chargeLibrary(
  cards: readonly RateCardData[],
  contracts: readonly Record<string, unknown>[],
): LibraryCharge[] {
  const byId = new Map<string, LibraryCharge>();

  for (const standard of DEFAULT_CHARGES) {
    byId.set(standard.id, {
      id: standard.id,
      name: standard.name,
      basis: standard.basis,
      gstApplies: standard.gstApplies,
      fuelApplies: standard.fuelApplies,
      usedBy: 0,
    });
  }

  /**
   * Whether a stored flag cell is on.
   *
   * A cell holds the word — `'Yes'` — because that is what the source workbooks and the
   * grid editors write. `bookableOneOff` was compared against `true`, and it was never read
   * out of the card data in the first place, so the library reported *every* charge as
   * "standing term only" whatever had been configured. A charge created as bookable at a
   * booking has never been offered at one.
   */
  const flagOn = (value: unknown): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return false;
    const word = value.trim().toLowerCase();
    return word === 'yes' || word === 'y' || word === 'true';
  };

  const note = (id: string, name?: string, basis?: string, oneOff?: unknown) => {
    const existing = byId.get(id);
    if (existing) {
      existing.usedBy += 1;
      // A card may name a standard charge something local. First definition wins, so the
      // library does not flicker between spellings depending on load order.
      if (name && existing.name === id) existing.name = name;
      // Bookable anywhere is bookable: a charge one card offers at the counter is offered,
      // and reporting otherwise because a different card came first would be a lie about
      // what an operator can do.
      if (oneOff !== undefined && flagOn(oneOff)) existing.bookableOneOff = true;
      return;
    }
    byId.set(id, {
      id,
      name: name ?? id,
      basis: basis ?? 'per-shipment',
      ...(oneOff === undefined ? {} : { bookableOneOff: flagOn(oneOff) }),
      usedBy: 1,
    });
  };

  for (const card of cards) {
    const declared = card.chargeCatalog;
    if (!declared) continue;
    for (const [id, value] of Object.entries(declared)) {
      const charge = value as { name?: string; basis?: string; bookableOneOff?: unknown };
      note(id, charge?.name, charge?.basis, charge?.bookableOneOff);
    }
  }

  for (const overrides of contracts) {
    for (const id of chargeIdsIn(overrides)) {
      const name = overrides[`chargeCatalog.${id}.name`];
      const basis = overrides[`chargeCatalog.${id}.basis`];
      note(
        id,
        typeof name === 'string' ? name : undefined,
        typeof basis === 'string' ? basis : undefined,
        overrides[`chargeCatalog.${id}.bookableOneOff`],
      );
    }
  }

  // Most used first: the point of a library is reuse, so what is already reused leads.
  return [...byId.values()].sort((a, b) => b.usedBy - a.usedBy || a.name.localeCompare(b.name));
}
