'use client';

import { useState, useTransition } from 'react';
import { useToast } from '../Toasts';

/**
 * One irreversible-looking action on a table row: deactivate a carrier, delete a service.
 *
 * Confirmation is inline rather than a browser dialog. A `confirm()` is dismissed by
 * reflex and cannot say what is about to happen — here the second click is a different
 * button with different words, so nobody deactivates a carrier by double-clicking.
 *
 * The action either returns nothing or throws with a message worth reading. `deleteService`
 * refuses one of the four networks by name, and that sentence is the whole explanation, so
 * it is shown rather than swallowed into a generic failure.
 */
export default function RowAction({
  label,
  confirmLabel,
  run,
  danger,
  /** What the row is, for the toast: "Bluedart", "Surface Express". */
  subject,
}: {
  label: string;
  confirmLabel: string;
  /**
   * What to do, as a **server action**.
   *
   * A page rendering this is a Server Component, and a plain closure cannot cross that
   * boundary: React refuses it at render time with "Functions cannot be passed directly to
   * Client Components", which is a 500 on the page rather than a build failure. So the
   * caller passes an inline action:
   *
   *     run={async () => { 'use server'; await toggleCarrier(id, next); }}
   *
   * Typechecking cannot tell the two apart, so the only thing that catches a plain closure
   * is rendering the page with a row present.
   */
  run: () => Promise<unknown>;
  /** Styles the confirm step as destructive. Deactivating is not; deleting is. */
  danger?: boolean;
  subject?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  if (error) {
    return (
      <span className="sub" style={{ color: 'var(--rejected)' }}>
        {error}{' '}
        <button type="button" className="linklike" onClick={() => setError(null)}>
          Try again
        </button>
      </span>
    );
  }

  if (!armed) {
    return (
      <button type="button" className="linklike" onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button
        type="button"
        className={danger ? 'btn danger' : 'btn'}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            try {
              /**
               * Actions now *return* their refusal rather than throwing it, so that the
               * reason survives a production build. A caller that only catches would treat
               * a refusal as a success and show the wrong toast — so the result is checked
               * as well as the throw.
               */
              const outcome = await run();
              const returnedError =
                outcome && typeof outcome === 'object' && 'error' in outcome
                  ? String((outcome as { error: unknown }).error)
                  : null;
              if (returnedError) {
                setError(returnedError);
                toast.failed(label.toLowerCase(), returnedError);
                return;
              }
              setArmed(false);
              // The row usually vanishes or changes on success, but "usually" is not
              // confirmation — say so.
              toast.show({ kind: 'success', title: `${label} — done`,
                ...(subject ? { detail: subject } : {}) });
            } catch (cause) {
              const reason = cause instanceof Error ? cause.message : 'That did not work.';
              setError(reason);
              // Inline as well as a toast: the inline message is attached to the row it
              // belongs to, and the toast is what somebody looking elsewhere will notice.
              toast.failed(label.toLowerCase(), reason);
            }
          })
        }
      >
        {pending ? 'Working…' : confirmLabel}
      </button>
      <button type="button" className="linklike" onClick={() => setArmed(false)} disabled={pending}>
        Cancel
      </button>
    </span>
  );
}
