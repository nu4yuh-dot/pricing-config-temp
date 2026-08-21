'use client';

import { useState, useTransition } from 'react';
import { useToast } from '../Toasts';
import { scheduleOffer } from '../../app/console-actions';

/**
 * Scheduling an offer.
 *
 * The preview is the point of the form. An offer is the only thing in this system that
 * changes a price without changing a stored value, so the one question worth answering
 * before saving is "what does a shipment cost during it, and what does it cost after" —
 * with the contract rate shown unchanged beside both.
 */
export default function NewOfferForm({
  products,
  segments,
  customers,
  charges,
}: {
  products: { key: string; name: string }[];
  segments: string[];
  customers: { code: string; name: string }[];
  charges: { id: string; name: string }[];
}) {
  const [name, setName] = useState('');
  const toast = useToast();
  const [kind, setKind] = useState<'percent-off-freight' | 'amount-off-freight' | 'waive-charge'>(
    'percent-off-freight',
  );
  const [value, setValue] = useState('10');
  const [chargeId, setChargeId] = useState(charges[0]?.id ?? '');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [audienceKind, setAudienceKind] = useState<'product' | 'segment' | 'customer'>('product');
  const [audienceValue, setAudienceValue] = useState(products[0]?.key ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const audienceOptions =
    audienceKind === 'product'
      ? products.map((product) => ({ value: product.key, label: product.name }))
      : audienceKind === 'segment'
        ? segments.map((segment) => ({ value: segment, label: segment }))
        : customers.map((customer) => ({ value: customer.code, label: customer.name }));

  const numeric = Number(value);
  const sample = 600;
  const during =
    kind === 'percent-off-freight'
      ? Math.max(0, sample - Math.round(sample * (numeric / 100)))
      : kind === 'amount-off-freight'
        ? Math.max(0, sample - (Number.isFinite(numeric) ? numeric : 0))
        : sample;

  const ready =
    name.trim() !== '' &&
    startsAt !== '' &&
    endsAt !== '' &&
    audienceValue !== '' &&
    (kind === 'waive-charge' || (Number.isFinite(numeric) && numeric > 0));

  const save = () => {
    setError(null);
    startTransition(async () => {
      try {
        const outcome = await scheduleOffer({
          name,
          kind,
          value: kind === 'waive-charge' ? 0 : numeric,
          ...(kind === 'waive-charge' ? { chargeId } : {}),
          startsAt,
          endsAt,
          audience: { kind: audienceKind, value: audienceValue },
        });
        if ('error' in outcome) {
          setError(outcome.error);
          toast.failed('schedule the offer', outcome.error);
          return;
        }
        // Named, and with the dates, because "saved" alone does not tell somebody whether
        // the offer is live now or starts next week — which is the thing they came to do.
        toast.saved(`Offer “${name}”`, `${kind === 'waive-charge' ? 'Waiver' : `${numeric}${kind === 'percent-off-freight' ? '%' : ' rupees'} off freight`} · ${startsAt} to ${endsAt} · ${audienceKind} ${audienceValue}`);
        setName('');
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : 'Could not schedule the offer.';
        setError(reason);
        toast.failed('schedule the offer', reason);
      }
    });
  };

  return (
    <div className="panel">
      <header>
        <h3>New offer</h3>
        <span className="hint">Never touches a stored rate</span>
      </header>
      <div className="body">
        {error && <div className="error">{error}</div>}

        <div className="inline-form">
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor="of-name">Name</label>
            <input
              id="of-name"
              value={name}
              placeholder="Diwali Dispatch Offer"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field" style={{ minWidth: 200 }}>
            <label htmlFor="of-kind">Discount</label>
            <select
              id="of-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              <option value="percent-off-freight">% off freight</option>
              <option value="amount-off-freight">Flat ₹ off freight</option>
              <option value="waive-charge">Waive a charge</option>
            </select>
          </div>
          {kind === 'waive-charge' ? (
            <div className="field" style={{ minWidth: 200 }}>
              <label htmlFor="of-charge">Charge waived</label>
              <select
                id="of-charge"
                value={chargeId}
                onChange={(event) => setChargeId(event.target.value)}
              >
                {charges.map((charge) => (
                  <option key={charge.id} value={charge.id}>
                    {charge.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="field" style={{ maxWidth: 120 }}>
              <label htmlFor="of-value">
                {kind === 'percent-off-freight' ? 'Percent' : 'Rupees'}
              </label>
              <input
                id="of-value"
                inputMode="decimal"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </div>
          )}
        </div>

        <div className="inline-form" style={{ marginTop: 10 }}>
          <div className="field" style={{ maxWidth: 170 }}>
            <label htmlFor="of-from">Starts</label>
            <input
              id="of-from"
              type="date"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </div>
          <div className="field" style={{ maxWidth: 170 }}>
            <label htmlFor="of-to">Ends (inclusive)</label>
            <input
              id="of-to"
              type="date"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="of-audience">Applies to</label>
            <select
              id="of-audience"
              value={audienceKind}
              onChange={(event) => {
                const next = event.target.value as typeof audienceKind;
                setAudienceKind(next);
                setAudienceValue('');
              }}
            >
              <option value="product">Everyone on a product</option>
              <option value="segment">A segment</option>
              <option value="customer">One customer</option>
            </select>
          </div>
          <div className="field" style={{ minWidth: 230 }}>
            <label htmlFor="of-target">Which</label>
            <select
              id="of-target"
              value={audienceValue}
              onChange={(event) => setAudienceValue(event.target.value)}
            >
              <option value="">Choose…</option>
              {audienceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <table className="data" style={{ marginTop: 14, maxWidth: 560 }}>
          <thead>
            <tr>
              <th>On a ₹{sample} freight</th>
              <th style={{ textAlign: 'right' }}>Before</th>
              <th style={{ textAlign: 'right' }}>During</th>
              <th style={{ textAlign: 'right' }}>After</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Freight charged</td>
              <td className="num">₹{sample}</td>
              <td className="num">₹{during}</td>
              <td className="num">₹{sample}</td>
            </tr>
            <tr>
              <td>Contract rate on file</td>
              <td className="num" colSpan={3} style={{ color: 'var(--ink-soft)' }}>
                Unchanged throughout — never edited, so nothing has to be edited back
              </td>
            </tr>
          </tbody>
        </table>
        <p style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>
          Fuel and GST follow the discounted freight, because fuel is a percentage of it —
          charging fuel on money the customer did not spend would be a second, quieter discount
          in the wrong direction.
        </p>
      </div>

      <div className="actionbar">
        <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
          Two overlapping freight offers do not stack; the larger one wins and the other is
          shown as considered.
        </span>
        <span className="spacer" />
        <button type="button" className="primary" disabled={!ready || pending} onClick={save}>
          {pending ? 'Scheduling…' : 'Schedule offer'}
        </button>
      </div>
    </div>
  );
}
