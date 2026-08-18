import type { RateCard } from '../domain/types';
import type { ContractScope, ContractTerms, Overrides, PriceLock } from '../domain/customers';
import { effectiveCard, overridesFrom } from './contract';
import { diffCardData } from '../changes/diff';
import type { Change } from '../changes/diff';
import type { Actor, ChangeDecision, ReviewOutcome } from '../data/workflow';
import type { BindPath } from '../sheets/types';

/**
 * Contract proposals.
 *
 * A negotiated rate is still a price change, so it goes through the same review as
 * a base-card edit — and reuses the same diff, which means an approver reads
 * "Surface Rates · min charge · PNQ→NCR · 530 → 450 (−15.1%)" rather than a raw
 * override map.
 */

export interface ScopeChange {
  field: 'modes' | 'lanes' | 'weightBands';
  from: unknown;
  to: unknown;
}

export interface ProposalChange extends Change {
  decision?: ChangeDecision;
  comment?: string;
}

export type ProposalStatus = 'pending' | ReviewOutcome;

export interface ContractProposal {
  customerCode: string;
  status: ProposalStatus;
  changes: ProposalChange[];
  scopeChanges: ScopeChange[];
  /** The scope being proposed, applied wholesale if any part is approved. */
  proposedScope: ContractScope;
  /**
   * A price lock added or removed in this draft.
   *
   * Reported separately because it changes no price *today* — a locked rate equals what
   * the card charges as it stands, so the cell diff is empty — and changes every future
   * one, by stopping the customer tracking the base card. An approver who saw nothing
   * would be approving exactly that.
   */
  lockChange?: { from: number; to: number };
  /** The lock being proposed, applied wholesale like the scope. Null means "remove it". */
  proposedLock?: PriceLock | null;
  submittedBy: Actor;
  submittedAt: Date;
  reviewedBy?: Actor;
  reviewedAt?: Date;
  reviewComment?: string;
  /** True when the proposer also approved it. Recorded, not prevented. */
  selfApproved?: boolean;
}

function scopeDiff(from: ContractScope, to: ContractScope): ScopeChange[] {
  const changes: ScopeChange[] = [];
  for (const field of ['modes', 'lanes', 'weightBands'] as const) {
    if (JSON.stringify(from[field]) !== JSON.stringify(to[field])) {
      changes.push({ field, from: from[field], to: to[field] });
    }
  }
  return changes;
}

/** A one-line summary of a scope change, for the review queue. */
export function describeScopeChange(change: ScopeChange): string {
  const count = Array.isArray(change.to) ? change.to.length : 0;

  if (change.field === 'modes') {
    if (change.to === null) return 'All modes become available.';
    return `Modes restricted to ${(change.to as string[]).join(', ')}.`;
  }
  if (change.field === 'lanes') {
    if (change.to === null) return 'All lanes become available.';
    const before = Array.isArray(change.from) ? change.from.length : 'all';
    return `Contracted lanes: ${count} lane${count === 1 ? '' : 's'} (was ${before}).`;
  }
  if (change.to === null) return 'All weights become available.';
  return `Contracted weight bands: ${count}.`;
}

export interface BuildProposalInput {
  customerCode: string;
  base: RateCard;
  liveTerms: ContractTerms;
  draftTerms: ContractTerms;
  submittedBy: Actor;
  submittedAt: Date;
}

/**
 * Close a customer's draft contract for review.
 *
 * The rate changes are diffed through the effective cards rather than the raw
 * override maps, so a change reads against what the customer is actually paying
 * today — which is what an approver needs to judge a discount.
 */
export function buildProposal(input: BuildProposalInput): ContractProposal {
  const before = effectiveCard(input.base, input.liveTerms).data;
  const after = effectiveCard(input.base, input.draftTerms).data;

  const changes = diffCardData(before, after);
  const scopeChanges = scopeDiff(input.liveTerms.scope, input.draftTerms.scope);

  const lockedBefore = Object.keys(input.liveTerms.priceLock?.rates ?? {}).length;
  const lockedAfter = Object.keys(input.draftTerms.priceLock?.rates ?? {}).length;
  const lockChange = lockedBefore === lockedAfter ? undefined : { from: lockedBefore, to: lockedAfter };

  if (changes.length === 0 && scopeChanges.length === 0 && !lockChange) {
    throw new Error('There is nothing to propose: this contract matches the approved one.');
  }

  return {
    customerCode: input.customerCode,
    status: 'pending',
    changes,
    scopeChanges,
    proposedScope: input.draftTerms.scope,
    ...(lockChange ? { lockChange, proposedLock: input.draftTerms.priceLock ?? null } : {}),
    submittedBy: input.submittedBy,
    submittedAt: input.submittedAt,
  };
}

/** A one-line summary of a lock change, for the review queue. */
export function describeLockChange(change: { from: number; to: number }): string {
  if (change.to === 0) {
    return `Price lock removed. ${change.from} lane rates go back to tracking the base card.`;
  }
  if (change.from === 0) {
    return (
      `Today's prices locked on ${change.to} lane rates. These stop following base-card ` +
      `changes until the lock is removed.`
    );
  }
  return `Price lock re-taken: ${change.from} lane rates become ${change.to}, as of today.`;
}

export type ProposalDecisions =
  | 'approve-all'
  | 'reject-all'
  | Record<BindPath, { decision: ChangeDecision; comment?: string }>;

export interface ApplyProposalInput {
  proposal: ContractProposal;
  base: RateCard;
  liveTerms: ContractTerms;
  decisions: ProposalDecisions;
  reviewedBy: Actor;
  reviewedAt: Date;
  comment?: string;
}

/** A proposal that has been through review: its status can no longer be `pending`. */
export type ReviewedProposal = Omit<ContractProposal, 'status'> & { status: ReviewOutcome };

export interface ApplyProposalResult {
  proposal: ReviewedProposal;
  newLiveTerms: ContractTerms;
  newDraftTerms: ContractTerms;
  approvedCount: number;
  rejectedCount: number;
}

function decide(
  bind: BindPath,
  decisions: ProposalDecisions,
): { decision: ChangeDecision; comment?: string } {
  if (decisions === 'approve-all') return { decision: 'approved' };
  if (decisions === 'reject-all') return { decision: 'rejected' };
  // Silence is a rejection: an undecided line must never reach a customer's price.
  return decisions[bind] ?? { decision: 'rejected' };
}

/**
 * Apply a review to a contract proposal.
 *
 * Approved rates become overrides; rejected ones stay in the draft with the
 * reviewer's comment so the team can renegotiate rather than retype. The overrides
 * are rebuilt from the resulting card, which prunes any that no longer differ from
 * the base — a contract should never pin a customer to a value the base already
 * gives them.
 */
export function applyProposalDecision(input: ApplyProposalInput): ApplyProposalResult {
  const { proposal, base, liveTerms, decisions, reviewedBy, reviewedAt } = input;

  if (proposal.status !== 'pending') {
    throw new Error(`This proposal has already been reviewed (${proposal.status}).`);
  }
  // Allowed and recorded, so a single admin is not deadlocked.
  const selfApproved = proposal.submittedBy.id === reviewedBy.id;

  const liveOverrides: Overrides = { ...liveTerms.overrides };
  const draftOverrides: Overrides = { ...liveTerms.overrides };
  let approvedCount = 0;
  let rejectedCount = 0;

  const reviewed: ProposalChange[] = proposal.changes.map((change) => {
    const { decision, comment } = decide(change.bind, decisions);
    if (decision === 'approved') {
      approvedCount++;
      liveOverrides[change.bind] = change.newValue;
      draftOverrides[change.bind] = change.newValue;
    } else {
      rejectedCount++;
      draftOverrides[change.bind] = change.newValue;
    }
    return { ...change, decision, ...(comment === undefined ? {} : { comment }) };
  });

  const anythingApproved =
    approvedCount > 0 || proposal.scopeChanges.length > 0 || proposal.lockChange !== undefined;
  // A proposal with no rate lines — coverage only, or a price lock only — has nothing to
  // count, and counting was the only thing deciding the outcome. So "reject all" used to
  // come out as `approved` and apply the very coverage it was refusing. An explicit
  // rejection with nothing approved is a rejection, whether or not any line existed.
  const rejectedOutright = decisions === 'reject-all' && approvedCount === 0;
  const status: ReviewOutcome = rejectedOutright
    ? 'rejected'
    : rejectedCount === 0
      ? 'approved'
      : approvedCount === 0
        ? 'rejected'
        : 'partially-approved';

  // Scope is agreed as a whole rather than line by line: a partial scope would
  // leave a contract covering lanes nobody signed off.
  const newScope =
    status === 'rejected' ? liveTerms.scope : (proposal.proposedScope ?? liveTerms.scope);

  // A lock is agreed as a whole, like the scope: half a promise not to move prices is
  // not a promise. Rejecting the proposal outright leaves the live lock as it was.
  const newLock =
    status === 'rejected' || proposal.proposedLock === undefined
      ? liveTerms.priceLock
      : (proposal.proposedLock ?? undefined);

  const newLiveTerms: ContractTerms = {
    overrides: anythingApproved && status !== 'rejected' ? liveOverrides : liveTerms.overrides,
    scope: newScope,
    ...(newLock ? { priceLock: newLock } : {}),
    // Carried rather than rebuilt. Everything this function knows how to decide is a
    // cell; anything else on the terms has to survive a review it was never part of.
    ...(liveTerms.laneRules ? { laneRules: liveTerms.laneRules } : {}),
  };

  // Rebuild from the resulting card so any override equal to base is dropped — where
  // "base" means the card *plus any lock*, not the card alone. Pruning against the bare
  // card would turn every locked rate into a negotiated one the moment the card moved,
  // and a promise not to drift would come back as thousands of bargained cells.
  const baseline = effectiveCard(base, {
    overrides: {},
    scope: newScope,
    ...(newLock ? { priceLock: newLock } : {}),
  }).data;

  const prunedLive = overridesFrom(baseline, effectiveCard(base, newLiveTerms).data);
  const prunedDraft = overridesFrom(
    baseline,
    effectiveCard(base, {
      overrides: draftOverrides,
      scope: newScope,
      ...(newLock ? { priceLock: newLock } : {}),
    }).data,
  );

  return {
    proposal: {
      ...proposal,
      status,
      changes: reviewed,
      reviewedBy,
      reviewedAt,
      selfApproved,
      ...(input.comment === undefined ? {} : { reviewComment: input.comment }),
    },
    newLiveTerms: { ...newLiveTerms, overrides: prunedLive },
    newDraftTerms: {
      overrides: prunedDraft,
      scope: newScope,
      ...(newLock ? { priceLock: newLock } : {}),
      ...(liveTerms.laneRules ? { laneRules: liveTerms.laneRules } : {}),
    },
    approvedCount,
    rejectedCount,
  };
}
