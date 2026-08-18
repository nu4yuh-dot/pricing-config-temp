'use client';

import { useState, useTransition } from 'react';
import type { StoredMode } from '../../domain/types';

type Outcome =
  | { ok: false; message: string }
  | {
      ok: true;
      steps: { trace: string; matched: boolean }[];
      winner: string | null;
      rate: number | null;
    };

/**
 * Price one real pincode pair against the draft's rules and show which rule won.
 *
 * This exists for trust. Anyone can check a real lane against the cascade before it ever
 * reaches a customer, and because it calls the same resolver the engine calls, it cannot
 * reassure somebody about a price the engine would not actually produce.
 */
export default function ShipmentTester({
  mode,
  onTest,
}: {
  mode: StoredMode;
  onTest: (mode: StoredMode, origin: number, destination: number) => Promise<Outcome>;
}) {
  const [origin, setOrigin] = useState('411001');
  const [destination, setDestination] = useState('560001');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      setOutcome(await onTest(mode, Number(origin), Number(destination)));
    });
  };

  return (
    <div className="panel">
      <div className="two-col">
        <div className="field">
          <label htmlFor="test-origin">Origin pincode</label>
          <input
            id="test-origin"
            inputMode="numeric"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="test-destination">Destination pincode</label>
          <input
            id="test-destination"
            inputMode="numeric"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          />
        </div>
      </div>

      <div className="actionbar">
        <button type="button" className="btn primary" onClick={run} disabled={pending}>
          {pending ? 'Resolving…' : 'Resolve this lane'}
        </button>
      </div>

      {outcome && !outcome.ok && <div className="callout warn">{outcome.message}</div>}

      {outcome?.ok && (
        <>
          <div className="callout">
            {outcome.winner === null ? (
              <>
                No rule matches, so <strong>the zone grid prices this lane</strong> — exactly
                as it did before rules existed.
              </>
            ) : (
              <>
                {origin} → {destination} resolves to{' '}
                <strong>
                  {outcome.rate === null ? 'not carried' : `₹${outcome.rate}/kg`}
                </strong>{' '}
                via <strong>{outcome.winner}</strong>
              </>
            )}
          </div>

          <ol className="cascade-trail">
            {outcome.steps.map((step) => (
              <li key={step.trace} className={step.matched ? 'hit' : 'miss'}>
                <span className="mark">{step.matched ? '✓' : '·'}</span>
                <span>{step.trace}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
