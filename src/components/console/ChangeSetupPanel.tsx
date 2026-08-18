'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { changeCustomerSetup } from '../../app/console-actions';

/**
 * The escape hatch, open only while nothing means anything yet.
 *
 * A base card is load-bearing: every override path names a cell on *that* card, so
 * swapping it under a negotiated contract reinterprets each of them without a single
 * value changing. That is why it locks. But it locks the moment a rate is stored, not the
 * moment a customer is created — before that, a wrong card is a wrong click, and making
 * somebody delete and re-create a customer over it protects nothing.
 */
export default function ChangeSetupPanel({
  customerCode,
  baseCardKey,
  cards,
}: {
  customerCode: string;
  baseCardKey: string;
  cards: { key: string; name: string }[];
}) {
  const router = useRouter();
  const [code, setCode] = useState(customerCode);
  const [card, setCard] = useState(baseCardKey);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await changeCustomerSetup(customerCode, { code, baseCardKey: card });
        router.push(`/customers/${encodeURIComponent(result.code)}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not change the setup.');
      }
    });
  };

  return (
    <div className="panel">
      <header>
        <h3>Change setup</h3>
        <span className="hint">Open until the first rate is negotiated</span>
      </header>
      <div className="body">
        {error && <div className="error">{error}</div>}
        <p style={{ marginTop: 0 }}>
          Nothing is negotiated and nothing has been through approval, so the code and the base
          card still mean nothing. Both close the moment a rate is stored — after that, changing
          the card would change what every stored cell means.
        </p>
        <div className="inline-form">
          <div className="field" style={{ minWidth: 180 }}>
            <label htmlFor="cs-code">Customer code</label>
            <input id="cs-code" value={code} onChange={(event) => setCode(event.target.value)} />
          </div>
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor="cs-card">Priced from</label>
            <select id="cs-card" value={card} onChange={(event) => setCard(event.target.value)}>
              {cards.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="actionbar">
        <span className="spacer" />
        <button type="button" className="primary" onClick={save} disabled={pending}>
          {pending ? 'Saving…' : 'Change setup'}
        </button>
      </div>
    </div>
  );
}
