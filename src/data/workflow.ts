import type { RateCardData } from '../domain/types';
import { diffCardData, type Change } from '../changes/diff';
import { validateChanges, type Finding } from '../changes/validate';
import { setByPath } from '../sheets/resolve';
import type { BindPath } from '../sheets/types';

/**
 * The approval state machine, as pure functions.
 *
 * Nothing here touches the database. The repositories persist whatever these
 * return, which keeps the rules that matter — what reaches live pricing — testable
 * without a Mongo instance.
 */

export type VersionState = 'draft' | 'pending' | 'live' | 'archived';

export interface Actor {
  id: string;
  email: string;
  name: string;
}

export type ChangeDecision = 'approved' | 'rejected';

export interface ReviewedChange extends Change {
  decision?: ChangeDecision;
  comment?: string;
}

/** The outcome of a review. A reviewed request is never back in `pending`. */
export type ReviewOutcome = 'approved' | 'rejected' | 'partially-approved';

export type ChangeRequestStatus = 'pending' | ReviewOutcome;

export interface ChangeRequest {
  rateCardId: string;
  status: ChangeRequestStatus;
  /**
   * True when the person who submitted also approved it.
   *
   * Self-approval is permitted rather than blocked: forbidding it deadlocked a
   * single-admin setup, since `admin` is the only role that may review and nobody
   * could review their own work. It is recorded so the absence of a second pair of
   * eyes is visible on the request and in the audit log.
   */
  selfApproved?: boolean;
  changes: ReviewedChange[];
  findings: Finding[];
  submittedBy: Actor;
  submittedAt: Date;
  reviewedBy?: Actor;
  reviewedAt?: Date;
  reviewComment?: string;
}

/** A draft is editable only while it is a draft; review freezes it. */
export function canEditDraft(state: VersionState): boolean {
  return state === 'draft';
}

export interface SubmitInput {
  rateCardId: string;
  liveData: RateCardData;
  draftData: RateCardData;
  submittedBy: Actor;
  submittedAt: Date;
}

export interface SubmitResult {
  versionState: VersionState;
  changeRequest: ChangeRequest;
}

/**
 * Close a draft for review. The diff is computed once, here, and stored on the
 * request — so what the reviewer sees is exactly what they decide on, even if the
 * live data moves underneath in the meantime.
 */
export function submitDraft(input: SubmitInput): SubmitResult {
  const changes = diffCardData(input.liveData, input.draftData);
  if (changes.length === 0) {
    throw new Error('Cannot submit for approval: there are no changes against the live version.');
  }

  return {
    versionState: 'pending',
    changeRequest: {
      rateCardId: input.rateCardId,
      status: 'pending',
      changes,
      findings: validateChanges(changes),
      submittedBy: input.submittedBy,
      submittedAt: input.submittedAt,
    },
  };
}

export type ReviewDecisions =
  | 'approve-all'
  | 'reject-all'
  | Record<BindPath, { decision: ChangeDecision; comment?: string }>;

export interface ReviewInput {
  changeRequest: ChangeRequest;
  liveData: RateCardData;
  decisions: ReviewDecisions;
  reviewedBy: Actor;
  reviewedAt: Date;
  comment?: string;
}

export interface ReviewAudit {
  action: ReviewOutcome;
  approvedCount: number;
  rejectedCount: number;
  reviewedBy: Actor;
  reviewedAt: Date;
  /** Recorded so a review with no second pair of eyes is auditable. */
  selfApproved: boolean;
}

export interface ReviewResult {
  changeRequest: ChangeRequest;
  /** Live data with the approved changes applied. */
  newLiveData: RateCardData;
  /** Fresh draft: the new live data, plus any rejected proposals to revise. */
  newDraftData: RateCardData;
  newVersionState: VersionState;
  audit: ReviewAudit;
}

function decide(
  change: Change,
  decisions: ReviewDecisions,
): { decision: ChangeDecision; comment?: string } {
  if (decisions === 'approve-all') return { decision: 'approved' };
  if (decisions === 'reject-all') return { decision: 'rejected' };
  // An undecided line is treated as rejected: silence must never promote a rate.
  return decisions[change.bind] ?? { decision: 'rejected' };
}

function statusFor(approved: number, rejected: number): ReviewOutcome {
  if (rejected === 0) return 'approved';
  if (approved === 0) return 'rejected';
  return 'partially-approved';
}

/**
 * Apply a review.
 *
 * Approved cells move into live pricing. Rejected cells stay out of live but are
 * carried back into the draft with the reviewer's comment, so the team can revise
 * rather than retype them.
 */
export function applyReview(input: ReviewInput): ReviewResult {
  const { changeRequest, liveData, decisions, reviewedBy, reviewedAt } = input;

  if (changeRequest.status !== 'pending') {
    throw new Error(
      `This change request has already been reviewed (status: ${changeRequest.status}).`,
    );
  }
  // Self-approval is allowed and recorded; see `ChangeRequest.selfApproved`.
  const selfApproved = changeRequest.submittedBy.id === reviewedBy.id;

  let newLiveData = liveData;
  let newDraftData = liveData;
  let approvedCount = 0;
  let rejectedCount = 0;

  const reviewed: ReviewedChange[] = changeRequest.changes.map((change) => {
    const { decision, comment } = decide(change, decisions);
    if (decision === 'approved') {
      approvedCount++;
      newLiveData = setByPath(newLiveData, change.bind, change.newValue);
      newDraftData = setByPath(newDraftData, change.bind, change.newValue);
    } else {
      rejectedCount++;
      // Keep the proposal visible in the draft; it just never reached live.
      newDraftData = setByPath(newDraftData, change.bind, change.newValue);
    }
    return { ...change, decision, ...(comment === undefined ? {} : { comment }) };
  });

  const status = statusFor(approvedCount, rejectedCount);

  return {
    changeRequest: {
      ...changeRequest,
      status,
      changes: reviewed,
      reviewedBy,
      reviewedAt,
      selfApproved,
      ...(input.comment === undefined ? {} : { reviewComment: input.comment }),
    },
    newLiveData,
    newDraftData,
    // Rejected work goes back to the team; a clean sweep starts a fresh draft.
    newVersionState: 'draft',
    audit: { action: status, approvedCount, rejectedCount, reviewedBy, reviewedAt, selfApproved },
  };
}
