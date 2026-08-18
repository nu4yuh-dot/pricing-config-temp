import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitDraft, applyReview, canEditDraft } from './workflow';
import { setByPath, getByPath } from '../sheets/resolve';
import { diffCardData } from '../changes/diff';
import type { RateCard, RateCardData } from '../domain/types';

const card: RateCard = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'model-1.json'), 'utf8'),
);
const live = card.data;

const editor = { id: 'u1', email: 'priya@dnslogistic.com', name: 'Priya' };
const admin = { id: 'u2', email: 'admin@dnslogistic.com', name: 'Admin' };
const at = new Date('2026-08-03T10:00:00Z');

/** A draft with two rate edits and one global parameter edit. */
function draftWithEdits(): RateCardData {
  let draft = setByPath<RateCardData>(live, 'grids.surface.minCharge.PNQ.NCR', 560);
  draft = setByPath(draft, 'grids.surface.tier1.PNQ.NCR', 16);
  draft = setByPath(draft, 'charges.fuelSurface', 0.28);
  return draft;
}

describe('canEditDraft', () => {
  test('allows editing a draft', () => {
    expect(canEditDraft('draft')).toBe(true);
  });

  test('locks a draft that is awaiting review, so the diff cannot drift', () => {
    expect(canEditDraft('pending')).toBe(false);
  });

  test('does not allow editing a live or archived version', () => {
    expect(canEditDraft('live')).toBe(false);
    expect(canEditDraft('archived')).toBe(false);
  });
});

describe('submitDraft', () => {
  const result = submitDraft({
    rateCardId: 'card-1',
    liveData: live,
    draftData: draftWithEdits(),
    submittedBy: editor,
    submittedAt: at,
  });

  test('moves the draft into pending review', () => {
    expect(result.versionState).toBe('pending');
  });

  test('records every changed cell', () => {
    expect(result.changeRequest.changes).toHaveLength(3);
    expect(result.changeRequest.changes.map((c) => c.bind).sort()).toEqual([
      'charges.fuelSurface',
      'grids.surface.minCharge.PNQ.NCR',
      'grids.surface.tier1.PNQ.NCR',
    ]);
  });

  test('leaves every change undecided', () => {
    for (const change of result.changeRequest.changes) {
      expect(change.decision).toBeUndefined();
    }
  });

  test('attaches validation findings for the reviewer', () => {
    const codes = result.changeRequest.findings.map((f) => f.code);
    expect(codes).toContain('global-parameter');
  });

  test('records who submitted it and when', () => {
    expect(result.changeRequest.submittedBy).toEqual(editor);
    expect(result.changeRequest.submittedAt).toEqual(at);
    expect(result.changeRequest.status).toBe('pending');
  });

  test('refuses to submit when nothing changed', () => {
    expect(() =>
      submitDraft({
        rateCardId: 'card-1',
        liveData: live,
        draftData: live,
        submittedBy: editor,
        submittedAt: at,
      }),
    ).toThrow(/no changes/i);
  });
});

describe('applyReview — approve everything', () => {
  const submitted = submitDraft({
    rateCardId: 'card-1',
    liveData: live,
    draftData: draftWithEdits(),
    submittedBy: editor,
    submittedAt: at,
  });

  const result = applyReview({
    changeRequest: submitted.changeRequest,
    liveData: live,
    decisions: 'approve-all',
    reviewedBy: admin,
    reviewedAt: at,
  });

  test('marks the request approved', () => {
    expect(result.changeRequest.status).toBe('approved');
    expect(result.changeRequest.reviewedBy).toEqual(admin);
  });

  test('promotes every approved value into the new live data', () => {
    expect(getByPath(result.newLiveData, 'grids.surface.minCharge.PNQ.NCR')).toBe(560);
    expect(getByPath(result.newLiveData, 'grids.surface.tier1.PNQ.NCR')).toBe(16);
    expect(getByPath(result.newLiveData, 'charges.fuelSurface')).toBe(0.28);
  });

  test('leaves untouched values alone', () => {
    expect(getByPath(result.newLiveData, 'grids.surface.minCharge.PNQ.PNQ')).toBe(
      getByPath(live, 'grids.surface.minCharge.PNQ.PNQ'),
    );
  });

  test('forks a fresh draft equal to the new live data', () => {
    expect(result.newDraftData).toEqual(result.newLiveData);
  });

  test('reports what the audit log should record', () => {
    expect(result.audit.action).toBe('approved');
    expect(result.audit.approvedCount).toBe(3);
    expect(result.audit.rejectedCount).toBe(0);
  });
});

describe('applyReview — reject everything', () => {
  const submitted = submitDraft({
    rateCardId: 'card-1',
    liveData: live,
    draftData: draftWithEdits(),
    submittedBy: editor,
    submittedAt: at,
  });

  const result = applyReview({
    changeRequest: submitted.changeRequest,
    liveData: live,
    decisions: 'reject-all',
    reviewedBy: admin,
    reviewedAt: at,
    comment: 'Hold until the Q3 fuel review.',
  });

  test('marks the request rejected and keeps the comment', () => {
    expect(result.changeRequest.status).toBe('rejected');
    expect(result.changeRequest.reviewComment).toBe('Hold until the Q3 fuel review.');
  });

  test('leaves live data completely unchanged', () => {
    expect(result.newLiveData).toEqual(live);
  });

  test('returns the proposed values to the draft so the team can revise them', () => {
    expect(getByPath(result.newDraftData, 'grids.surface.minCharge.PNQ.NCR')).toBe(560);
    expect(getByPath(result.newDraftData, 'charges.fuelSurface')).toBe(0.28);
  });

  test('reopens the draft for editing', () => {
    expect(result.newVersionState).toBe('draft');
  });
});

describe('applyReview — decide line by line', () => {
  const submitted = submitDraft({
    rateCardId: 'card-1',
    liveData: live,
    draftData: draftWithEdits(),
    submittedBy: editor,
    submittedAt: at,
  });

  const result = applyReview({
    changeRequest: submitted.changeRequest,
    liveData: live,
    decisions: {
      'grids.surface.minCharge.PNQ.NCR': { decision: 'approved' },
      'grids.surface.tier1.PNQ.NCR': { decision: 'approved' },
      'charges.fuelSurface': { decision: 'rejected', comment: 'Fuel is set group-wide.' },
    },
    reviewedBy: admin,
    reviewedAt: at,
  });

  test('marks the request partially approved', () => {
    expect(result.changeRequest.status).toBe('partially-approved');
  });

  test('promotes only the approved cells to live', () => {
    expect(getByPath(result.newLiveData, 'grids.surface.minCharge.PNQ.NCR')).toBe(560);
    expect(getByPath(result.newLiveData, 'grids.surface.tier1.PNQ.NCR')).toBe(16);
  });

  test('keeps the rejected cell at its live value', () => {
    expect(getByPath(result.newLiveData, 'charges.fuelSurface')).toBe(
      getByPath(live, 'charges.fuelSurface'),
    );
  });

  test('carries the rejected proposal into the new draft with its comment', () => {
    expect(getByPath(result.newDraftData, 'charges.fuelSurface')).toBe(0.28);
    const rejected = result.changeRequest.changes.find((c) => c.bind === 'charges.fuelSurface');
    expect(rejected?.decision).toBe('rejected');
    expect(rejected?.comment).toBe('Fuel is set group-wide.');
  });

  test('a fresh diff of the new draft shows only what is still outstanding', () => {
    const outstanding = diffCardData(result.newLiveData, result.newDraftData);
    expect(outstanding.map((c) => c.bind)).toEqual(['charges.fuelSurface']);
  });

  test('counts both sides for the audit log', () => {
    expect(result.audit.approvedCount).toBe(2);
    expect(result.audit.rejectedCount).toBe(1);
  });

  test('treats an undecided change as rejected rather than silently approving it', () => {
    const partial = applyReview({
      changeRequest: submitted.changeRequest,
      liveData: live,
      decisions: { 'grids.surface.minCharge.PNQ.NCR': { decision: 'approved' } },
      reviewedBy: admin,
      reviewedAt: at,
    });
    expect(getByPath(partial.newLiveData, 'charges.fuelSurface')).toBe(
      getByPath(live, 'charges.fuelSurface'),
    );
    expect(partial.audit.approvedCount).toBe(1);
    expect(partial.audit.rejectedCount).toBe(2);
  });
});

describe('applyReview — guards', () => {
  test('refuses to review a request that is not pending', () => {
    const submitted = submitDraft({
      rateCardId: 'card-1',
      liveData: live,
      draftData: draftWithEdits(),
      submittedBy: editor,
      submittedAt: at,
    });
    const alreadyApproved = applyReview({
      changeRequest: submitted.changeRequest,
      liveData: live,
      decisions: 'approve-all',
      reviewedBy: admin,
      reviewedAt: at,
    });

    expect(() =>
      applyReview({
        changeRequest: alreadyApproved.changeRequest,
        liveData: live,
        decisions: 'approve-all',
        reviewedBy: admin,
        reviewedAt: at,
      }),
    ).toThrow(/already been reviewed/i);
  });

  /**
   * Self-approval is permitted, because forbidding it deadlocked the only admin:
   * they were the sole role allowed to review, and barred from reviewing their own
   * work, so nothing could ever go live. It is recorded instead of prevented.
   */
  test('allows the submitter to approve their own request', () => {
    const submitted = submitDraft({
      rateCardId: 'card-1',
      liveData: live,
      draftData: draftWithEdits(),
      submittedBy: editor,
      submittedAt: at,
    });

    const result = applyReview({
      changeRequest: submitted.changeRequest,
      liveData: live,
      decisions: 'approve-all',
      reviewedBy: editor,
      reviewedAt: at,
    });
    expect(result.changeRequest.status).toBe('approved');
    expect(getByPath(result.newLiveData, 'grids.surface.minCharge.PNQ.NCR')).toBe(560);
  });

  test('marks a self-approval as such, on the request and in the audit', () => {
    const submitted = submitDraft({
      rateCardId: 'card-1',
      liveData: live,
      draftData: draftWithEdits(),
      submittedBy: editor,
      submittedAt: at,
    });

    const result = applyReview({
      changeRequest: submitted.changeRequest,
      liveData: live,
      decisions: 'approve-all',
      reviewedBy: editor,
      reviewedAt: at,
    });

    expect(result.changeRequest.selfApproved).toBe(true);
    expect(result.audit.selfApproved).toBe(true);
  });

  test('does not mark a genuine second-person review as self-approved', () => {
    const submitted = submitDraft({
      rateCardId: 'card-1',
      liveData: live,
      draftData: draftWithEdits(),
      submittedBy: editor,
      submittedAt: at,
    });

    const result = applyReview({
      changeRequest: submitted.changeRequest,
      liveData: live,
      decisions: 'approve-all',
      reviewedBy: admin,
      reviewedAt: at,
    });

    expect(result.changeRequest.selfApproved).toBe(false);
    expect(result.audit.selfApproved).toBe(false);
  });
});
