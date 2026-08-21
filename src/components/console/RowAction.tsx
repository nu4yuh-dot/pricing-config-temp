'use client';

import { useState, useTransition } from 'react';

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
}) {
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
              await run();
              setArmed(false);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'That did not work.');
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
