'use client';

import { useState, useTransition } from 'react';
import { submitDraftForApproval, discardDraft } from '../../app/actions';
import { useToast } from '../Toasts';

/**
 * The confirm step at the end of the change summary.
 *
 * Deliberately asks for an explicit tick when there are warnings: the point of the
 * summary is that nobody submits a thousand changed cells without having looked.
 */
export default function SubmitBar(props: {
  cardKey: string;
  count: number;
  warningCount: number;
  frozen: boolean;
  canSubmit: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsAcknowledgement = props.warningCount > 0;
  const blocked = needsAcknowledgement && !acknowledged;

  if (props.frozen) {
    return (
      <div className="panel">
        <div className="body">
          <span className="chip pending">Awaiting approval</span>{' '}
          <span style={{ color: 'var(--ink-soft)' }}>
            These {props.count} changes are already with an admin. Editing is locked until they
            decide.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <header>
        <h3>Submit for approval</h3>
        <span className="hint">Nothing is priced from these values until an admin approves</span>
      </header>
      <div className="body">
        {needsAcknowledgement && (
          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              marginBottom: 12,
              fontSize: 12.5,
            }}
          >
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              I have read the {props.warningCount} warning
              {props.warningCount === 1 ? '' : 's'} above and want to submit anyway.
            </span>
          </label>
        )}

        {error && <div className="error">{error}</div>}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {props.canSubmit && (
            <button
              className="primary"
              disabled={blocked || pending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    await submitDraftForApproval(props.cardKey);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : 'Could not submit.');
                  }
                })
              }
            >
              {pending ? 'Submitting…' : `Submit ${props.count} for approval`}
            </button>
          )}
          <button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                if (
                  confirm(
                    `Discard all ${props.count} unsubmitted changes on this card? This cannot be undone.`,
                  )
                ) {
                  const outcome = await discardDraft(props.cardKey);
                  if ('error' in outcome) toast.failed('discard that draft', outcome.error);
                  else toast.deleted('Draft', `All ${props.count} unsubmitted changes are gone.`);
                }
              })
            }
          >
            Discard everything
          </button>
          {blocked && (
            <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
              Tick the box above to enable submitting.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
