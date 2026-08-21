'use client';

import { useState, useTransition } from 'react';

/**
 * Put a customer on a payment arrangement, or move them to another one.
 *
 * Defining an arrangement and putting somebody on it are two separate acts, and this is the
 * second. It matters that they are separate: a profile is configuration and can be written
 * while nobody is on it, whereas assigning one changes what happens when a real customer
 * tries to book.
 *
 * Which is why the current arrangement is named in the option rather than hidden — moving a
 * customer from 45-day credit onto a prepaid wallet is not a small change, and it should not
 * be possible to do it without seeing what they were on.
 */
export default function AssignSettlementForm({
  customers,
  profiles,
  assign,
}: {
  customers: { code: string; name: string; currentProfile?: string; overrideCount?: number }[];
  profiles: { key: string; name: string; summary: string }[];
  assign: (customerCode: string, profileKey: string) => Promise<void>;
}) {
  const [customerCode, setCustomerCode] = useState(customers[0]?.code ?? '');
  const [profileKey, setProfileKey] = useState(profiles[0]?.key ?? '');
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (profiles.length === 0 || customers.length === 0) return null;

  const customer = customers.find((entry) => entry.code === customerCode);
  const profile = profiles.find((entry) => entry.key === profileKey);
  const moving = customer?.currentProfile !== undefined;

  return (
    <div className="panel">
      <header>
        <h3>Put a customer on an arrangement</h3>
        <span className="hint">Takes effect on their next booking</span>
      </header>
      <div className="body">
        <div className="inline-form">
          <div className="field" style={{ maxWidth: 300 }}>
            <label htmlFor="assign-customer">Customer</label>
            <select
              id="assign-customer"
              value={customerCode}
              onChange={(event) => {
                setCustomerCode(event.target.value);
                setDone(null);
              }}
            >
              {customers.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name}
                  {entry.currentProfile ? ` — on ${entry.currentProfile}` : ' — on nothing'}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ maxWidth: 300 }}>
            <label htmlFor="assign-profile">Arrangement</label>
            <select
              id="assign-profile"
              value={profileKey}
              onChange={(event) => {
                setProfileKey(event.target.value);
                setDone(null);
              }}
            >
              {profiles.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {profile && <p className="sub" style={{ marginTop: 0 }}>{profile.summary}</p>}

        {moving && customer?.currentProfile !== profile?.name && (
          <div className="callout warn">
            <strong>This moves them off {customer?.currentProfile}</strong>
            Their balance and overdue history are unchanged — only what happens on the next
            booking.
            {(customer?.overrideCount ?? 0) > 0 && (
              <>
                {' '}
                <strong style={{ display: 'inline' }}>
                  Their {customer?.overrideCount} negotiated override
                  {customer?.overrideCount === 1 ? '' : 's'} will be cleared.
                </strong>{' '}
                An override is a departure from the arrangement it was agreed against, so it does
                not carry to a different one. Re-agree it after the move.
              </>
            )}
          </div>
        )}

        {error && <div className="error">{error}</div>}
        {done && <div className="callout ok"><strong>{done}</strong></div>}

        <button
          type="button"
          className="btn primary"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              setDone(null);
              try {
                await assign(customerCode, profileKey);
                setDone(`${customer?.name} is now on ${profile?.name}.`);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'That did not work.');
              }
            })
          }
        >
          {pending ? 'Assigning…' : moving ? 'Move them' : 'Assign'}
        </button>
      </div>
    </div>
  );
}
