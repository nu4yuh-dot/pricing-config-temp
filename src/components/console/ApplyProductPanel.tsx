'use client';

import { useActionState, useState } from 'react';
import { applyProduct, type ApplyProductResult } from '../../app/console-actions';

/**
 * Put a product on one customer, or on everybody in its segment.
 *
 * The segment path deliberately shows a per-customer result rather than a total. "Applied
 * to 6" reads like success even when the seventh was skipped, and the skipped one is the
 * only line worth reading.
 */
export default function ApplyProductPanel({
  productKey,
  customers,
  segment,
  segmentSize,
  blocked,
}: {
  productKey: string;
  customers: { code: string; name: string }[];
  segment: string | null;
  segmentSize: number;
  /** Why it cannot be applied at all, if it cannot. */
  blocked: string | null;
}) {
  const [state, action, pending] = useActionState(applyProduct, null as ApplyProductResult | null);
  const [target, setTarget] = useState<'customer' | 'segment'>('customer');
  const [mode, setMode] = useState<'fill-gaps' | 'replace'>('fill-gaps');

  if (blocked) {
    return (
      <div className="panel">
        <header>
          <h3>Apply this product</h3>
        </header>
        <div className="body">
          <div className="error">{blocked}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <header>
        <h3>Apply this product</h3>
        <span className="hint">One draft per customer — each still goes to approval</span>
      </header>
      <form action={action}>
        <input type="hidden" name="productKey" value={productKey} />
        <input type="hidden" name="mode" value={mode} />
        <div className="body">
          {state && 'error' in state && <div className="error">{state.error}</div>}
          {state && 'ok' in state && (
            <table className="data" style={{ marginBottom: 12 }}>
              <tbody>
                {state.results.map((result) => (
                  <tr key={result.customerCode}>
                    <td className="ref">{result.customerCode}</td>
                    <td>{result.customerName}</td>
                    <td>
                      {result.skipped ? (
                        <span style={{ color: 'var(--rejected)' }}>Skipped — {result.skipped}</span>
                      ) : (
                        <>
                          {result.applied} value{result.applied === 1 ? '' : 's'} into the draft
                          {result.kept > 0 && `, kept ${result.kept} already negotiated`}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {state.results.length === 0 && (
                  <tr>
                    <td colSpan={3}>Nobody is in this segment yet, so nothing was written.</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          <div className="pill-list" style={{ marginTop: 0 }}>
            <button
              type="button"
              className={`pill${target === 'customer' ? ' on' : ''}`}
              onClick={() => setTarget('customer')}
            >
              A single customer
            </button>
            <button
              type="button"
              className={`pill${target === 'segment' ? ' on' : ''}`}
              onClick={() => setTarget('segment')}
              disabled={!segment}
            >
              {segment ? `Everyone tagged “${segment}”` : 'No segment'}
            </button>
          </div>

          {target === 'customer' ? (
            <div className="inline-form" style={{ margin: '12px 0' }}>
              <div className="field" style={{ minWidth: 280 }}>
                <label htmlFor="ap-customer">Customer</label>
                <select id="ap-customer" name="customerCode" defaultValue={customers[0]?.code}>
                  {customers.map((customer) => (
                    <option key={customer.code} value={customer.code}>
                      {customer.name} · {customer.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: '12px 0' }}>
              {/* The empty value is what tells the action this is a segment run. */}
              <input type="hidden" name="customerCode" value="" />
              This segment currently has <strong>{segmentSize}</strong> customer
              {segmentSize === 1 ? '' : 's'}. Applying creates a draft for each — nothing ships
              without its own review.
            </p>
          )}

          <div className="pill-list" style={{ marginTop: 0 }}>
            <button
              type="button"
              className={`pill${mode === 'fill-gaps' ? ' on' : ''}`}
              onClick={() => setMode('fill-gaps')}
            >
              Keep what was negotiated
            </button>
            <button
              type="button"
              className={`pill${mode === 'replace' ? ' on' : ''}`}
              onClick={() => setMode('replace')}
            >
              Overwrite with product values
            </button>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: '8px 0 0' }}>
            {mode === 'fill-gaps' ? (
              <>Anything already negotiated stays; the product fills the rest. Cannot lose work.</>
            ) : (
              <>
                <strong style={{ color: 'var(--rejected)' }}>
                  Discards everything each customer negotiated
                </strong>{' '}
                and leaves the product&rsquo;s terms alone. On a segment that is a lot of work to
                undo.
              </>
            )}
          </p>
        </div>

        <div className="actionbar">
          <span className="spacer" />
          <button className="primary" type="submit" disabled={pending}>
            {pending
              ? 'Applying…'
              : target === 'segment'
                ? `Apply to ${segmentSize} customer${segmentSize === 1 ? '' : 's'}`
                : 'Apply to customer'}
          </button>
        </div>
      </form>
    </div>
  );
}
