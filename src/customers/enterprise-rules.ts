import { canManageTeam } from '../domain/enterprise';
import type {
  BookAddress,
  Department,
  TeamMember,
  TeamRole,
} from '../domain/enterprise';
import type { Plant } from '../domain/company';

/**
 * The rules the enterprise account has to keep, held apart from the database so they can
 * be tested without one.
 *
 * Each of these is visible in the portal as a promise to the customer — one starred
 * default pickup, departments that belong to a plant, only the owner building the team.
 * A promise the screen makes and the data does not keep is a bug that surfaces as a
 * mystery weeks later, so they are enforced on write rather than assumed.
 */

/* ---------------------------------------------------------------- addresses */

/**
 * Applies a new or edited address, keeping exactly one default pickup.
 *
 * Starring one unstars the rest. The alternative — refusing a second star — reads as a
 * bug to anyone using it, because the obvious meaning of starring a new address is that
 * it becomes the default.
 */
export function withAddress(
  addresses: BookAddress[],
  incoming: BookAddress,
): BookAddress[] {
  const others = addresses.filter((entry) => entry.id !== incoming.id);
  const next = incoming.isDefault
    ? others.map((entry) => ({ ...entry, isDefault: false }))
    : others;

  const list = [...next, incoming];

  // If nothing is starred and something could be, star the only pickup-capable entry.
  // A book with one usable address and no default makes every booking ask a question
  // that has only one answer.
  const usable = list.filter((entry) => entry.type !== 'delivery');
  if (usable.length === 1 && !list.some((entry) => entry.isDefault)) {
    return list.map((entry) =>
      entry.id === usable[0]!.id ? { ...entry, isDefault: true } : entry,
    );
  }

  return list;
}

/**
 * Removes an address, moving the star if it held one.
 *
 * Deleting the default silently leaves a customer whose next booking does not auto-fill,
 * with nothing on screen explaining why.
 */
export function withoutAddress(addresses: BookAddress[], id: string): BookAddress[] {
  const removed = addresses.find((entry) => entry.id === id);
  const rest = addresses.filter((entry) => entry.id !== id);
  if (!removed?.isDefault) return rest;

  const candidate = rest.find((entry) => entry.type !== 'delivery');
  return candidate
    ? rest.map((entry) => (entry.id === candidate.id ? { ...entry, isDefault: true } : entry))
    : rest;
}

/** A delivery-only address cannot be the default pickup. */
export function addressIsCoherent(address: BookAddress): string | null {
  if (address.type === 'delivery' && address.isDefault) {
    return 'A delivery-only address cannot be the default pickup.';
  }
  if (address.pincode !== undefined && !/^\d{6}$/.test(String(address.pincode))) {
    return 'A pincode is six digits.';
  }
  return null;
}

/* -------------------------------------------------------------- departments */

/**
 * Whether a department may exist.
 *
 * The portal already refuses to open the form without a plant — "Create a plant first
 * before adding departments" — but a screen that guards a rule is not the rule. An import
 * or an API call would walk straight past it.
 */
export function departmentIsPlaceable(
  department: Pick<Department, 'name' | 'plantCode'>,
  plants: Plant[],
): string | null {
  if (plants.length === 0) return 'Add a plant before adding departments.';
  if (!plants.some((plant) => plant.code === department.plantCode)) {
    return `No plant with code ${department.plantCode}.`;
  }
  if (department.name.trim() === '') return 'A department needs a name.';
  return null;
}

/* --------------------------------------------------------------------- team */

/**
 * Whether `actor` may change the roster, and whether the change leaves it valid.
 *
 * Two rules, and the second is the one that bites: an account must keep an owner. Letting
 * the last owner be removed or demoted locks every remaining person out of managing the
 * team, and only a support call can undo it.
 */
export function teamChangeIsAllowed(
  team: TeamMember[],
  actorRole: TeamRole,
  change: { email: string; role?: TeamRole; status?: TeamMember['status'] },
): string | null {
  if (!canManageTeam(actorRole)) {
    return 'Only the account owner can change who is on the team.';
  }

  const target = team.find((member) => member.email === change.email.toLowerCase());
  if (!target) return null;

  const losingOwner =
    target.role === 'supply_chain_head' &&
    ((change.role !== undefined && change.role !== 'supply_chain_head') ||
      (change.status !== undefined && change.status !== 'active'));

  if (losingOwner) {
    const otherActiveOwners = team.filter(
      (member) =>
        member.email !== target.email &&
        member.role === 'supply_chain_head' &&
        member.status === 'active',
    );
    if (otherActiveOwners.length === 0) {
      return 'The account must keep an owner. Make somebody else the owner first.';
    }
  }

  return null;
}

/** Applies a roster change, keeping emails unique and lower-cased. */
export function withMember(team: TeamMember[], incoming: TeamMember): TeamMember[] {
  const email = incoming.email.trim().toLowerCase();
  const others = team.filter((member) => member.email !== email);
  return [...others, { ...incoming, email }];
}
