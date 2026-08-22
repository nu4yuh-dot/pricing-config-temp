'use client';

import { useState, useTransition } from 'react';
import { submitContractProposal, discardContractDraft } from '../../app/console-actions';
import { useToast } from '../Toasts';

export default function ContractDraftBar(props: {
  customerCode: string;
  outstandingCount: number;
  scopeChanged: boolean;
  frozen: boolean;
  pendingProposalId?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

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
                  const outcome = await discardContractDraft(props.customerCode);
                  if ('error' in outcome) {
                    setError(outcome.error);
                    toast.failed('discard that draft', outcome.error);
                    return;
                  }
                  setError(null);
                  toast.deleted('Draft contract', 'The negotiated rates have been thrown away.');
                }
              })
            }
          >
            Discard
          </button>
          <button
            className="primary"
            disabled={pending}
            /**
             * The refusal comes back in the result, not as an exception.
             *
             * This used to be a bare `try/catch` around the call, which caught the wrong
             * thing in both directions: `submitContractProposal` goes through `attempt`, so a
             * real refusal — a contract already awaiting approval, a draft with nothing in it
             * — is **returned** as `{ error }` and was being discarded, while the only thing
             * the catch could actually see was the redirect `attempt` deliberately re-throws
             * on success. So a success was reported as an error and a failure as nothing.
             *
             * The catch is kept, narrowed, and re-throws: swallowing Next's control flow
             * would break the navigation to the new proposal.
             */
            onClick={() =>
              startTransition(async () => {
                try {
                  const outcome = await submitContractProposal(props.customerCode);
                  if (outcome && 'error' in outcome) {
                    setError(outcome.error);
                    toast.failed('submit that proposal', outcome.error);
                    return;
                  }
                  setError(null);
                } catch (cause) {
                  const digest = (cause as { digest?: string } | null)?.digest;
                  if (typeof digest === 'string' && digest.startsWith('NEXT_')) throw cause;
                  const reason = cause instanceof Error ? cause.message : 'Could not submit.';
                  setError(reason);
                  toast.failed('submit that proposal', reason);
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
