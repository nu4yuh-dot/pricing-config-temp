'use client';

import { useTransition } from 'react';
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

  return (
    <button
      type="button"
      className="btn"
      disabled={pending}
      onClick={() => startTransition(async () => void (await suspendOffer(offerKey, !enabled)))}
    >
      {pending ? '…' : enabled ? 'Suspend' : 'Resume'}
    </button>
  );
}
