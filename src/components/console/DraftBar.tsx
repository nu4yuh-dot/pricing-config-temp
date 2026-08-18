'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { discardDraft } from '../../app/actions';

/**
 * The draft's state, always visible.
 *
 * The single biggest complaint about the spreadsheet view was not knowing where you
 * stood — what was unsaved, what was submitted, what to do next. This sits above
 * every console page and answers all three.
 */
export default function DraftBar(props: {
  cardKey: string;
  outstandingCount: number;
  frozen: boolean;
  pendingRequestId?: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="toolbar">
      {props.frozen ? (
        <>
          <span className="chip pending">Awaiting approval</span>
          <span style={{ color: 'var(--ink-soft)' }}>
            {props.outstandingCount} changed{' '}
            {props.outstandingCount === 1 ? 'value is' : 'values are'} with an admin. Editing is
            locked until they decide.
          </span>
          {props.pendingRequestId && (
            <a className="btn" href={`/approvals/${props.pendingRequestId}`}>
              View request
            </a>
          )}
        </>
      ) : props.outstandingCount === 0 ? (
        <>
          <span className="chip live">Live</span>
          <span style={{ color: 'var(--ink-soft)' }}>
            This card matches approved pricing. Any change you make becomes a draft.
          </span>
        </>
      ) : (
        <>
          <span className="chip draft">Draft</span>
          <span style={{ color: 'var(--ink-soft)' }}>
            <strong>{props.outstandingCount}</strong>{' '}
            {props.outstandingCount === 1 ? 'value differs' : 'values differ'} from live pricing.
            Nothing is quoted until approved.
          </span>
        </>
      )}

      {!props.frozen && props.outstandingCount > 0 && (
        <>
          <span style={{ marginLeft: 'auto' }} />
          <button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                if (confirm('Discard every unsubmitted change on this card?')) {
                  await discardDraft(props.cardKey);
                }
              })
            }
          >
            Discard
          </button>
          {/*
            Goes to the summary rather than submitting outright: submitting without
            having seen the full list of changes was the thing to fix.
          */}
          <button
            className="primary"
            onClick={() => router.push(`/console/${props.cardKey}/changes`)}
          >
            Review {props.outstandingCount} change{props.outstandingCount === 1 ? '' : 's'} →
          </button>
        </>
      )}
    </div>
  );
}
