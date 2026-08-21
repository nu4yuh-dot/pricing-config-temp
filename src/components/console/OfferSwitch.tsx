'use client';

import { useTransition } from 'react';
import { useToast } from '../Toasts';
import { suspendOffer } from '../../app/console-actions';

/**
 * Suspend or resume an offer without losing its dates.
 *
 * Deleting a live campaign to stop it would take the record of what ran with it, and
 * "what were we selling at in October" is a question somebody asks in December.
 */
export default function OfferSwitch({
  offerKey,
  enabled,
}: {
  offerKey: string;
  enabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  return (
    <button
      type="button"
      className="btn"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          // The result was discarded, so a refused switch looked exactly like a successful
          // one — the row re-rendered unchanged and nothing said why.
          const outcome = await suspendOffer(offerKey, !enabled);
          if (outcome && 'error' in outcome) toast.failed('change the offer', outcome.error);
          else toast.show({ kind: 'success', title: enabled ? 'Offer suspended' : 'Offer resumed' });
        })
      }
    >
      {pending ? '…' : enabled ? 'Suspend' : 'Resume'}
    </button>
  );
}
