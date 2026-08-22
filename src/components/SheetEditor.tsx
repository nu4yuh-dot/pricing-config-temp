'use client';

import { useState, useTransition } from 'react';
import SheetGrid, { type GridCell } from './SheetGrid';
import { saveDraftEdits, discardDraft } from '../app/actions';
import { useToast } from './Toasts';

/**
 * Wraps the grid with the draft controls: save, discard, submit for approval.
 * Kept separate from `SheetGrid` so the grid stays a pure spreadsheet and knows
 * nothing about the workflow around it.
 */
export default function SheetEditor(props: {
  cardKey: string;
  cells: GridCell[];
  columns: number;
  rows: number;
  liveValues: Record<string, string | number | null>;
  pendingBinds: string[];
  rejectedBinds: Record<string, string>;
  flaggedBinds: Record<string, string>;
  canEdit: boolean;
  lockReason?: string;
  outstandingCount: number;
  frozen: boolean;
  canSubmit: boolean;
  pendingRequestId?: string;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  const commit = async (edits: { bind: string; value: string | number | null }[]) => {
    setError(null);
    try {
      await saveDraftEdits(props.cardKey, edits);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save those edits.');
      throw cause;
    }
  };

  const flaggedCount = Object.keys(props.flaggedBinds).length;

  return (
    <>
      <div className="toolbar" style={{ borderBottom: 0, paddingBottom: 0 }}>
        {props.frozen ? (
          <>
            <span className="chip pending">Awaiting approval</span>
            <span style={{ color: 'var(--ink-soft)' }}>
              {props.outstandingCount} changed {props.outstandingCount === 1 ? 'cell' : 'cells'} are
              with an admin. Editing is locked so the diff they review cannot change.
            </span>
            {props.pendingRequestId && (
              <a className="btn" href={`/approvals/${props.pendingRequestId}`}>
                View the request
              </a>
            )}
          </>
        ) : (
          <>
            <span className={props.outstandingCount > 0 ? 'chip draft' : 'chip live'}>
              {props.outstandingCount > 0 ? 'Draft' : 'Matches live'}
            </span>
            {props.outstandingCount > 0 && (
              <span style={{ color: 'var(--ink-soft)' }}>
                {props.outstandingCount} {props.outstandingCount === 1 ? 'cell differs' : 'cells differ'}{' '}
                from live pricing
              </span>
            )}
            {flaggedCount > 0 && (
              <span className="chip pending count" title="Validation warnings on this sheet">
                ⚠ {flaggedCount} to check
              </span>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {props.outstandingCount > 0 && props.canEdit && (
                <button
                  onClick={() =>
                    startTransition(async () => {
                      if (confirm('Discard every unsubmitted change on this card?')) {
                        const outcome = await discardDraft(props.cardKey);
                        if ('error' in outcome) toast.failed('discard that draft', outcome.error);
                        else toast.deleted('Draft', 'Every unsubmitted change on this card is gone.');
                      }
                    })
                  }
                  disabled={pending}
                >
                  Discard draft
                </button>
              )}
              {props.canSubmit && props.outstandingCount > 0 && (
                // Review first: the summary is where you see everything you are about
                // to ask someone to approve.
                <a className="btn" href={`/console/${props.cardKey}/changes`}>
                  Review {props.outstandingCount} change
                  {props.outstandingCount === 1 ? '' : 's'} →
                </a>
              )}
            </span>
          </>
        )}
      </div>

      {error && (
        <div className="error" style={{ margin: '8px 10px' }}>
          {error}
        </div>
      )}

      <SheetGrid
        cells={props.cells}
        columns={props.columns}
        rows={props.rows}
        liveValues={props.liveValues}
        pendingBinds={props.pendingBinds}
        rejectedBinds={props.rejectedBinds}
        flaggedBinds={props.flaggedBinds}
        canEdit={props.canEdit}
        {...(props.lockReason ? { lockReason: props.lockReason } : {})}
        {...(props.canEdit ? { onCommit: commit } : {})}
      />
    </>
  );
}
