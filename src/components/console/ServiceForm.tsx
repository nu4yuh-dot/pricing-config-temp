'use client';

import { useActionState, useEffect } from 'react';
import { useToast } from '../Toasts';
import { STORED_MODES } from '../../domain/types';
import type { ActionResult } from '../../app/console-actions';

/**
 * Adding or editing a service.
 *
 * The multiplier is the field to be careful with, so the hint says what it multiplies and
 * what it does not. The network list is the three the engine holds rates for — offering a
 * fourth would let somebody define a service that prices from a grid which does not exist.
 */
export default function ServiceForm({
  action,
}: {
  action: (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [state, submit, pending] = useActionState(action, null);
  const toast = useToast();

  /**
   * Report whatever the action returned.
   *
   * Driven off the result rather than the click, so a failure the server decided — a
   * duplicate key, a refused value — is announced with the reason it gave rather than a
   * guess made on the client.
   */
  useEffect(() => {
    if (!state) return;
    if ('error' in state && state.error) toast.failed('save the service', state.error);
    else if ('ok' in state && state.ok) toast.saved('Service');
  }, [state, toast]);

  return (
    <form action={submit} className="panel">
      <div className="body">
        <div className="inline-form">
          <div className="field" style={{ minWidth: 170 }}>
            <label htmlFor="s-key">Key</label>
            <input id="s-key" name="key" placeholder="surface-express" required />
            <span className="hint">Lower-case. Appears in APIs and on invoices.</span>
          </div>
          <div className="field" style={{ minWidth: 200 }}>
            <label htmlFor="s-name">Name</label>
            <input id="s-name" name="name" placeholder="Surface Express" required />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="s-mode">Rides which network</label>
            <select id="s-mode" name="mode" defaultValue="surface">
              {STORED_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="inline-form">
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="s-mult">Freight multiplier</label>
            <input
              id="s-mult"
              name="multiplier"
              type="number"
              min="0.01"
              step="0.01"
              defaultValue="1"
              required
            />
            <span className="hint">1 is the network&rsquo;s own rate. NFO is air at 2.</span>
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="s-transit">Transit adjustment</label>
            <input id="s-transit" name="transitAdjustmentDays" type="number" step="1" placeholder="-1" />
            <span className="hint">Days. Negative arrives sooner. Never below one day.</span>
          </div>
          <div className="field" style={{ minWidth: 130 }}>
            <label htmlFor="s-sac">SAC code</label>
            <input id="s-sac" name="sacCode" placeholder="9965" />
          </div>
          <div className="field" style={{ minWidth: 130 }}>
            <label htmlFor="s-gst">GST rate</label>
            <input id="s-gst" name="gstRate" type="number" min="0" max="1" step="0.01" placeholder="0.05" />
            <span className="hint">A fraction — 0.05 is 5%.</span>
          </div>
        </div>

        <div className="inline-form">
          <div className="field" style={{ minWidth: 340 }}>
            <label htmlFor="s-desc">Description</label>
            <input id="s-desc" name="description" placeholder="Road, expedited." />
          </div>
          <label className="check">
            <input type="checkbox" name="active" defaultChecked /> On sale
          </label>
        </div>

        {state?.error && <div className="callout warn">{state.error}</div>}
        {state?.ok && <div className="callout info">Saved.</div>}
      </div>

      <div className="actionbar">
        <span className="spacer" />
        <button className="primary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save service'}
        </button>
      </div>
    </form>
  );
}
