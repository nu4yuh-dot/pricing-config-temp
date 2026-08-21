'use client';

import { useState, useTransition } from 'react';
import { sendQueuedToCore } from '../../app/console-actions';

/**
 * Send the customer changes that are waiting for the SameX core.
 *
 * There is no background worker in this service, so without this button the queue has no
 * way out: approving a change enqueues it, and nothing ever dequeues it. The backlog would
 * grow while the notice beside it claimed the changes would "send on the next attempt" —
 * an attempt that nothing was making.
 *
 * Manual is the right shape for now rather than a stopgap. Until the core's endpoint
 * exists there is nothing to send to, and once it does, somebody watching the queue drain
 * for the first time is worth more than a timer doing it unobserved.
 */
export default function SendToCoreButton({ queued }: { queued: number }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    { ok: true; sent: number; failed: number } | { ok: false; message: string } | null
  >(null);

  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        className="btn"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const report = await sendQueuedToCore();
            if ('error' in report && report.error) {
              setResult({ ok: false, message: report.error });
              return;
            }
            setResult({ ok: true, sent: report.sent ?? 0, failed: report.failed ?? 0 });
          })
        }
      >
        {pending ? 'Sending…' : `Send ${queued} to the core`}
      </button>

      {result && !result.ok && (
        <p className="sub" style={{ marginTop: 6 }}>
          {result.message}
        </p>
      )}

      {result?.ok === true && (
        <p className="sub" style={{ marginTop: 6 }}>
          {result.sent === 0 && result.failed === 0 && 'Nothing was waiting.'}
          {result.sent > 0 && `Sent ${result.sent}.`}
          {result.failed > 0 &&
            ` ${result.failed} could not be sent and stayed in the queue — the rest were held back rather than retried against a core that is refusing.`}
        </p>
      )}
    </div>
  );
}
