'use client';

import { useState, useTransition } from 'react';
import { activateSignups, declineSignup } from '../../app/console-actions';
import type { ActivationResult } from '../../data/signups';

/**
 * The signup queue.
 *
 * Each row already carries everything the person typed on the website, so the only
 * decision here is which product they start on. The suggestion is shown with the rule
 * that produced it, because a suggestion whose reasoning is hidden gets clicked through
 * rather than read.
 */

export interface QueuedSignup {
  reference: string;
  legalName: string;
  signedUpAt: string;
  channelLabel: string;
  declaredVolume: number | null;
  gstin: string | null;
  addressLine: string | null;
  suggestedProductKey: string | null;
  suggestionReason: string;
  flagged: boolean;
}

export default function SignupQueue({
  signups,
  products,
  cards,
}: {
  signups: QueuedSignup[];
  products: { key: string; name: string; segment: string | null; blocked: boolean }[];
  cards: { key: string; name: string }[];
}) {
  const [chosen, setChosen] = useState<Record<string, string>>(
    Object.fromEntries(
      signups.map((signup) => [signup.reference, signup.suggestedProductKey ?? '']),
    ),
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [baseCardKey, setBaseCardKey] = useState(cards[0]?.key ?? '');
  const [results, setResults] = useState<ActivationResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Only signups whose chosen product is the same one can go in a batch: activating them
  // is one product decision applied many times, and a batch that quietly used different
  // products per row would be several decisions wearing one button.
  const batchProduct = selected.length > 0 ? chosen[selected[0]!] : '';
  const batchable = selected.filter((reference) => chosen[reference] === batchProduct);

  const activate = (references: string[]) => {
    setError(null);
    const productKey = chosen[references[0]!] ?? '';
    if (productKey === '') {
      setError('Choose a product first. Nothing is activated onto nothing.');
      return;
    }
    startTransition(async () => {
      setResults(await activateSignups(references, productKey, baseCardKey));
      setSelected([]);
    });
  };

  const decline = (reference: string) => {
    startTransition(async () => {
      await declineSignup(reference, 'Declined from the signup queue.');
    });
  };

  if (signups.length === 0) {
    return (
      <div className="panel">
        <div className="empty">
          Nothing waiting. Signups arrive from <code>POST /api/signups</code> and stay here until
          somebody puts them on a product.
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <header>
        <h3>Waiting</h3>
        <span className="hint">{signups.length} to review</span>
      </header>
      <div className="body">
        {error && <div className="error">{error}</div>}

        {results && (
          <table className="data" style={{ marginBottom: 12 }}>
            <tbody>
              {results.map((result) => (
                <tr key={result.reference}>
                  <td className="ref">{result.reference}</td>
                  <td>
                    {result.skipped ? (
                      <span style={{ color: 'var(--rejected)' }}>Skipped — {result.skipped}</span>
                    ) : (
                      <>
                        Opened as <strong>{result.customerCode}</strong> with {result.applied}{' '}
                        values in their draft, waiting for approval.
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="inline-form" style={{ marginBottom: 12 }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor="su-card">Open accounts on</label>
            <select
              id="su-card"
              value={baseCardKey}
              onChange={(event) => setBaseCardKey(event.target.value)}
            >
              {cards.map((card) => (
                <option key={card.key} value={card.key}>
                  {card.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="scroll-x">
          <table className="data">
            <thead>
              <tr>
                <th />
                <th>Who</th>
                <th>What they said</th>
                <th>Starts on</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {signups.map((signup) => (
                <tr key={signup.reference}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${signup.legalName}`}
                      checked={selected.includes(signup.reference)}
                      onChange={() =>
                        setSelected(
                          selected.includes(signup.reference)
                            ? selected.filter((entry) => entry !== signup.reference)
                            : [...selected, signup.reference],
                        )
                      }
                    />
                  </td>
                  <td>
                    <strong>{signup.legalName}</strong>
                    <div style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                      {signup.signedUpAt}
                      {signup.gstin && ` · ${signup.gstin}`}
                    </div>
                    {signup.addressLine && (
                      <div style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                        {signup.addressLine}
                      </div>
                    )}
                  </td>
                  <td style={{ color: 'var(--ink-soft)', maxWidth: 320 }}>
                    “{signup.channelLabel}”
                    {signup.declaredVolume !== null && (
                      <div>{signup.declaredVolume.toLocaleString('en-IN')} shipments a month</div>
                    )}
                    {signup.flagged && (
                      <div className="chip rejected" style={{ marginTop: 4 }}>
                        flagged — decide this one by hand
                      </div>
                    )}
                    <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>
                      {signup.suggestionReason}
                    </div>
                  </td>
                  <td>
                    <select
                      aria-label={`Product for ${signup.legalName}`}
                      value={chosen[signup.reference] ?? ''}
                      onChange={(event) =>
                        setChosen({ ...chosen, [signup.reference]: event.target.value })
                      }
                    >
                      <option value="">Choose a product…</option>
                      {products.map((product) => (
                        <option key={product.key} value={product.key} disabled={product.blocked}>
                          {product.name}
                          {product.blocked ? ' — not ready to sell' : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={pending}
                      onClick={() => activate([signup.reference])}
                    >
                      Activate
                    </button>{' '}
                    <button type="button" className="btn" disabled={pending} onClick={() => decline(signup.reference)}>
                      Decline
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="actionbar">
        <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
          {selected.length === 0
            ? 'Every activation opens a customer and puts the product in their draft, for approval like any other contract.'
            : batchable.length < selected.length
              ? `${selected.length - batchable.length} of the selected rows are set to a different product, and would not be part of this batch.`
              : 'One product decision, applied to each.'}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          disabled={pending || batchable.length === 0}
          onClick={() => activate(batchable)}
        >
          {pending ? 'Activating…' : `Activate ${batchable.length} selected`}
        </button>
      </div>
    </div>
  );
}
