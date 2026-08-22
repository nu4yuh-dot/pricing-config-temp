'use client';

import { useState, useTransition } from 'react';
import { lockTodaysPrices } from '../../app/console-actions';
import { useToast } from '../Toasts';

/**
 * Lock today's prices on every other lane too.
 *
 * The mockup asked for this as an explicit checkbox after finding it happening by
 * accident, and explicit is the whole point. A sparse contract tracks the base card, so a
 * customer who never negotiated Pune→Kolkata moves when the standard rate moves. That is
 * usually right, and occasionally somebody has promised otherwise.
 *
 * So the cost is stated before it is paid: the number of rates a lock would pin is shown
 * on the button, and taking one is a line an approver sees.
 */
export default function PriceLockPanel({
  customerCode,
  lockedCount,
  lockedAt,
  lockedBy,
  lockableCount,
  canEdit,
}: {
  customerCode: string;
  /** Rates the draft currently has pinned. */
  lockedCount: number;
  lockedAt: string | null;
  lockedBy: string | null;
  /** Rates a fresh lock would pin, counted from the card as it stands today. */
  lockableCount: number;
  canEdit: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (lock: boolean) => {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const outcome = await lockTodaysPrices(customerCode, lock);
        if ('error' in outcome) {
          setError(outcome.error);
          toast.failed(lock ? 'lock those prices' : 'remove that lock', outcome.error);
          return;
        }
        const { locked } = outcome;
        toast.saved(
          lock ? 'Price lock' : 'Price lock removed',
          lock ? `${locked} rates pinned into the draft.` : 'These rates follow the base card again.',
        );
        setResult(
          lock
            ? `${locked} rates pinned at today's prices. Submit the draft to put it in front of an approver.`
            : 'Lock removed in the draft. These rates go back to following the base card once it is approved.',
        );
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : 'Could not change the lock.';
        setError(reason);
        toast.failed('change that lock', reason);
      }
    });
  };

  return (
    <div className="panel">
      <header>
        <h3>Lock today&rsquo;s prices</h3>
        <span className="hint">
          {lockedCount > 0 ? `${lockedCount} rates pinned` : 'Following the base card'}
        </span>
      </header>
      <div className="body">
        {error && <div className="error">{error}</div>}
        {result && <div className="callout info" style={{ marginTop: 0 }}>{result}</div>}

        {lockedCount > 0 ? (
          <p style={{ marginTop: 0 }}>
            {lockedCount} lane rates are pinned at what the card charged on{' '}
            <strong>{lockedAt}</strong>
            {lockedBy && <>, by {lockedBy}</>}. A base-card increase does not reach them. Anything
            this customer negotiates still wins over the lock — a frozen price is a floor under
            drift, not a ceiling on bargaining.
          </p>
        ) : (
          <p style={{ marginTop: 0 }}>
            This contract stores only what was negotiated, so every other lane follows the base
            card. Locking pins <strong>{lockableCount}</strong> rates at today&rsquo;s values and
            stops them moving — worth doing when somebody has promised a customer that nothing
            changes for a year, and worth nothing otherwise.
          </p>
        )}
      </div>

      {canEdit && (
        <div className="actionbar">
          <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
            Goes to approval as one line, not {lockableCount}.
          </span>
          <span className="spacer" />
          {lockedCount > 0 ? (
            <button type="button" onClick={() => run(false)} disabled={pending}>
              {pending ? 'Working…' : 'Remove the lock'}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => run(true)}
              disabled={pending || lockableCount === 0}
            >
              {pending ? 'Working…' : `Lock ${lockableCount} rates at today's prices`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
