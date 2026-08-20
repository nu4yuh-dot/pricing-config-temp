'use client';

import { useState, useTransition } from 'react';
import {
  BILLING_CYCLES,
  BREACH_ACTIONS,
  BREACH_LABELS,
  CANCEL_POLICIES,
  CYCLE_LABELS,
  SETTLEMENT_MODES,
  type BillingCycle,
  type BreachAction,
  type CancelPolicy,
  type SettlementMode,
} from '../../billing/settlement';

/**
 * Define an arrangement.
 *
 * The fields shown follow the mode, because prepaid and credit ask for different things:
 * a prepaid account has an allowance and an alert level, a credit account has a limit and
 * a period. Showing both at once invites somebody to fill in the half that is ignored.
 */
export default function NewSettlementProfileForm(props: {
  existingKeys: string[];
  onCreate: (input: {
    key: string;
    name: string;
    mode: SettlementMode;
    cycle: BillingCycle;
    onBreach: BreachAction;
    cancelPolicy: CancelPolicy;
    prepaid?: { negativeAllowance: number; lowBalanceAlertAt: number | null; minRecharge: number | null };
    credit?: { limit: number; periodDays: number; graceDays: number };
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<SettlementMode>('credit');
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [onBreach, setOnBreach] = useState<BreachAction>('block');
  const [cancelPolicy, setCancelPolicy] = useState<CancelPolicy>('requireApproval');
  const [allowance, setAllowance] = useState('0');
  const [alertAt, setAlertAt] = useState('');
  const [minRecharge, setMinRecharge] = useState('');
  const [limit, setLimit] = useState('0');
  const [periodDays, setPeriodDays] = useState('30');
  const [graceDays, setGraceDays] = useState('0');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const key = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const taken = key !== '' && props.existingKeys.includes(key);
  const num = (raw: string, fallback = 0) => {
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : fallback;
  };
  const orNull = (raw: string) => (raw.trim() === '' ? null : num(raw));

  const save = () => {
    setError(null);
    setDone(null);
    startTransition(async () => {
      try {
        await props.onCreate({
          key,
          name: name.trim(),
          mode,
          cycle,
          onBreach,
          cancelPolicy,
          ...(mode === 'prepaid'
            ? {
                prepaid: {
                  negativeAllowance: num(allowance),
                  lowBalanceAlertAt: orNull(alertAt),
                  minRecharge: orNull(minRecharge),
                },
              }
            : { credit: { limit: num(limit), periodDays: num(periodDays, 30), graceDays: num(graceDays) } }),
        });
        setDone(name.trim());
        setName('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save that arrangement.');
      }
    });
  };

  return (
    <div className="panel">
      <header>
        <h3>Define an arrangement</h3>
        <span className="hint">Saved as configuration — nobody is put on it until you assign it</span>
      </header>
      <div className="body">
        <div className="selector" style={{ marginBottom: 14 }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor="st-name">Name</label>
            <input
              id="st-name"
              value={name}
              placeholder="OEM 45-day credit"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="st-mode">How they pay</label>
            <select
              id="st-mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as SettlementMode)}
            >
              {SETTLEMENT_MODES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry === 'prepaid' ? 'Prepaid — money in first' : 'Credit — pays afterwards'}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="st-cycle">Bill cycle</label>
            <select
              id="st-cycle"
              value={cycle}
              onChange={(event) => setCycle(event.target.value as BillingCycle)}
            >
              {BILLING_CYCLES.map((entry) => (
                <option key={entry} value={entry}>
                  {CYCLE_LABELS[entry]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="selector" style={{ marginBottom: 14 }}>
          {mode === 'prepaid' ? (
            <>
              <div className="field">
                <label htmlFor="st-allowance">Negative allowance ₹</label>
                <input id="st-allowance" inputMode="decimal" value={allowance} onChange={(e) => setAllowance(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="st-alert">Low-balance alert at ₹</label>
                <input id="st-alert" inputMode="decimal" value={alertAt} placeholder="none" onChange={(e) => setAlertAt(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="st-min">Minimum recharge ₹</label>
                <input id="st-min" inputMode="decimal" value={minRecharge} placeholder="none" onChange={(e) => setMinRecharge(e.target.value)} />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="st-limit">Credit limit ₹</label>
                <input id="st-limit" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="st-period">Days to pay</label>
                <input id="st-period" inputMode="decimal" value={periodDays} onChange={(e) => setPeriodDays(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="st-grace">Grace days</label>
                <input id="st-grace" inputMode="decimal" value={graceDays} onChange={(e) => setGraceDays(e.target.value)} />
              </div>
            </>
          )}
        </div>

        <div className="selector">
          <div className="field" style={{ minWidth: 240 }}>
            <label htmlFor="st-breach">When there is no room left</label>
            <select
              id="st-breach"
              value={onBreach}
              onChange={(event) => setOnBreach(event.target.value as BreachAction)}
            >
              {BREACH_ACTIONS.map((entry) => (
                <option key={entry} value={entry}>
                  {BREACH_LABELS[entry]}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 240 }}>
            <label htmlFor="st-cancel">Cancelling an acted-on invoice</label>
            <select
              id="st-cancel"
              value={cancelPolicy}
              onChange={(event) => setCancelPolicy(event.target.value as CancelPolicy)}
            >
              {CANCEL_POLICIES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry === 'block'
                    ? 'Never, once acted on'
                    : entry === 'requireApproval'
                      ? 'With approval'
                      : 'Allow'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {onBreach === 'allowAndFlag' && (
          <div className="callout" style={{ marginTop: 12 }}>
            An account on these terms keeps booking past its room, and the exposure grows.
            Those accounts are listed below so somebody sees them.
          </div>
        )}
        {taken && <div className="error">An arrangement called {key} already exists.</div>}
        {error && <div className="error">{error}</div>}
        {done && <div className="callout">{done} saved. Assign it to a customer to make it real.</div>}
      </div>
      <div className="actionbar">
        <span className="spacer" />
        <button className="primary" onClick={save} disabled={pending || key === '' || taken}>
          {pending ? 'Saving…' : 'Save arrangement'}
        </button>
      </div>
    </div>
  );
}
