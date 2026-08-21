'use client';

import { useActionState } from 'react';
import { RATE_STRUCTURES, RATE_STRUCTURE_LABELS } from '../../domain/carriers';
import type { ActionResult } from '../../app/console-actions';

/**
 * Adding or editing a carrier.
 *
 * "How they price" is the only field with consequences beyond this screen, so it says what
 * each option means rather than making somebody guess from a code. Choosing wrongly does
 * not corrupt anything — it decides which engine is asked, and the wrong one simply
 * cannot answer.
 */
export default function CarrierForm({
  action,
}: {
  action: (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [state, submit, pending] = useActionState(action, null);

  return (
    <form action={submit} className="panel">
      <div className="body">
        <div className="inline-form">
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="c-id">Carrier code</label>
            <input id="c-id" name="carrierId" placeholder="velocity" required />
            <span className="hint">Lower-case. Matches the code the core gates access by.</span>
          </div>
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor="c-name">Name</label>
            <input id="c-name" name="name" placeholder="Velocity" required />
          </div>
          <div className="field" style={{ minWidth: 300 }}>
            <label htmlFor="c-structure">How they price</label>
            <select id="c-structure" name="rateStructure" defaultValue="zoneWeight">
              {RATE_STRUCTURES.map((structure) => (
                <option key={structure} value={structure}>
                  {RATE_STRUCTURE_LABELS[structure]}
                </option>
              ))}
            </select>
            <span className="hint">
              Zone × weight needs no code — just a rate card. The others name an engine that
              already exists.
            </span>
          </div>
        </div>

        <div className="inline-form">
          <div className="field" style={{ minWidth: 200 }}>
            <label htmlFor="c-email">Contact email</label>
            <input id="c-email" name="contactEmail" type="email" />
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="c-phone">Contact phone</label>
            <input id="c-phone" name="contactPhone" />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="c-cutoff">Cut-off</label>
            <input id="c-cutoff" name="cutoffTime" placeholder="17:30 IST" />
          </div>
          <div className="field" style={{ minWidth: 130 }}>
            <label htmlFor="c-max">Max weight (kg)</label>
            <input id="c-max" name="maxWeightKg" type="number" min="0" step="1" />
          </div>
        </div>

        <div className="inline-form">
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="c-mult">Rate multiplier</label>
            <input id="c-mult" name="rateMultiplier" type="number" min="0" step="0.01" placeholder="1.00" />
            <span className="hint">Freight only. Never applied to tax.</span>
          </div>
          <div className="field" style={{ minWidth: 280 }}>
            <label htmlFor="c-track">Tracking URL</label>
            <input id="c-track" name="trackingUrlTemplate" placeholder="https://…/track?awb={awb}" />
          </div>
          <div className="field" style={{ minWidth: 240 }}>
            <label htmlFor="c-notes">Notes</label>
            <input id="c-notes" name="notes" />
          </div>
        </div>

        <div className="inline-form">
          <label className="check">
            <input type="checkbox" name="active" defaultChecked /> Active
          </label>
          <label className="check">
            <input type="checkbox" name="dgCertified" /> Carries dangerous goods
          </label>
        </div>

        {state?.error && <div className="callout warn">{state.error}</div>}
        {state?.ok && <div className="callout info">Saved.</div>}
      </div>

      <div className="actionbar">
        <span className="spacer" />
        <button className="primary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save carrier'}
        </button>
      </div>
    </form>
  );
}
