'use client';

import { useActionState, useEffect } from 'react';
import { useToast } from '../Toasts';
import { reasonFrom } from '../../app/action-result';

/**
 * A form whose refusal is visible.
 *
 * `<form action={someAction}>` gives React nowhere to put a result — the signature is
 * `(formData) => void` — so an action bound that way can only report failure by throwing,
 * and a production build replaces the thrown message with boilerplate. The reason ends up in
 * a server log, which is no use at all to the approver looking at the screen.
 *
 * `useActionState` opens that channel. The action returns its refusal, this renders it inline
 * and raises a toast, and a success is left to the redirect or revalidation the action
 * already performs.
 *
 * Used where the decision matters and the refusal is specific — "this proposal has already
 * been decided", "the draft is empty" — which is exactly where boilerplate is worst.
 */
export default function ActionForm({
  action,
  children,
  what,
}: {
  /** A server action returning `{ ok: true }` or `{ error }`. */
  action: (previous: unknown, form: FormData) => Promise<unknown>;
  children: React.ReactNode;
  /** What is being attempted, for the toast: "record that decision". */
  what: string;
}) {
  const [state, submit] = useActionState(action, null);
  const toast = useToast();

  useEffect(() => {
    if (state && typeof state === 'object' && 'error' in state) {
      toast.failed(what, (state as { error: unknown }).error);
    }
  }, [state, what, toast]);

  const error = state && typeof state === 'object' && 'error' in state ? reasonFrom(state) : null;

  return (
    <form action={submit}>
      {/* Inline as well as a toast: the toast is what somebody looking away will notice,
          the inline message is what they read when they come back to the form. */}
      {error && <div className="callout bad">{error}</div>}
      {children}
    </form>
  );
}
