'use client';

import { useActionState } from 'react';
import { signIn } from '../app/actions';

export default function LoginForm() {
  const [state, action, pending] = useActionState(signIn, null as { error?: string } | null);

  return (
    <form action={action}>
      <h1>DNS Logistics</h1>
      <p className="sub">Pricing configuration</p>

      {state?.error && <div className="error">{state.error}</div>}

      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <button className="primary" type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
