import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildProposal,
  applyProposalDecision,
  describeScopeChange,
  describeLockChange,
} from './proposal';
import { effectiveCard } from './contract';
import { laneKey, UNRESTRICTED_SCOPE, type ContractTerms } from '../domain/customers';
import type { RateCard } from '../domain/types';

const base: RateCard = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'model-1.json'), 'utf8'),
);

const editor = { id: 'u1', email: 'priya@dns', name: 'Priya' };
const admin = { id: 'u2', email: 'admin@dns', name: 'Admin' };
const at = new Date('2026-08-03T10:00:00Z');

const live: ContractTerms = { overrides: {}, scope: UNRESTRICTED_SCOPE };

const draft: ContractTerms = {
  overrides: {
    'grids.surface.minCharge.PNQ.NCR': 450,
    'grids.surface.tier1.PNQ.NCR': 13,
  },
  scope: {
    modes: ['surface'],
    lanes: [laneKey('surface', 'PNQ', 'NCR')],
    weightBands: null,
  },
};

describe('buildProposal', () => {
  const proposal = buildProposal({
    customerCode: 'ACME',
    base,
    liveTerms: live,
    draftTerms: draft,
    submittedBy: editor,
    submittedAt: at,
  });

  test('lists every negotiated rate as a labelled change', () => {
    expect(proposal.changes).toHaveLength(2);
    expect(proposal.changes[0]).toMatchObject({
      bind: 'grids.surface.minCharge.PNQ.NCR',
      sheet: 'Surface Rates',
      cellRef: 'J5',
      label: 'Surface Rates · min charge · PNQ→NCR',
      oldValue: 530,
      newValue: 450,
    });
  });

  test('shows the discount against the base as a percentage', () => {
    expect(proposal.changes[0]?.pctChange).toBeCloseTo(-15.09, 1);
  });

  test('records how the contract scope is being narrowed', () => {
    expect(proposal.scopeChanges).toHaveLength(2);
    const summary = proposal.scopeChanges.map((change) => change.field).sort();
    expect(summary).toEqual(['lanes', 'modes']);
  });

  test('refuses an empty proposal', () => {
    expect(() =>
      buildProposal({
        customerCode: 'ACME',
        base,
        liveTerms: live,
        draftTerms: live,
        submittedBy: editor,
        submittedAt: at,
      }),
    ).toThrow(/nothing to propose/i);
  });

  test('starts pending and undecided', () => {
    expect(proposal.status).toBe('pending');
    expect(proposal.changes.every((change) => change.decision === undefined)).toBe(true);
  });
});

describe('applyProposalDecision — approve', () => {
  const proposal = buildProposal({
    customerCode: 'ACME',
    base,
    liveTerms: live,
    draftTerms: draft,
    submittedBy: editor,
    submittedAt: at,
  });

  const result = applyProposalDecision({
    proposal,
    base,
    liveTerms: live,
    decisions: 'approve-all',
    reviewedBy: admin,
    reviewedAt: at,
  });

  test('stores only the negotiated cells, not a copy of the card', () => {
    expect(Object.keys(result.newLiveTerms.overrides).sort()).toEqual([
      'grids.surface.minCharge.PNQ.NCR',
      'grids.surface.tier1.PNQ.NCR',
    ]);
  });

  test('applies the agreed scope', () => {
    expect(result.newLiveTerms.scope.modes).toEqual(['surface']);
    expect(result.newLiveTerms.scope.lanes).toEqual([laneKey('surface', 'PNQ', 'NCR')]);
  });

  test('the customer now prices at the negotiated rate', () => {
    const card = effectiveCard(base, result.newLiveTerms);
    expect(card.data.grids.surface.minCharge.PNQ?.NCR).toBe(450);
  });

  test('the customer still tracks the base everywhere else', () => {
    const card = effectiveCard(base, result.newLiveTerms);
    expect(card.data.grids.surface.minCharge.PNQ?.BOM).toBe(
      base.data.grids.surface.minCharge.PNQ?.BOM,
    );
  });

  test('is marked approved', () => {
    expect(result.proposal.status).toBe('approved');
    expect(result.proposal.reviewedBy).toEqual(admin);
  });
});

describe('applyProposalDecision — reject', () => {
  const proposal = buildProposal({
    customerCode: 'ACME',
    base,
    liveTerms: live,
    draftTerms: draft,
    submittedBy: editor,
    submittedAt: at,
  });

  const result = applyProposalDecision({
    proposal,
    base,
    liveTerms: live,
    decisions: 'reject-all',
    reviewedBy: admin,
    reviewedAt: at,
    comment: 'Margin too thin on that lane.',
  });

  test('leaves the live contract untouched', () => {
    expect(result.newLiveTerms).toEqual(live);
  });

  test('keeps the proposal in the draft so it can be revised', () => {
    expect(result.newDraftTerms.overrides['grids.surface.minCharge.PNQ.NCR']).toBe(450);
  });

  test('keeps the reviewer comment', () => {
    expect(result.proposal.reviewComment).toBe('Margin too thin on that lane.');
  });
});

describe('applyProposalDecision — line by line', () => {
  const proposal = buildProposal({
    customerCode: 'ACME',
    base,
    liveTerms: live,
    draftTerms: draft,
    submittedBy: editor,
    submittedAt: at,
  });

  const result = applyProposalDecision({
    proposal,
    base,
    liveTerms: live,
    decisions: {
      'grids.surface.minCharge.PNQ.NCR': { decision: 'approved' },
      'grids.surface.tier1.PNQ.NCR': { decision: 'rejected', comment: 'Hold the per-kg rate.' },
    },
    reviewedBy: admin,
    reviewedAt: at,
  });

  test('promotes only the approved cell into the contract', () => {
    expect(Object.keys(result.newLiveTerms.overrides)).toEqual([
      'grids.surface.minCharge.PNQ.NCR',
    ]);
  });

  test('carries the rejected proposal back to the draft with its comment', () => {
    expect(result.newDraftTerms.overrides['grids.surface.tier1.PNQ.NCR']).toBe(13);
    const rejected = result.proposal.changes.find(
      (change) => change.bind === 'grids.surface.tier1.PNQ.NCR',
    );
    expect(rejected?.comment).toBe('Hold the per-kg rate.');
  });

  test('is marked partially approved', () => {
    expect(result.proposal.status).toBe('partially-approved');
  });
});

describe('applyProposalDecision — self approval', () => {
  const proposal = buildProposal({
    customerCode: 'ACME',
    base,
    liveTerms: live,
    draftTerms: draft,
    submittedBy: editor,
    submittedAt: at,
  });

  test('is allowed, so a single admin is not deadlocked', () => {
    const result = applyProposalDecision({
      proposal,
      base,
      liveTerms: live,
      decisions: 'approve-all',
      reviewedBy: editor,
      reviewedAt: at,
    });
    expect(result.proposal.status).toBe('approved');
  });

  test('is recorded on the proposal', () => {
    const result = applyProposalDecision({
      proposal,
      base,
      liveTerms: live,
      decisions: 'approve-all',
      reviewedBy: editor,
      reviewedAt: at,
    });
    expect(result.proposal.selfApproved).toBe(true);
  });

  test('a second-person review is not marked self-approved', () => {
    const result = applyProposalDecision({
      proposal,
      base,
      liveTerms: live,
      decisions: 'approve-all',
      reviewedBy: admin,
      reviewedAt: at,
    });
    expect(result.proposal.selfApproved).toBe(false);
  });
});

describe('describeScopeChange', () => {
  test('reads plainly for a reviewer', () => {
    expect(
      describeScopeChange({ field: 'modes', from: null, to: ['surface'] }),
    ).toMatch(/restricted to surface/i);
    expect(describeScopeChange({ field: 'lanes', from: null, to: ['surface:PNQ>NCR'] })).toMatch(
      /1 lane/i,
    );
  });
});

describe('a price lock in a proposal', () => {
  // Taken from the card itself, which is what a real lock is: today's prices, written
  // down. A lock whose numbers differ from the card is a negotiation wearing its clothes.
  const todaysMin = base.data.grids.surface.minCharge.PNQ?.NCR as number;
  const todaysTier1 = base.data.grids.surface.tier1.PNQ?.NCR as number;

  const locked: ContractTerms = {
    overrides: {},
    scope: UNRESTRICTED_SCOPE,
    priceLock: {
      at,
      by: 'Priya',
      rates: {
        'grids.surface.minCharge.PNQ.NCR': todaysMin,
        'grids.surface.tier1.PNQ.NCR': todaysTier1,
      },
    },
  };

  test('reaches review even though it moves no price today', () => {
    // The whole reason it needs its own line: the cell diff is empty by construction,
    // because a locked rate is what the card already charges.
    const proposal = buildProposal({
      customerCode: 'ACME',
      base,
      liveTerms: live,
      draftTerms: locked,
      submittedBy: editor,
      submittedAt: at,
    });

    expect(proposal.changes).toHaveLength(0);
    expect(proposal.lockChange).toEqual({ from: 0, to: 2 });
    expect(describeLockChange(proposal.lockChange!)).toContain('2 lane rates');
  });

  test('approving it puts the lock on the live contract', () => {
    const proposal = buildProposal({
      customerCode: 'ACME',
      base,
      liveTerms: live,
      draftTerms: locked,
      submittedBy: editor,
      submittedAt: at,
    });

    const result = applyProposalDecision({
      proposal,
      base,
      liveTerms: live,
      decisions: 'approve-all',
      reviewedBy: admin,
      reviewedAt: at,
    });

    expect(Object.keys(result.newLiveTerms.priceLock?.rates ?? {})).toHaveLength(2);
    expect(result.newDraftTerms.priceLock?.by).toBe('Priya');
  });

  test('rejecting it leaves the live contract tracking the base card', () => {
    const proposal = buildProposal({
      customerCode: 'ACME',
      base,
      liveTerms: live,
      draftTerms: locked,
      submittedBy: editor,
      submittedAt: at,
    });

    const result = applyProposalDecision({
      proposal,
      base,
      liveTerms: live,
      decisions: 'reject-all',
      reviewedBy: admin,
      reviewedAt: at,
    });

    expect(result.newLiveTerms.priceLock).toBeUndefined();
  });

  test('a locked rate survives pruning, which is the reason it is stored apart', () => {
    // Written into `overrides` these would all be dropped for equalling the base. The
    // separate map is what makes the promise outlive the next ordinary edit.
    const result = applyProposalDecision({
      proposal: buildProposal({
        customerCode: 'ACME',
        base,
        liveTerms: live,
        draftTerms: locked,
        submittedBy: editor,
        submittedAt: at,
      }),
      base,
      liveTerms: live,
      decisions: 'approve-all',
      reviewedBy: admin,
      reviewedAt: at,
    });

    expect(result.newLiveTerms.overrides).toEqual({});
    expect(result.newLiveTerms.priceLock?.rates['grids.surface.minCharge.PNQ.NCR']).toBe(todaysMin);
  });

  test('a negotiated rate still wins over a locked one', () => {
    const card = effectiveCard(base, {
      ...locked,
      overrides: { 'grids.surface.minCharge.PNQ.NCR': 450 },
    });

    expect(card.data.grids.surface.minCharge.PNQ?.NCR).toBe(450);
  });

  test('a lock prices the lane when nothing was negotiated', () => {
    const stale = { ...base, data: { ...base.data } };
    const card = effectiveCard(stale, locked);

    expect(card.data.grids.surface.minCharge.PNQ?.NCR).toBe(todaysMin);
  });
});

describe('a proposal with nothing to count', () => {
  const scopeOnly: ContractTerms = {
    overrides: {},
    scope: { modes: ['surface'], lanes: null, weightBands: null },
  };

  test('rejecting a coverage-only proposal rejects it, rather than applying the coverage', () => {
    // The outcome used to be decided by counting approved and rejected lines, and a
    // proposal that changes only what the contract covers has none of either.
    const proposal = buildProposal({
      customerCode: 'ACME',
      base,
      liveTerms: live,
      draftTerms: scopeOnly,
      submittedBy: editor,
      submittedAt: at,
    });

    const result = applyProposalDecision({
      proposal,
      base,
      liveTerms: live,
      decisions: 'reject-all',
      reviewedBy: admin,
      reviewedAt: at,
    });

    expect(result.proposal.status).toBe('rejected');
    expect(result.newLiveTerms.scope.modes).toBeNull();
  });

  test('approving one still applies it', () => {
    const proposal = buildProposal({
      customerCode: 'ACME',
      base,
      liveTerms: live,
      draftTerms: scopeOnly,
      submittedBy: editor,
      submittedAt: at,
    });

    const result = applyProposalDecision({
      proposal,
      base,
      liveTerms: live,
      decisions: 'approve-all',
      reviewedBy: admin,
      reviewedAt: at,
    });

    expect(result.proposal.status).toBe('approved');
    expect(result.newLiveTerms.scope.modes).toEqual(['surface']);
  });
});
