'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { discardDraft } from '../../app/actions';

/**
 * The draft's state, always visible.
 *
 * The single biggest complaint about the spreadsheet view was not knowing where you
 * stood — what was unsaved, what was submitted, what to do next. This sits above
 * every console page and answers all three.
 *
 * It also names the card. Card switching moved to the masthead, and without the name
 * here nothing on the page said which of the five you were editing — the pages are
 * identical, so "Lane rates" on Model 3 looks exactly like "Lane rates" on Model 1.
 */
export default function DraftBar(props: {
  cardKey: string;
  cardName: string;
  outstandingCount: number;
  frozen: boolean;
  pendingRequestId?: string;
  /**
   * Where the toggle goes: the card's first sheet tab from the console, or the card's
   * own console page from the sheet. Absent means the card has no A1 grid — the UPS
   * tariff has none — so the toggle is not offered rather than offered and broken.
   */
  toggleHref?: string;
  /** True on the sheet itself, so the toggle reads as on and switches back. */
  sheetView?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="toolbar">
      <span className="cardname">{props.cardName}</span>
      {props.toggleHref && (
        <Link
          className="viewtoggle"
          href={props.toggleHref}
          aria-pressed={props.sheetView ? 'true' : 'false'}
          title={
            props.sheetView
              ? 'Back to the console'
              : 'The workbook layout: A1 addressing and the source tabs'
          }
        >
          Sheet view <span className="state">{props.sheetView ? 'on' : 'off'}</span>
        </Link>
      )}
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
