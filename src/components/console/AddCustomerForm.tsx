'use client';

import { useActionState } from 'react';
import { addCustomerManually } from '../../app/console-actions';

export default function AddCustomerForm({ cards }: { cards: { key: string; name: string }[] }) {
  const [state, action, pending] = useActionState(
    addCustomerManually,
    null as { error?: string; ok?: boolean } | null,
  );

  return (
    <form action={action}>
      {state?.error && <div className="error">{state.error}</div>}
      {state?.ok && (
        <div className="callout info" style={{ marginTop: 0 }}>
          Customer added on standard prices. Open their contract to negotiate anything.
        </div>
      )}
      <div className="inline-form">
        <div className="field">
          <label htmlFor="cust-code">Customer code</label>
          <input id="cust-code" name="code" placeholder="ACME" required />
        </div>
        <div className="field">
          <label htmlFor="cust-name">Name</label>
          <input id="cust-name" name="name" placeholder="Acme Auto Components" required />
        </div>
        <div className="field">
          <label htmlFor="cust-card">Base rate card</label>
          <select id="cust-card" name="baseCardKey" defaultValue={cards[0]?.key}>
            {cards.map((card) => (
              <option key={card.key} value={card.key}>
                {card.name}
              </option>
            ))}
          </select>
        </div>
        <button className="primary" type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add customer'}
        </button>
      </div>
    </form>
  );
}
