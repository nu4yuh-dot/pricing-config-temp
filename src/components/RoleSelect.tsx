'use client';

import { useTransition } from 'react';
import { changeUserRole } from '../app/actions';
import { ROLES, ROLE_LABELS, type Role } from '../auth/roles';

export default function RoleSelect({ userId, role }: { userId: string; role: Role }) {
  const [pending, startTransition] = useTransition();

  return (
    <select
      defaultValue={role}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value as Role;
        startTransition(() => {
          void changeUserRole(userId, next);
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
