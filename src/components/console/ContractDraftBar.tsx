'use client';

import { useState, useTransition } from 'react';
import { submitContractProposal, discardContractDraft } from '../../app/console-actions';

export default function ContractDraftBar(props: {
  customerCode: string;
  outstandingCount: number;
  scopeChanged: boolean;
  frozen: boolean;
  pendingProposalId?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const hasChanges = props.outstandingCount > 0 || props.scopeChanged;

  return (
    <div className="toolbar" style={{ border: '1px solid var(--rule-strong)', borderRadius: 3 }}>
      {props.frozen ? (
        <>
          <span className="chip pending">Proposal pending</span>
          <span style={{ color: 'var(--ink-soft)' }}>
            This contract is with an admin. Editing is locked until they decide.
          </span>
          {props.pendingProposalId && (
            <a className="btn" href={`/approvals/contract/${props.pendingProposalId}`}>
              View proposal
            </a>
          )}
        </>
      ) : !hasChanges ? (
        <>
          <span className="chip live">Approved</span>
          <span style={{ color: 'var(--ink-soft)' }}>
            This contract matches what was approved. Any change becomes a proposal.
          </span>
        </>
      ) : (
        <>
          <span className="chip draft">Draft proposal</span>
          <span style={{ color: 'var(--ink-soft)' }}>
            {props.outstandingCount > 0 && (
              <>
                <strong>{props.outstandingCount}</strong> negotiated{' '}
                {props.outstandingCount === 1 ? 'rate' : 'rates'}
              </>
            )}
            {props.outstandingCount > 0 && props.scopeChanged && ' and '}
            {props.scopeChanged && <strong>coverage changes</strong>}
            {' '}
            not yet approved.
          </span>
        </>
      )}

      {error && <span style={{ color: 'var(--rejected)', fontSize: 11.5 }}>{error}</span>}

      {!props.frozen && hasChanges && (
        <>
          <span className="spacer" />
          <button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                if (confirm('Discard this contract draft?')) {
                  await discardContractDraft(props.customerCode);
                }
              })
            }
          >
            Discard
          </button>
          <button
            className="primary"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                try {
                  await submitContractProposal(props.customerCode);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : 'Could not submit.');
                }
              })
            }
          >
            {pending ? 'Submitting…' : 'Propose to admin'}
          </button>
        </>
      )}
    </div>
  );
}
