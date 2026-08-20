import { redirect } from 'next/navigation';
import { currentUser } from '../../../auth/session';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '../../../auth/roles';
import PasswordForm from '../../../components/PasswordForm';
import NameForm from '../../../components/NameForm';

/**
 * Your own account.
 *
 * Your name and your password are yours to change, whatever your role. Email and role are
 * an admin's: one is how you sign in, the other is what you may do.
 *
 * Renaming yourself does not touch what is already recorded. An approval that reads
 * "approved by" somebody keeps the name it was approved under, because that is what was
 * true at the time.
 */
export default async function ProfilePage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Your account</h2>

        <table className="data" style={{ marginBottom: 26 }}>
          <tbody>
            <tr>
              <td style={{ width: 160 }}>Name</td>
              <td>
                <NameForm name={user.name} />
              </td>
            </tr>
            <tr>
              <td>Email</td>
              <td className="ref">{user.email}</td>
            </tr>
            <tr>
              <td>Role</td>
              <td>
                <strong>{ROLE_LABELS[user.role]}</strong>{' '}
                <span style={{ color: 'var(--ink-soft)' }}>{ROLE_DESCRIPTIONS[user.role]}</span>
              </td>
            </tr>
          </tbody>
        </table>

        <h3>Change your password</h3>
        <p className="lede">
          At least 12 characters. You will stay signed in on this device; anywhere else you are
          signed in keeps working until that session expires.
        </p>
        <PasswordForm />
      </div>
    </div>
  );
}
