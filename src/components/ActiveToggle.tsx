'use client';

import { useTransition } from 'react';
import { toggleUserActive } from '../app/actions';

/**
 * Enable or disable an account.
 *
 * Disabling rather than deleting: a person who has approved a rate change is named on
 * that change forever, and the audit trail has to keep resolving to somebody. A disabled
 * account cannot sign in and keeps its history.
 */
export default function ActiveToggle({
  userId,
  active,
  self,
}: {
  userId: string;
  active: boolean;
  /** Locking yourself out of the only admin account is not a recoverable mistake. */
  self: boolean;
}) {
  const [pending, startTransition] = useTransition();

  if (self) {
    return (
      <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }} title="You cannot disable your own account">
        —
      </span>
    );
  }

  return (
    <button
      disabled={pending}
      onClick={() => startTransition(async () => void (await toggleUserActive(userId, !active)))}
    >
      {pending ? '…' : active ? 'Disable' : 'Enable'}
    </button>
  );
}
