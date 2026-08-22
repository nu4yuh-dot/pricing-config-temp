'use client';

import { useActionState } from 'react';
import { addUser } from '../app/actions';
import { ROLES, ROLE_LABELS } from '../auth/roles';
import { useActionToast } from './Toasts';

export default function AddUserForm() {
  const [state, action, pending] = useActionState(
    addUser,
    null as { error?: string; ok?: boolean } | null,
  );
  useActionToast(state, { what: 'Account', verb: 'create that account' });

  return (
    <form action={action}>
      {state?.error && <div className="error">{state.error}</div>}
      {state?.ok && (
        <div className="callout info" style={{ marginTop: 0 }}>
          Account created. Ask them to sign in and change the password you set.
        </div>
      )}
      <div className="inline-form">
        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" name="name" required />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required />
        </div>
        <div className="field">
          <label htmlFor="password">Initial password</label>
          <input id="password" name="password" type="password" minLength={12} required />
        </div>
        <div className="field">
          <label htmlFor="role">Role</label>
          <select id="role" name="role" defaultValue="configurator">
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>
        <button className="primary" type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add user'}
        </button>
      </div>
    </form>
  );
}
