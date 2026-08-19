'use client';

import { useActionState } from 'react';
import { changePassword } from '../app/actions';

/**
 * Change your own password. Requires the current one, so a borrowed session cannot
 * be used to take the account over.
 */
export default function PasswordForm() {
  const [state, action, pending] = useActionState(
    changePassword,
    null as { error?: string; ok?: string } | null,
  );

  return (
    <form action={action} className="stack">
      {state?.error && <div className="error">{state.error}</div>}
      {state?.ok && <div className="callout">{state.ok}</div>}

      <div className="field">
        <label htmlFor="current">Current password</label>
        <input id="current" name="current" type="password" autoComplete="current-password" required />
      </div>
      <div className="field">
        <label htmlFor="next">New password</label>
        <input
          id="next"
          name="next"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="confirm">New password again</label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </div>
      <button className="primary" type="submit" disabled={pending}>
        {pending ? 'Changing…' : 'Change password'}
      </button>
    </form>
  );
}
