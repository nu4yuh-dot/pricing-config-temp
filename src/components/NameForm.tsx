'use client';

import { useActionState } from 'react';
import { changeName } from '../app/actions';
import { useActionToast } from './Toasts';

/**
 * Change your own display name.
 *
 * Every role can. Email and role are shown beside this and are not editable here: those
 * decide who you are and what you may do, and both belong to an admin.
 */
export default function NameForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState(
    changeName,
    null as { error?: string; ok?: string } | null,
  );
  useActionToast(state, { what: 'Name', verb: 'change your name' });

  return (
    <form action={action} className="inline-form">
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="name">Your name</label>
        <input
          id="name"
          name="name"
          defaultValue={name}
          maxLength={80}
          required
          autoComplete="name"
        />
      </div>
      <button type="submit" disabled={pending} style={{ alignSelf: 'end', marginBottom: 6 }}>
        {pending ? 'Saving…' : 'Save name'}
      </button>
      {state?.error && <div className="error">{state.error}</div>}
      {state?.ok && <div className="callout">{state.ok}</div>}
    </form>
  );
}
