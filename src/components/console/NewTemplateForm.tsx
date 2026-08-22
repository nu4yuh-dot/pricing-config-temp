'use client';

import { useActionState, useState } from 'react';
import { useActionToast } from '../Toasts';
import {
  createBlankTemplate,
  createTemplateFromCustomer,
  type ActionResult,
} from '../../app/console-actions';

/**
 * Creating a template, two ways.
 *
 * Copying a customer only works once somebody has negotiated the shape you want. A
 * standard offer — "e-commerce", "auto components" — usually has to be written before any
 * customer is on it, so it can also start empty on a chosen card and be filled in
 * afterwards using the same lane and charge editors a contract uses.
 */

type Mode = 'blank' | 'customer';

export default function NewTemplateForm({
  customers,
  cards,
}: {
  customers: { code: string; name: string; cells: number }[];
  cards: { key: string; name: string }[];
}) {
  const [mode, setMode] = useState<Mode>(customers.length === 0 ? 'blank' : 'customer');
  const [fromCustomer, customerAction, customerPending] = useActionState(
    createTemplateFromCustomer,
    null as ActionResult | null,
  );
  const [fromBlank, blankAction, blankPending] = useActionState(
    createBlankTemplate,
    null as ActionResult | null,
  );
  useActionToast(fromCustomer, { what: 'Template', verb: 'create that template' });
  useActionToast(fromBlank, { what: 'Template', verb: 'create that template' });

  const state = mode === 'customer' ? fromCustomer : fromBlank;
  const pending = mode === 'customer' ? customerPending : blankPending;

  return (
    <>
      <div className="pill-list" style={{ marginTop: 0, marginBottom: 10 }}>
        <button
          type="button"
          className={`pill${mode === 'blank' ? ' on' : ''}`}
          onClick={() => setMode('blank')}
        >
          Start from a rate card
        </button>
        <button
          type="button"
          className={`pill${mode === 'customer' ? ' on' : ''}`}
          onClick={() => setMode('customer')}
          disabled={customers.length === 0}
        >
          Copy a customer&rsquo;s contract
        </button>
      </div>

      <form action={mode === 'customer' ? customerAction : blankAction}>
        {state?.error && <div className="error">{state.error}</div>}
        {state?.ok && (
          <div className="callout info" style={{ marginTop: 0 }}>
            {mode === 'customer' ? (
              <>
                Template saved. It captures the customer&rsquo;s <strong>approved</strong> terms,
                not their draft.
              </>
            ) : (
              <>
                Template created, with nothing negotiated yet — open it below to set the rates it
                should carry. Assigned as it stands, it would change no price.
              </>
            )}
          </div>
        )}

        <div className="inline-form">
          {mode === 'customer' ? (
            <div className="field">
              <label htmlFor="t-customer">Copy from</label>
              <select id="t-customer" name="customerCode" defaultValue={customers[0]?.code}>
                {customers.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} ({c.cells} cells)
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="t-card">Written against</label>
              <select id="t-card" name="baseCardKey" defaultValue={cards[0]?.key}>
                {cards.map((card) => (
                  <option key={card.key} value={card.key}>
                    {card.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label htmlFor="t-name">Template name</label>
            <input id="t-name" name="name" placeholder="E-commerce" required />
          </div>
          <div className="field" style={{ minWidth: 260 }}>
            <label htmlFor="t-desc">What it is for</label>
            <input
              id="t-desc"
              name="description"
              placeholder="High-volume, low-weight parcels; PAN India"
            />
          </div>
          <button className="primary" type="submit" disabled={pending}>
            {pending ? 'Saving…' : mode === 'customer' ? 'Save as template' : 'Create template'}
          </button>
        </div>
      </form>

      <p className="hint" style={{ marginTop: 8 }}>
        {mode === 'customer'
          ? 'Captures what was agreed with that customer, so the next similar one can start from a shape that already works.'
          : 'A template is a rate card plus the cells that differ from it — the same shape as a contract, so the same editors apply. It starts empty and is filled in afterwards.'}
      </p>
    </>
  );
}
