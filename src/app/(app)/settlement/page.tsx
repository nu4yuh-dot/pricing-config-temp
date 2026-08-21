import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import { listProfiles } from '../../../data/settlement';
import { listCustomers } from '../../../data/customers';
import {
  resolveSettlement,
  BREACH_LABELS,
  CYCLE_LABELS,
} from '../../../billing/settlement';
import NewSettlementProfileForm from '../../../components/console/NewSettlementProfileForm';
import AssignSettlementForm from '../../../components/console/AssignSettlementForm';
import { createSettlementProfile, assignSettlementProfile } from '../../console-actions';

/**
 * Payment terms.
 *
 * An arrangement is configuration — prepaid or credit, which cycle, how much rope, and what
 * to do when the rope runs out — and assigning it to a customer is what makes it real. The
 * same arrangement serves fifty accounts on the same terms; a customer who negotiated
 * something different overrides that one field and follows the arrangement everywhere else.
 */
export default async function SettlementPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  // Terms decide what a customer may run up, which is the same authority as moving money.
  if (!can(user.role, 'record-money')) redirect('/console/model-1/rates');

  const [profiles, customers] = await Promise.all([listProfiles(), listCustomers()]);
  const onProfile = (key: string) => customers.filter((c) => c.settlement?.profileKey === key);
  const unassigned = customers.filter((c) => !c.settlement?.profileKey);

  // Accounts allowed to book past their room. The cost of making the breach action
  // configurable is that this list has to exist and has to be looked at.
  const permissive = profiles.filter((p) => p.onBreach === 'allowAndFlag');

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Payment terms</h2>
        <p className="lede">
          How a customer pays, how often they are billed, and what happens when they run out of
          room. Defining an arrangement and putting somebody on it are two separate acts.
        </p>

        <h3>Arrangements ({profiles.length})</h3>
        {profiles.length === 0 ? (
          <p className="empty">
            None yet. Define one below — nothing changes for any customer until you assign it.
          </p>
        ) : (
          <div className="gridscroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Arrangement</th>
                  <th>Pays</th>
                  <th>Cycle</th>
                  <th>Room</th>
                  <th>No room left</th>
                  <th className="num">Customers</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => {
                  const terms = resolveSettlement(profile);
                  const users = onProfile(profile.key);
                  return (
                    <tr key={profile.key}>
                      <td>
                        <strong>{profile.name}</strong>{' '}
                        <span className="meta">{profile.key}</span>
                      </td>
                      <td>{terms.mode === 'prepaid' ? 'In advance' : 'Afterwards'}</td>
                      <td>{CYCLE_LABELS[terms.cycle]}</td>
                      <td>
                        {terms.mode === 'prepaid'
                          ? terms.prepaid.negativeAllowance > 0
                            ? `balance + ₹${terms.prepaid.negativeAllowance.toLocaleString('en-IN')}`
                            : 'balance only'
                          : `₹${terms.credit.limit.toLocaleString('en-IN')} · ${terms.credit.periodDays} days`}
                      </td>
                      <td>
                        {profile.onBreach === 'allowAndFlag' ? (
                          <span className="chip pending">{BREACH_LABELS[profile.onBreach]}</span>
                        ) : (
                          <span className="meta">{BREACH_LABELS[profile.onBreach]}</span>
                        )}
                      </td>
                      <td className="num">
                        {users.length === 0 ? <span className="meta">none</span> : users.length}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {permissive.length > 0 && (
          <div className="panel" style={{ marginTop: 18 }}>
            <header>
              <h3>Allowed to book past their room</h3>
              <span className="hint">Exposure grows on these accounts with nothing stopping it</span>
            </header>
            <div className="body">
              {permissive.flatMap((profile) => onProfile(profile.key)).length === 0 ? (
                <p className="empty" style={{ marginBottom: 0 }}>
                  No customer is on one of these arrangements yet.
                </p>
              ) : (
                <table className="data">
                  <tbody>
                    {permissive.flatMap((profile) =>
                      onProfile(profile.key).map((customer) => (
                        <tr key={`${profile.key}-${customer.code}`}>
                          <td>
                            <Link href={`/customers/${encodeURIComponent(customer.code)}`}>
                              {customer.name}
                            </Link>
                          </td>
                          <td className="meta">allowed by {profile.name}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {unassigned.length > 0 && (
          <div className="callout" style={{ marginTop: 18 }}>
            <strong>
              {unassigned.length} customer{unassigned.length === 1 ? '' : 's'} on no arrangement
            </strong>
            {unassigned.map((c) => c.name).join(', ')}. A customer on no arrangement is not the
            same as one on permissive terms — nothing here decides for them, so whatever checks
            their bookings today still does.
          </div>
        )}

        {profiles.length > 0 && customers.length > 0 && (
          <>
            <h3 style={{ marginTop: 26 }}>Assign one</h3>
            <AssignSettlementForm
              customers={customers.map((customer) => {
                const current = profiles.find((p) => p.key === customer.settlement?.profileKey);
                return {
                  code: customer.code,
                  name: customer.name,
                  ...(current === undefined ? {} : { currentProfile: current.name }),
                  overrideCount: Object.keys(customer.settlement?.overrides ?? {}).length,
                };
              })}
              profiles={profiles.map((profile) => {
                const terms = resolveSettlement(profile);
                return {
                  key: profile.key,
                  name: profile.name,
                  summary:
                    `${terms.mode === 'prepaid' ? 'Prepaid' : 'Credit'} · ${CYCLE_LABELS[terms.cycle]}` +
                    ` · on breach: ${BREACH_LABELS[terms.onBreach]}` +
                    (terms.mode === 'credit'
                      ? ` · limit ₹${terms.credit.limit.toLocaleString('en-IN')}, ${terms.credit.periodDays} days`
                      : ''),
                };
              })}
              assign={async (customerCode, profileKey) => {
                'use server';
                // Passed back rather than discarded: the action returns its refusal now, and
                // a swallowed refusal shows as a success.
                return assignSettlementProfile(customerCode, profileKey);
              }}
            />
          </>
        )}

        <h3 style={{ marginTop: 26 }}>Define a new one</h3>
        <NewSettlementProfileForm
          existingKeys={profiles.map((profile) => profile.key)}
          onCreate={async (input) => {
            'use server';
            await createSettlementProfile(input);
          }}
        />
      </div>
    </div>
  );
}
