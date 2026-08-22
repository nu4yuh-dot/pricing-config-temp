'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { discardDraft } from '../../app/actions';
import { useToast } from '../Toasts';

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
  /**
   * Which engine reads this grid, e.g. `CUMULATIVE_SLABS`.
   *
   * Shown because the numbers do not mean anything on their own: 15 in a slab row is a rate
   * per kg on every kilo under `CUMULATIVE_SLABS` and a rate on the excess only under
   * `MIN_PLUS_EXCESS`. The card bar used to carry this beside each card's name, and it went
   * when card switching moved to the masthead — which left the grid editable with nothing
   * on the page saying how it would be read.
   */
  freightMethod?: string;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  return (
    <div className="toolbar">
      <span className="cardname">{props.cardName}</span>
      {props.freightMethod && (
        <span className="method" title="The pricing engine that reads this card's grids">
          {props.freightMethod}
        </span>
      )}
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
                  const outcome = await discardDraft(props.cardKey);
                  if ('error' in outcome) toast.failed('discard that draft', outcome.error);
                  else toast.deleted('Draft', 'Every unsubmitted change on this card is gone.');
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
