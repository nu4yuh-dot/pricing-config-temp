'use client';

import { useState, useTransition } from 'react';
import { quoteUpsAction } from '../../app/console-actions';
import { UPS_PRODUCTS, UPS_PRODUCT_LABELS, type UpsProduct } from '../../domain/ups';
import type { UpsQuoteResult } from '../../pricing/ups';

/**
 * Pricing an international export, ex-Mumbai.
 *
 * Shows the breakdown rather than a number, because every line of it is a question
 * somebody asks: which zone, which surge region, what the contracted rate was before the
 * margin, and what the fuel was charged on. A total on its own cannot be argued with, and
 * these are numbers people argue with.
 */
export default function UpsCalculator({
  destinations,
  accessorials,
}: {
  destinations: { code: string; name: string; needsPostal: boolean }[];
  accessorials: { id: string; name: string; waiver: number }[];
}) {
  const [country, setCountry] = useState('AE');
  const [postal, setPostal] = useState('');
  const [product, setProduct] = useState<UpsProduct>('package');
  const [weight, setWeight] = useState('10');
  const [length, setLength] = useState('');
  const [breadth, setBreadth] = useState('');
  const [height, setHeight] = useState('');
  const [applied, setApplied] = useState<string[]>([]);
  const [result, setResult] = useState<UpsQuoteResult | null>(null);
  const [pending, startTransition] = useTransition();

  const chosen = destinations.find((d) => d.code === country);
  const money = (n: number) =>
    n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const run = () => {
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) return;
    startTransition(async () => {
      setResult(
        await quoteUpsAction({
          product,
          countryCode: country,
          ...(postal.trim() ? { postalCode: postal.trim() } : {}),
          actualWeight: w,
          ...(Number(length) > 0 ? { length: Number(length) } : {}),
          ...(Number(breadth) > 0 ? { breadth: Number(breadth) } : {}),
          ...(Number(height) > 0 ? { height: Number(height) } : {}),
          accessorials: applied,
        }),
      );
    });
  };

  return (
    <>
      <div className="panel">
        <div className="inline-form">
          <div className="field" style={{ minWidth: 260 }}>
            <label htmlFor="ups-country">Destination</label>
            <select
              id="ups-country"
              value={country}
              onChange={(event) => {
                setCountry(event.target.value);
                setResult(null);
              }}
            >
              {destinations.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.name} ({d.code})
                </option>
              ))}
            </select>
          </div>
          {chosen?.needsPostal && (
            <div className="field" style={{ maxWidth: 150 }}>
              <label htmlFor="ups-postal">Postal code</label>
              <input
                id="ups-postal"
                value={postal}
                placeholder="200000"
                onChange={(event) => setPostal(event.target.value)}
              />
            </div>
          )}
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor="ups-product">Product</label>
            <select
              id="ups-product"
              value={product}
              onChange={(event) => setProduct(event.target.value as UpsProduct)}
            >
              {UPS_PRODUCTS.map((p) => (
                <option key={p} value={p}>
                  {UPS_PRODUCT_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ maxWidth: 110 }}>
            <label htmlFor="ups-weight">Weight (kg)</label>
            <input id="ups-weight" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
          </div>
        </div>

        <div className="inline-form" style={{ marginTop: 10 }}>
          <div className="field" style={{ maxWidth: 100 }}>
            <label htmlFor="ups-l">L (cm)</label>
            <input id="ups-l" inputMode="decimal" value={length} onChange={(e) => setLength(e.target.value)} />
          </div>
          <div className="field" style={{ maxWidth: 100 }}>
            <label htmlFor="ups-b">B (cm)</label>
            <input id="ups-b" inputMode="decimal" value={breadth} onChange={(e) => setBreadth(e.target.value)} />
          </div>
          <div className="field" style={{ maxWidth: 100 }}>
            <label htmlFor="ups-h">H (cm)</label>
            <input id="ups-h" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} />
          </div>
          <span style={{ color: 'var(--ink-soft)', fontSize: 11.5, alignSelf: 'end', paddingBottom: 6 }}>
            All three, or none — volumetric weight needs a box.
          </span>
        </div>

        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12 }}>
            Accessorial charges ({applied.length} applied)
          </summary>
          <div className="pill-list" style={{ marginTop: 8 }}>
            {accessorials.map((charge) => (
              <label key={charge.id} title={charge.waiver > 0 ? `${charge.waiver * 100}% waived` : undefined}>
                <input
                  type="checkbox"
                  checked={applied.includes(charge.id)}
                  onChange={() =>
                    setApplied(
                      applied.includes(charge.id)
                        ? applied.filter((id) => id !== charge.id)
                        : [...applied, charge.id],
                    )
                  }
                />{' '}
                {charge.name}
                {charge.waiver === 1 && <span className="chip live" style={{ marginLeft: 4 }}>waived</span>}
                {charge.waiver > 0 && charge.waiver < 1 && (
                  <span className="chip" style={{ marginLeft: 4 }}>{charge.waiver * 100}% off</span>
                )}
              </label>
            ))}
          </div>
        </details>

        <div className="actionbar">
          <span className="spacer" />
          <button type="button" className="primary" onClick={run} disabled={pending}>
            {pending ? 'Pricing…' : 'Price it'}
          </button>
        </div>
      </div>

      {result && !result.available && (
        <div className="panel">
          <div className="error">{result.message}</div>
        </div>
      )}

      {result?.available && (
        <div className="panel">
          <header>
            <h3>
              {result.breakdown.destination} · zone {result.breakdown.zone} ·{' '}
              {result.breakdown.chargeableWeight} kg
            </h3>
            <span className="hint">{result.breakdown.rateBasis}</span>
          </header>
          <div className="body">
            <table className="data">
              <tbody>
                <tr>
                  <td>Contracted rate</td>
                  <td className="num">{money(result.breakdown.contractRate)}</td>
                  <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>before margin</td>
                </tr>
                <tr>
                  <td>Basic freight</td>
                  <td className="num">{money(result.breakdown.freight)}</td>
                  <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>rate plus margin</td>
                </tr>
                <tr>
                  <td>Surge — {result.breakdown.surgeRegion}</td>
                  <td className="num">{money(result.breakdown.surge)}</td>
                  <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                    ₹{money(result.breakdown.surgePerKg)}/kg, net of the discount
                  </td>
                </tr>
                <tr>
                  <td>Fuel surcharge</td>
                  <td className="num">{money(result.breakdown.fuel)}</td>
                  <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                    {(result.breakdown.fuelRate * 100).toFixed(2)}% of freight + surge
                  </td>
                </tr>
                {result.breakdown.accessorials.map((charge) => (
                  <tr key={charge.id}>
                    <td>{charge.name}</td>
                    <td className="num">{money(charge.amount)}</td>
                    <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                      {charge.waiver > 0
                        ? `₹${money(charge.gross)} less ${charge.waiver * 100}% waiver`
                        : 'no waiver'}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Sub-total</strong>
                  </td>
                  <td className="num">
                    <strong>{money(result.breakdown.subTotal)}</strong>
                  </td>
                  <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                    ₹{money(result.breakdown.effectivePerKg)}/kg effective
                  </td>
                </tr>
                <tr>
                  <td>GST {(result.breakdown.gstRate * 100).toFixed(0)}%</td>
                  <td className="num">{money(result.breakdown.gst)}</td>
                  <td />
                </tr>
                <tr>
                  <td>
                    <strong>Total payable</strong>
                  </td>
                  <td className="num">
                    <strong>₹{money(result.breakdown.total)}</strong>
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>

            {result.warnings.map((warning) => (
              <p key={warning} style={{ color: 'var(--pending)', fontSize: 11.5, margin: '8px 0 0' }}>
                {warning}
              </p>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
