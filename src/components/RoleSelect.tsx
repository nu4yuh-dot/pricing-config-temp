'use client';

import { useState, useTransition } from 'react';
import { changeUserRole } from '../app/actions';
import { useToast } from './Toasts';
import { ROLES, ROLE_LABELS, type Role } from '../auth/roles';

/**
 * Change somebody's role.
 *
 * The select is **controlled** rather than left on `defaultValue`, because a refused change
 * has to be undone on screen. Uncontrolled, the browser kept showing whichever role was
 * picked while the account still held the old one — and the action's result was discarded
 * with `void`, so nothing said otherwise. The person who chose it had every reason to
 * believe it had worked.
 */
export default function RoleSelect({ userId, role }: { userId: string; role: Role }) {
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState<Role>(role);
  const toast = useToast();

  return (
    <select
      value={current}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value as Role;
        const previous = current;
        setCurrent(next);

        startTransition(async () => {
          const outcome = await changeUserRole(userId, next);
          if ('error' in outcome) {
            // Put the control back where it was: the account still holds the old role.
            setCurrent(previous);
            toast.failed('change that role', outcome.error);
            return;
          }
          toast.saved('Role', `Now ${ROLE_LABELS[next]}.`);
        });
      }}
    >
      {ROLES.map((entry) => (
        <option key={entry} value={entry}>
          {ROLE_LABELS[entry]}
        </option>
      ))}
    </select>
  );
}
