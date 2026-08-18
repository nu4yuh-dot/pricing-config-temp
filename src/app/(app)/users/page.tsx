import { redirect } from 'next/navigation';
import { currentUser, listUsers } from '../../../auth/session';
import { can, ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS } from '../../../auth/roles';
import AddUserForm from '../../../components/AddUserForm';
import RoleSelect from '../../../components/RoleSelect';

export default async function UsersPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!can(user.role, 'manage-users')) redirect('/sheets/model-1/surface');

  const users = await listUsers();

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Users</h2>
        <p className="lede">
          Three roles. An admin can edit as well as approve, but nobody — admin included — can
          approve their own change request, so the review always means a second pair of eyes.
        </p>

        <h3>Roles</h3>
        <table className="data">
          <tbody>
            {ROLES.map((role) => (
              <tr key={role}>
                <td style={{ width: 140 }}>
                  <strong>{ROLE_LABELS[role]}</strong>
                </td>
                <td style={{ color: 'var(--ink-soft)' }}>{ROLE_DESCRIPTIONS[role]}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>People ({users.length})</h3>
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {users.map((entry) => (
              <tr key={entry._id.toHexString()}>
                <td>
                  <strong>{entry.name}</strong>
                </td>
                <td className="ref">{entry.email}</td>
                <td>
                  <RoleSelect userId={entry._id.toHexString()} role={entry.role} />
                </td>
                <td>
                  {entry.active ? (
                    <span className="chip live">active</span>
                  ) : (
                    <span className="chip rejected">disabled</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Add someone</h3>
        <AddUserForm />
      </div>
    </div>
  );
}
