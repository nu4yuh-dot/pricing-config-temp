import { randomUUID } from 'node:crypto';
import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import { queueCustomerPush } from './core-push';
import { toCorePayload } from '../customers/core-payload';
import {
  withAddress,
  withoutAddress,
  addressIsCoherent,
  departmentIsPlaceable,
  teamChangeIsAllowed,
  withMember,
} from '../customers/enterprise-rules';
import type {
  BookAddress,
  Department,
  TeamMember,
  TeamRole,
  EnterpriseAccount,
} from '../domain/enterprise';
import type { Plant } from '../domain/company';
import type { Actor } from './workflow';
import type { CustomerDoc } from './customers';

/**
 * The customer's own account, written from their enterprise portal.
 *
 * Everything here is mastered by this service and pushed to the core, so the portal reads
 * one truth and the core is kept in step. What crosses is decided in `core-payload.ts` —
 * notably the roster, because the core is the only system that can issue a sign-in.
 *
 * These writes do not go through approval. That is deliberate and worth saying: a customer
 * adding their own warehouse or removing a colleague who has left is housekeeping on their
 * own record, and putting it in a queue for our team would mean a customer waits days to
 * fix a phone number. What does go through approval is anything that changes what they
 * pay — their contract, and their billing arrangement.
 */

const EMPTY: EnterpriseAccount = { team: [], addresses: [], departments: [] };

async function customers() {
  return (await db()).collection<CustomerDoc>(COLLECTIONS.customers);
}

async function load(code: string): Promise<CustomerDoc> {
  const customer = await (await customers()).findOne({ code: code.trim().toUpperCase() });
  if (!customer) throw new Error(`customer ${code} not found`);
  return customer;
}

export function accountOf(customer: CustomerDoc): EnterpriseAccount {
  return { ...EMPTY, ...(customer.enterprise ?? {}) };
}

/**
 * Saves the account and queues the customer for the core.
 *
 * One function so no path can write the account without the core hearing about it — a
 * roster change that never reaches the core is somebody who cannot sign in, and nothing
 * on either screen would say why.
 */
async function save(
  customer: CustomerDoc,
  account: EnterpriseAccount,
  audit: { action: Parameters<typeof recordAudit>[0]['action']; actor: Actor; detail: Record<string, unknown> },
): Promise<EnterpriseAccount> {
  const revision = (customer.coreRevision ?? 0) + 1;
  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { enterprise: account, coreRevision: revision } },
  );

  await queueCustomerPush(toCorePayload({ ...customer, enterprise: account, coreRevision: revision }));
  await recordAudit({ action: audit.action, actor: audit.actor, at: new Date(), detail: audit.detail });

  return account;
}

/* ---------------------------------------------------------------- addresses */

export async function saveAddress(
  code: string,
  incoming: Omit<BookAddress, 'id'> & { id?: string },
  actor: Actor,
): Promise<BookAddress> {
  const customer = await load(code);
  const account = accountOf(customer);

  const address: BookAddress = { ...incoming, id: incoming.id ?? randomUUID() };
  const problem = addressIsCoherent(address);
  if (problem) throw new Error(problem);

  const addresses = withAddress(account.addresses, address);
  await save(customer, { ...account, addresses }, {
    action: 'enterprise-address-saved',
    actor,
    detail: { customer: customer.code, label: address.label, isDefault: address.isDefault === true },
  });

  // Returned from the saved list, so the caller sees the star as it actually landed.
  return addresses.find((entry) => entry.id === address.id)!;
}

export async function deleteAddress(code: string, id: string, actor: Actor): Promise<void> {
  const customer = await load(code);
  const account = accountOf(customer);
  if (!account.addresses.some((entry) => entry.id === id)) throw new Error('No such address.');

  await save(customer, { ...account, addresses: withoutAddress(account.addresses, id) }, {
    action: 'enterprise-address-deleted',
    actor,
    detail: { customer: customer.code, id },
  });
}

/* ------------------------------------------------------------------- plants */

/**
 * Plants live on the company profile, where they already did — a plant carries a GST
 * registration, which is master data, not a booking convenience.
 *
 * Unlike a profile edit, this does not go through approval: adding a site is the customer
 * telling us where they ship from, and they know that better than we do.
 */
export async function savePlant(
  code: string,
  incoming: Omit<Plant, 'code'> & { code?: string },
  actor: Actor,
): Promise<Plant> {
  const customer = await load(code);
  const profile = customer.profile ?? { legalName: customer.name, contacts: [], plants: [] };

  const plant: Plant = {
    ...incoming,
    active: incoming.active ?? true,
    code: incoming.code ?? `PLT-${String(profile.plants.length + 1).padStart(2, '0')}`,
  };

  const plants = [...profile.plants.filter((entry) => entry.code !== plant.code), plant];
  const revision = (customer.coreRevision ?? 0) + 1;
  const updated = { ...profile, plants };

  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { profile: updated, coreRevision: revision } },
  );
  await queueCustomerPush(toCorePayload({ ...customer, profile: updated, coreRevision: revision }));
  await recordAudit({
    action: 'enterprise-plant-saved',
    actor,
    at: new Date(),
    detail: { customer: customer.code, plant: plant.code, name: plant.name },
  });

  return plant;
}

/**
 * Withdraw a plant.
 *
 * **Deactivates rather than destroys**, and the reason is the other system: the SameX core
 * deactivates a plant through its own toggle, so removing the row here would leave the two
 * disagreeing about whether the plant exists at all — and the one holding the shipments
 * would be the one that still had it.
 *
 * There is a second reason that outlives the integration. A plant is on invoices and on
 * shipments that have already moved. Deleting it makes those documents reference something
 * that never existed, which is not a tidier database, only a less answerable one.
 *
 * Departments at the plant are deactivated with it, because a department whose plant is
 * withdrawn cannot be shipped from either. They keep their rows, so reactivating the plant
 * can bring them back.
 */
export async function deletePlant(code: string, plantCode: string, actor: Actor): Promise<void> {
  const customer = await load(code);
  const profile = customer.profile;
  if (!profile?.plants.some((plant) => plant.code === plantCode)) throw new Error('No such plant.');

  const account = accountOf(customer);
  const departments = account.departments.map((entry) =>
    entry.plantCode === plantCode ? { ...entry, active: false } : entry,
  );
  const plants = profile.plants.map((plant) =>
    plant.code === plantCode ? { ...plant, active: false } : plant,
  );
  const revision = (customer.coreRevision ?? 0) + 1;
  const updated = { ...profile, plants };

  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { profile: updated, enterprise: { ...account, departments }, coreRevision: revision } },
  );
  await queueCustomerPush(
    toCorePayload({ ...customer, profile: updated, enterprise: { ...account, departments }, coreRevision: revision }),
  );
  await recordAudit({
    action: 'enterprise-plant-deleted',
    actor,
    at: new Date(),
    detail: {
      customer: customer.code,
      plant: plantCode,
      deactivated: true,
      departmentsDeactivated: account.departments.filter((entry) => entry.plantCode === plantCode)
        .length,
    },
  });
}

/* -------------------------------------------------------------- departments */

export async function saveDepartment(
  code: string,
  incoming: Omit<Department, 'id'> & { id?: string },
  actor: Actor,
): Promise<Department> {
  const customer = await load(code);
  const account = accountOf(customer);

  const problem = departmentIsPlaceable(incoming, customer.profile?.plants ?? []);
  if (problem) throw new Error(problem);

  const department: Department = { ...incoming, id: incoming.id ?? randomUUID() };
  const departments = [
    ...account.departments.filter((entry) => entry.id !== department.id),
    department,
  ];

  await save(customer, { ...account, departments }, {
    action: 'enterprise-department-saved',
    actor,
    detail: { customer: customer.code, name: department.name, plant: department.plantCode },
  });

  return department;
}

/**
 * Withdraw a department.
 *
 * Deactivated rather than removed, for the same reasons as a plant: the core deactivates,
 * and a department is a cost centre on shipments that have already moved.
 */
export async function deleteDepartment(code: string, id: string, actor: Actor): Promise<void> {
  const customer = await load(code);
  const account = accountOf(customer);
  if (!account.departments.some((entry) => entry.id === id)) throw new Error('No such department.');

  await save(
    customer,
    {
      ...account,
      departments: account.departments.map((entry) =>
        entry.id === id ? { ...entry, active: false } : entry,
      ),
    },
    {
      action: 'enterprise-department-deleted',
      actor,
      detail: { customer: customer.code, id, deactivated: true },
    },
  );
}

/* --------------------------------------------------------------------- team */

/**
 * Add or change somebody on the customer's team.
 *
 * `actorRole` is who is asking, as the portal knows them — only the account owner may do
 * this. No password is accepted here, and there is nowhere to put one: the core issues the
 * credential, and this is the roster telling it whom to issue one to.
 */
export async function saveTeamMember(
  code: string,
  actorRole: TeamRole,
  incoming: Omit<TeamMember, 'addedAt'> & { addedAt?: Date },
  actor: Actor,
): Promise<TeamMember> {
  const customer = await load(code);
  const account = accountOf(customer);

  const problem = teamChangeIsAllowed(account.team, actorRole, {
    email: incoming.email,
    role: incoming.role,
    status: incoming.status,
  });
  if (problem) throw new Error(problem);

  const member: TeamMember = {
    ...incoming,
    email: incoming.email.trim().toLowerCase(),
    addedAt: incoming.addedAt ?? new Date(),
    ...(actor.email ? { addedBy: actor.email } : {}),
  };

  const team = withMember(account.team, member);
  await save(customer, { ...account, team }, {
    action: 'enterprise-team-changed',
    actor,
    detail: { customer: customer.code, member: member.email, role: member.role, status: member.status },
  });

  return member;
}

export async function removeTeamMember(
  code: string,
  actorRole: TeamRole,
  email: string,
  actor: Actor,
): Promise<void> {
  const customer = await load(code);
  const account = accountOf(customer);
  const target = email.trim().toLowerCase();

  const problem = teamChangeIsAllowed(account.team, actorRole, { email: target, status: 'disabled' });
  if (problem) throw new Error(problem);
  if (!account.team.some((member) => member.email === target)) throw new Error('No such team member.');

  // Disabled, not deleted: they are named on shipments they booked, and a roster that
  // forgets them makes that history unreadable.
  const team = account.team.map((member) =>
    member.email === target ? { ...member, status: 'disabled' as const } : member,
  );

  await save(customer, { ...account, team }, {
    action: 'enterprise-team-changed',
    actor,
    detail: { customer: customer.code, member: target, status: 'disabled' },
  });
}

/* -------------------------------------------------------- the money summary */

/**
 * What the portal's Billing & Credit tab shows.
 *
 * Assembled here rather than in the route so the numbers and their captions stay together:
 * "in-flight" means shipments we have been told about but not yet invoiced, and that
 * definition belongs next to the query that produces it, not in a screen.
 *
 * Amounts in rupees, because that is what a person reads. The ledger works in paise and
 * the conversion happens once, here.
 */
export interface CreditSnapshot {
  /** What they may still spend: the limit less what is owed, never below zero. */
  availableSpend: number;
  creditLimit: number;
  used: number;
  outstanding: number;
  unpaidInvoices: number;
  /** Booked, handed to us, not yet on an invoice. */
  inFlight: number;
  inFlightShipments: number;
  overdue: number;
  oldestOverdueDays: number;
  walletBalance: number;
  recentActivity: { at: string; description: string; amount: number }[];
}

export async function creditSnapshot(customer: CustomerDoc): Promise<CreditSnapshot> {
  const { billingFor } = await import('./billing');
  const { DEFAULT_COMMERCIAL_TERMS } = await import('../domain/customers');
  const { db: database, COLLECTIONS: collections } = await import('./mongo');

  const terms = customer.commercial ?? DEFAULT_COMMERCIAL_TERMS;
  const summary = await billingFor(customer.code, {
    creditLimit: terms.creditLimit,
    paymentTermsDays: terms.paymentTermsDays,
  });

  const shipments = (await database()).collection(collections.shipments);
  const pending = await shipments
    .find({ customerCode: customer.code, status: 'received' })
    .toArray();

  const rupees = (paise: number) => Math.round(paise) / 100;
  const inFlight = pending.reduce(
    (total, shipment) => total + ((shipment as { booked?: { total?: number } }).booked?.total ?? 0),
    0,
  );

  return {
    availableSpend: rupees(summary.position.available),
    creditLimit: rupees(summary.position.limit),
    used: rupees(Math.max(summary.position.owed, 0)),
    outstanding: rupees(summary.position.outstanding),
    unpaidInvoices: summary.invoices.filter((invoice) => invoice.status !== 'paid').length,
    // Already in rupees: shipment amounts are what the customer was quoted, not ledger paise.
    inFlight: Math.round(inFlight * 100) / 100,
    inFlightShipments: pending.length,
    overdue: rupees(summary.position.overdue),
    oldestOverdueDays: summary.position.oldestOverdueDays,
    walletBalance: rupees(summary.position.walletBalance),
    // Newest first, which is the order the portal reads them in. The kind is the caption:
    // "recharge", "invoice", "payment" — the direction is in the kind, never in the sign.
    recentActivity: summary.statement.slice(-20).reverse().map((row) => ({
      at: row.entry.at.toISOString(),
      description: `${row.entry.kind} · ${row.entry.reference}`,
      amount: rupees(row.entry.amountPaise),
    })),
  };
}

/* ------------------------------------------------------------------ configs */

/**
 * The customer's admin-booking preference.
 *
 * Its own function rather than part of the account blob because it lives on the customer
 * document, not inside `enterprise` — it is a property of the account, not of the roster
 * or the address book. Pushed like everything else, so the core learns about it.
 */
export async function setAdminBookingAccess(
  code: string,
  allowed: boolean,
  actor: Actor,
): Promise<boolean> {
  const customer = await load(code);
  const revision = (customer.coreRevision ?? 0) + 1;

  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { adminBookingAccess: allowed, coreRevision: revision } },
  );
  await queueCustomerPush(
    toCorePayload({ ...customer, adminBookingAccess: allowed, coreRevision: revision }),
  );
  await recordAudit({
    action: 'enterprise-config-changed',
    actor,
    at: new Date(),
    detail: { customer: customer.code, adminBookingAccess: allowed },
  });

  return allowed;
}
