import { ObjectId, type Collection } from 'mongodb';
import { db, COLLECTIONS } from './mongo';
import { liveCard } from './rate-cards';
import { recordAudit } from './audit';
import type { Actor } from './workflow';
import type { SettlementOverrides } from '../billing/settlement';
import type { CompanyProfile } from '../domain/company';
import type { EnterpriseAccount } from '../domain/enterprise';
import {
  EMPTY_TERMS,
  type CommercialTerms,
  type BookingExceptionRequest,
  type ContractScope,
  type ContractTerms,
  type Customer,
  type Overrides,
  type PriceLock,
} from '../domain/customers';
import {
  buildProposal,
  applyProposalDecision,
  type ContractProposal,
  type ProposalDecisions,
} from '../customers/proposal';
import { effectiveCard, pruneOverrides, malformedOverrides } from '../customers/contract';
import type { RateCard } from '../domain/types';
import type { BindPath } from '../sheets/types';

export interface CustomerDoc extends Customer {
  _id: ObjectId;
  /** Company master data. Optional so existing customers keep working. */
  profile?: CompanyProfile;
  /**
   * Whether the customer may transact.
   *
   * Absent means active, so every customer that predates this field keeps working. Closing
   * an account never deletes it — the shipments, invoices and quotes attached to it have to
   * stay readable, and a customer who returns should come back to their own history.
   */
  active?: boolean;
  /**
   * How many times this customer has been sent to the core.
   *
   * Rises on every approved change, and travels with the payload so the core can ignore a
   * message that arrives out of order after a retry.
   */
  coreRevision?: number;
  /**
   * The customer's own account, as their enterprise portal presents it: team roster,
   * address book, departments and the billing arrangement.
   *
   * Optional, because a customer who has never opened the portal has none of it, and an
   * empty account is a different thing from an absent one.
   */
  enterprise?: EnterpriseAccount;
  /**
   * Which partner carriers this customer may be quoted, keyed by carrier id.
   *
   * Mirrors the core's `carrierAccess`, which an admin sets. Absent means we have not been
   * told, and an absent *entry* for a named carrier is a refusal — see
   * `customers/carrier-access.ts` for why we do not infer it.
   */
  carrierAccess?: Record<string, boolean>;
  /**
   * Whether SameX staff may find this account when booking on the customer's behalf.
   *
   * Off unless the customer turns it on. Stored here only if it turns out to be ours to
   * hold — see the note in `core-payload.ts`.
   */
  adminBookingAccess?: boolean;
  /** The approved contract. Quotes always read this. */
  liveTerms: ContractTerms;
  /** Work in progress. Never priced until approved. */
  draftTerms: ContractTerms;
  /** Set while a proposal is with an admin; the draft is frozen. */
  pendingProposalId?: ObjectId;
  /**
   * How this customer pays. Optional because a customer on no arrangement is a real
   * state — and a different one from being on a permissive arrangement.
   */
  settlement?: { profileKey: string; overrides?: SettlementOverrides };
}

export interface ContractProposalDoc extends ContractProposal {
  _id: ObjectId;
}

export interface BookingExceptionDoc extends BookingExceptionRequest {
  _id: ObjectId;
}

async function customers(): Promise<Collection<CustomerDoc>> {
  return (await db()).collection<CustomerDoc>(COLLECTIONS.customers);
}

async function proposals(): Promise<Collection<ContractProposalDoc>> {
  return (await db()).collection<ContractProposalDoc>(COLLECTIONS.contractProposals);
}

async function exceptions(): Promise<Collection<BookingExceptionDoc>> {
  return (await db()).collection<BookingExceptionDoc>(COLLECTIONS.bookingExceptions);
}

export async function listCustomers(): Promise<CustomerDoc[]> {
  return (await customers()).find().sort({ name: 1 }).toArray();
}

/**
 * A customer code as it may arrive.
 *
 * Codes are used in URLs, and some contain a space — "SANDVIK PUNE" — which arrives from a
 * route parameter still percent-encoded. Decoding here rather than at each call site means
 * the page, the actions and the booking API all resolve the same customer. A malformed
 * sequence is left alone rather than throwing: it simply will not match anything.
 */
export function normaliseCustomerCode(code: string): string {
  let decoded = code;
  try {
    decoded = decodeURIComponent(code);
  } catch {
    // Not valid percent-encoding, so it was never encoded. Use it as it came.
  }
  return decoded.trim().toUpperCase();
}

export async function findCustomer(code: string): Promise<CustomerDoc | null> {
  return (await customers()).findOne({ code: normaliseCustomerCode(code) });
}

/**
 * Register a customer, typically from the booking website's POST.
 *
 * A new customer starts on the base card with no overrides and no restrictions —
 * they are priced exactly like everyone else until something is negotiated. That
 * makes onboarding a no-op pricing-wise, which is the safe default.
 */
export async function registerCustomer(input: {
  code: string;
  name: string;
  baseCardKey: string;
  source: 'api' | 'manual';
  actor: Actor;
}): Promise<{ customer: CustomerDoc; created: boolean }> {
  const code = input.code.trim().toUpperCase();
  const existing = await findCustomer(code);
  if (existing) return { customer: existing, created: false };

  const doc: CustomerDoc = {
    _id: new ObjectId(),
    code,
    name: input.name.trim(),
    baseCardKey: input.baseCardKey,
    status: 'active',
    source: input.source,
    createdAt: new Date(),
    liveTerms: EMPTY_TERMS,
    draftTerms: EMPTY_TERMS,
  };

  await (await customers()).insertOne(doc);
  await recordAudit({
    action: 'customer-registered',
    actor: input.actor,
    at: doc.createdAt,
    detail: { code, name: doc.name, baseCard: input.baseCardKey, source: input.source },
  });

  // The customer master lives here now, so the core has to be told a customer exists —
  // it is where their shipments attach and where the enterprise portal sign-in is issued.
  // Queued rather than sent: creating a customer must not fail because the core is
  // restarting, and the queue is durable. Later *edits* go through approval first; a
  // creation does not, because a customer nobody can transact with yet has nothing to
  // review, and one that exists here but not in the core cannot be booked for at all.
  const { queueCustomerPush } = await import('./core-push');
  const { toCorePayload } = await import('../customers/core-payload');
  await queueCustomerPush(toCorePayload({ ...doc, coreRevision: 1 }));

  return { customer: doc, created: true };
}

/**
 * Company master data — GSTIN, PAN, MSME, addresses, contacts, plants.
 *
 * Not versioned or approved: it is reference data about who the customer is, not a
 * price. Changing an address cannot alter what anybody is charged.
 */
export async function saveProfile(
  code: string,
  profile: CompanyProfile,
  actor: Actor,
): Promise<void> {
  const customer = await findCustomer(code);
  if (!customer) throw new Error(`customer ${code} not found`);

  await (await customers()).updateOne({ _id: customer._id }, { $set: { profile } });

  // Keeps the core in step when the profile is written as part of onboarding, before there
  // is anything to approve. An approved *change* to an existing profile queues its own push.
  const { queueCustomerPush: queuePush } = await import('./core-push');
  const { toCorePayload: toPayload } = await import('../customers/core-payload');
  await queuePush(toPayload({ ...customer, profile, coreRevision: (customer.coreRevision ?? 0) + 1 }));
  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { coreRevision: (customer.coreRevision ?? 0) + 1 } },
  );
  await recordAudit({
    action: 'customer-profile-updated',
    actor,
    at: new Date(),
    detail: { customer: code, plants: profile.plants.length, gstin: profile.gstin ?? 'none' },
  });
}

/** Commercial terms. These DO affect a quote, so they are audited. */
/**
 * Put a customer on a settlement arrangement, or change the one they are on.
 *
 * The overrides are sparse and replace whatever was there: a screen that writes the whole
 * form back should send only the fields that actually depart from the profile, which is
 * what `resolveSettlement` reports in `overridden`.
 */
/**
 * Put a customer on an arrangement, or move them to another one.
 *
 * What happens to their overrides is the decision here, and it goes two ways on purpose.
 *
 * An override is a departure from a **specific** profile — "periodDays: 60" means sixty
 * against that profile's forty-five. Carrying it onto a different arrangement would apply a
 * number somebody agreed in one context to a different one, so **moving profiles clears
 * them**. The screen says so before it happens.
 *
 * Re-assigning the profile they are already on **keeps** them, because that is a save rather
 * than a move, and silently discarding negotiated terms on a no-op is how a customer's
 * agreement quietly disappears.
 */
export async function assignSettlement(
  code: string,
  settlement: { profileKey: string; overrides?: SettlementOverrides },
  actor: Actor,
): Promise<void> {
  const customer = await findCustomer(code);
  if (!customer) throw new Error(`No customer ${code}.`);

  const staying = customer.settlement?.profileKey === settlement.profileKey;
  const overrides =
    settlement.overrides ?? (staying ? customer.settlement?.overrides : undefined);

  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { settlement: { profileKey: settlement.profileKey, ...(overrides === undefined ? {} : { overrides }) } } },
  );
  await recordAudit({
    action: 'settlement-assigned',
    actor,
    at: new Date(),
    detail: {
      customer: customer.code,
      profile: settlement.profileKey,
      from: customer.settlement?.profileKey ?? null,
      overrides: Object.keys(overrides ?? {}),
      // Recorded because it is not recoverable afterwards: a move that dropped negotiated
      // terms should be answerable later.
      clearedOverrides: staying ? 0 : Object.keys(customer.settlement?.overrides ?? {}).length,
    },
  });
}

export async function saveCommercialTerms(
  code: string,
  commercial: CommercialTerms,
  actor: Actor,
): Promise<void> {
  const customer = await findCustomer(code);
  if (!customer) throw new Error(`customer ${code} not found`);

  await (await customers()).updateOne({ _id: customer._id }, { $set: { commercial } });
  await recordAudit({
    action: 'customer-profile-updated',
    actor,
    at: new Date(),
    detail: {
      customer: code,
      billingType: commercial.billingType,
      gstApplicable: commercial.gstApplicable,
    },
  });
}

/** Has this customer ever been through approval? Decides whether setup is still soft. */
export async function hasEverProposed(code: string): Promise<boolean> {
  return (await (await proposals()).countDocuments({ customerCode: code })) > 0;
}

/**
 * Change a customer's code or base card, while neither means anything yet.
 *
 * Allowed only while the contract has no negotiated cells and has never been proposed.
 * After that the base card is load-bearing: every override path names a cell on *that*
 * card, and swapping it would reinterpret each of them without a single value changing.
 * Before that it is a typing mistake, and there is nothing to protect.
 */
export async function changeSetup(
  currentCode: string,
  next: { code: string; baseCardKey: string },
  actor: Actor,
): Promise<{ code: string }> {
  const customer = await findCustomer(currentCode);
  if (!customer) throw new Error(`customer ${currentCode} not found`);

  const negotiated =
    Object.keys(customer.liveTerms.overrides).length +
    Object.keys(customer.draftTerms.overrides).length;
  if (negotiated > 0) {
    throw new Error(
      `${customer.code} already has ${negotiated} negotiated cells. Changing the base card ` +
        `now would change what every one of them means.`,
    );
  }
  if (customer.pendingProposalId) {
    throw new Error(`${customer.code} has a proposal with an approver.`);
  }
  const everProposed = await (await proposals()).countDocuments({ customerCode: customer.code });
  if (everProposed > 0) {
    throw new Error(
      `${customer.code} has been through approval before, so its setup is part of the record.`,
    );
  }

  const code = next.code.trim().toUpperCase();
  if (code !== customer.code) {
    const clash = await findCustomer(code);
    if (clash) throw new Error(`${code} is already used by ${clash.name}.`);
  }

  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { code, baseCardKey: next.baseCardKey } },
  );
  await recordAudit({
    action: 'customer-registered',
    actor,
    at: new Date(),
    detail: { code, was: customer.code, baseCard: next.baseCardKey, setupChanged: true },
  });

  return { code };
}

/**
 * The segments this customer is in.
 *
 * Reference data like the profile, not a price: a tag decides which products are offered
 * to them, and applying a product still writes a draft that an approver sees. Tags are
 * trimmed and deduplicated case-insensitively on the way in, so "Ecom" and "ecom" cannot
 * both sit on one customer and make a segment count read as two.
 */
export async function setCustomerTags(
  code: string,
  tags: string[],
  actor: Actor,
): Promise<string[]> {
  const customer = await findCustomer(code);
  if (!customer) throw new Error(`customer ${code} not found`);

  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === '') continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(tag);
  }

  await (await customers()).updateOne({ _id: customer._id }, { $set: { tags: cleaned } });
  await recordAudit({
    action: 'customer-tagged',
    actor,
    at: new Date(),
    detail: { customer: code, tags: cleaned },
  });
  return cleaned;
}

/** The base card a customer's contract is written against. */
export async function baseCardFor(customer: CustomerDoc): Promise<RateCard> {
  const card = await liveCard(customer.baseCardKey);
  if (!card) throw new Error(`base rate card ${customer.baseCardKey} not found`);
  return card;
}

/** The prices this customer actually pays: base card with their overrides applied. */
export async function contractedCard(customer: CustomerDoc): Promise<RateCard> {
  return effectiveCard(await baseCardFor(customer), customer.liveTerms);
}

function assertEditable(customer: CustomerDoc): void {
  if (customer.pendingProposalId) {
    throw new Error(
      'This contract is awaiting approval and cannot be edited. ' +
        'Ask an admin to review it, or have the proposal rejected to reopen it.',
    );
  }
}

/** Write negotiated cells into the customer's draft contract. */
export async function editDraftContract(
  code: string,
  edits: { bind: BindPath; value: string | number | null }[],
  actor: Actor,
): Promise<CustomerDoc> {
  const customer = await findCustomer(code);
  if (!customer) throw new Error(`customer ${code} not found`);
  assertEditable(customer);

  const base = await baseCardFor(customer);
  const overrides: Overrides = { ...customer.draftTerms.overrides };
  for (const edit of edits) overrides[edit.bind] = edit.value;

  /**
   * Refused at the door, not discovered at quote time.
   *
   * An override holding an object replaces a whole block of the card when applied, and the
   * customer then prices to NaN — reported as a weight error, a long way from the write that
   * caused it. Cheaper to refuse the write.
   */
  const malformed = malformedOverrides(overrides);
  if (malformed.length > 0) {
    throw new Error(
      `An override has to be one value at one path — ${malformed.join(', ')} names a group. ` +
        `Use a dotted path such as charges.docket.`,
    );
  }

  // Anything that now matches the base is not a negotiated term.
  const { overrides: pruned } = pruneOverrides(base.data, overrides);
  const draftTerms: ContractTerms = { ...customer.draftTerms, overrides: pruned };

  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { draftTerms, lastEditedBy: actor, lastEditedAt: new Date() } },
  );
  return { ...customer, draftTerms };
}

/**
 * Replace the draft's overrides wholesale.
 *
 * Needed because `null` is a *value* in an override map — it means "this lane is not
 * carried" — so it cannot double as "remove this override". Anything absent from
 * `overrides` is genuinely dropped, which is what template `replace` requires.
 */
export async function setDraftOverrides(
  code: string,
  overrides: Overrides,
  actor: Actor,
): Promise<CustomerDoc> {
  const customer = await findCustomer(code);
  if (!customer) throw new Error(`customer ${code} not found`);
  assertEditable(customer);

  const base = await baseCardFor(customer);
  const { overrides: pruned } = pruneOverrides(base.data, overrides);
  const draftTerms: ContractTerms = { ...customer.draftTerms, overrides: pruned };

  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { draftTerms, lastEditedBy: actor, lastEditedAt: new Date() } },
  );
  return { ...customer, draftTerms };
}

/**
 * Freeze — or release — today's prices on the draft contract.
 *
 * Written straight onto `draftTerms.priceLock` rather than through the override map,
 * because a locked rate equals the base rate and pruning would delete every one of them
 * on the way in. Keeping it as its own map is what makes the promise survive the next
 * ordinary edit.
 */
export async function setDraftPriceLock(
  code: string,
  lock: PriceLock | null,
  actor: Actor,
): Promise<number> {
  const customer = await findCustomer(code);
  if (!customer) throw new Error(`customer ${code} not found`);
  assertEditable(customer);

  const draftTerms: ContractTerms = { ...customer.draftTerms };
  if (lock) draftTerms.priceLock = lock;
  else delete draftTerms.priceLock;

  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { draftTerms, lastEditedBy: actor, lastEditedAt: new Date() } },
  );

  const locked = Object.keys(lock?.rates ?? {}).length;
  await recordAudit({
    action: 'contract-prices-locked',
    actor,
    at: new Date(),
    detail: { customer: code, locked },
  });
  return locked;
}

export async function editDraftScope(
  code: string,
  scope: ContractScope,
  actor: Actor,
): Promise<CustomerDoc> {
  const customer = await findCustomer(code);
  if (!customer) throw new Error(`customer ${code} not found`);
  assertEditable(customer);

  const draftTerms: ContractTerms = { ...customer.draftTerms, scope };
  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { draftTerms, lastEditedBy: actor, lastEditedAt: new Date() } },
  );
  return { ...customer, draftTerms };
}

export async function discardDraftContract(code: string, actor: Actor): Promise<void> {
  const customer = await findCustomer(code);
  if (!customer) throw new Error(`customer ${code} not found`);
  assertEditable(customer);

  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { draftTerms: customer.liveTerms } },
  );
  await recordAudit({
    action: 'contract-draft-reset',
    actor,
    at: new Date(),
    detail: { customer: code },
  });
}

export async function proposeContract(code: string, actor: Actor): Promise<ContractProposalDoc> {
  const customer = await findCustomer(code);
  if (!customer) throw new Error(`customer ${code} not found`);
  assertEditable(customer);

  const base = await baseCardFor(customer);
  const proposal = buildProposal({
    customerCode: customer.code,
    base,
    liveTerms: customer.liveTerms,
    draftTerms: customer.draftTerms,
    submittedBy: actor,
    submittedAt: new Date(),
  });

  const doc: ContractProposalDoc = { ...proposal, _id: new ObjectId() };
  await (await proposals()).insertOne(doc);
  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { pendingProposalId: doc._id } },
  );
  await recordAudit({
    action: 'contract-proposed',
    actor,
    at: doc.submittedAt,
    detail: {
      customer: code,
      rateChanges: doc.changes.length,
      scopeChanges: doc.scopeChanges.length,
    },
  });

  return doc;
}

export async function pendingProposals(): Promise<ContractProposalDoc[]> {
  return (await proposals()).find({ status: 'pending' }).sort({ submittedAt: 1 }).toArray();
}

export async function proposalById(id: string): Promise<ContractProposalDoc | null> {
  return (await proposals()).findOne({ _id: new ObjectId(id) });
}

export async function proposalHistory(limit = 40): Promise<ContractProposalDoc[]> {
  return (await proposals())
    .find({ status: { $ne: 'pending' } })
    .sort({ reviewedAt: -1 })
    .limit(limit)
    .toArray();
}

export async function reviewProposal(
  proposalId: string,
  decisions: ProposalDecisions,
  actor: Actor,
  comment?: string,
): Promise<ContractProposalDoc> {
  const proposal = await proposalById(proposalId);
  if (!proposal) throw new Error(`proposal ${proposalId} not found`);

  const customer = await findCustomer(proposal.customerCode);
  if (!customer) throw new Error(`customer ${proposal.customerCode} not found`);

  const base = await baseCardFor(customer);
  const result = applyProposalDecision({
    proposal,
    base,
    liveTerms: customer.liveTerms,
    decisions,
    reviewedBy: actor,
    reviewedAt: new Date(),
    ...(comment === undefined ? {} : { comment }),
  });

  await (await customers()).updateOne(
    { _id: customer._id },
    {
      $set: { liveTerms: result.newLiveTerms, draftTerms: result.newDraftTerms },
      $unset: { pendingProposalId: '' },
    },
  );
  await (await proposals()).updateOne(
    { _id: proposal._id },
    {
      $set: {
        status: result.proposal.status,
        changes: result.proposal.changes,
        reviewedBy: actor,
        reviewedAt: result.proposal.reviewedAt as Date,
        selfApproved: result.proposal.selfApproved ?? false,
        ...(comment === undefined ? {} : { reviewComment: comment }),
      },
    },
  );
  await recordAudit({
    action: result.proposal.status,
    actor,
    at: result.proposal.reviewedAt as Date,
    detail: {
      customer: customer.code,
      approved: result.approvedCount,
      rejected: result.rejectedCount,
      overridesNow: Object.keys(result.newLiveTerms.overrides).length,
      selfApproved: result.proposal.selfApproved ?? false,
    },
  });

  return { ...proposal, ...result.proposal };
}

/* ------------------------------------------------------------------ bookings */

function reference(): string {
  return `BX-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

export async function createBookingException(
  input: Omit<BookingExceptionRequest, 'reference' | 'status' | 'requestedAt'>,
): Promise<BookingExceptionDoc> {
  const doc: BookingExceptionDoc = {
    ...input,
    _id: new ObjectId(),
    reference: reference(),
    status: 'pending',
    requestedAt: new Date(),
  };
  await (await exceptions()).insertOne(doc);
  return doc;
}

export async function findBookingException(ref: string): Promise<BookingExceptionDoc | null> {
  return (await exceptions()).findOne({ reference: ref.trim().toUpperCase() });
}

export async function pendingBookingExceptions(): Promise<BookingExceptionDoc[]> {
  return (await exceptions()).find({ status: 'pending' }).sort({ requestedAt: 1 }).toArray();
}

export async function bookingExceptionHistory(limit = 40): Promise<BookingExceptionDoc[]> {
  return (await exceptions())
    .find({ status: { $ne: 'pending' } })
    .sort({ decidedAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Decide a one-off booking that falls outside a contract.
 *
 * `addToContract` also widens the contract's scope so the same booking stops
 * needing approval — otherwise a lane a customer uses weekly would generate a
 * request every time.
 */
export async function decideBookingException(
  ref: string,
  approve: boolean,
  actor: Actor,
  options: { comment?: string; addToContract?: boolean } = {},
): Promise<BookingExceptionDoc> {
  const request = await findBookingException(ref);
  if (!request) throw new Error(`booking exception ${ref} not found`);
  if (request.status !== 'pending') {
    throw new Error(`This request has already been decided (${request.status}).`);
  }

  const decidedAt = new Date();
  await (await exceptions()).updateOne(
    { _id: request._id },
    {
      $set: {
        status: approve ? 'approved' : 'rejected',
        decidedBy: actor.name,
        decidedAt,
        ...(options.comment === undefined ? {} : { decisionComment: options.comment }),
        ...(options.addToContract === undefined ? {} : { addToContract: options.addToContract }),
      },
    },
  );

  // Folding the lane into the contract needs resolved zones, which only the caller
  // has; it calls `widenScopeForException` with them.

  await recordAudit({
    action: approve ? 'booking-exception-approved' : 'booking-exception-rejected',
    actor,
    at: decidedAt,
    detail: { reference: request.reference, customer: request.customerCode },
  });

  return { ...request, status: approve ? 'approved' : 'rejected', decidedAt };
}

/** Widen a live contract so a previously excepted shipment is covered in future. */
export async function widenScopeForException(
  customerCode: string,
  scope: ContractScope,
  actor: Actor,
): Promise<void> {
  const customer = await findCustomer(customerCode);
  if (!customer) throw new Error(`customer ${customerCode} not found`);

  await (await customers()).updateOne(
    { _id: customer._id },
    { $set: { 'liveTerms.scope': scope, 'draftTerms.scope': scope } },
  );
  await recordAudit({
    action: 'contract-scope-widened',
    actor,
    at: new Date(),
    detail: { customer: customerCode },
  });
}
