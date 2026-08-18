'use client';

import { useMemo, useState, useTransition } from 'react';
import { saveParamEdits } from '../../app/console-actions';
import type { UpsCardData } from '../../domain/ups';

/**
 * Editing the UPS tariff.
 *
 * Every field here writes an ordinary draft cell through the same action the other console
 * editors use, so a change lands in the draft, appears in the approval queue with a
 * readable label, and reaches production only once somebody has said yes. `ups-diff.ts` is
 * what makes that true, and its tests are what keep it true.
 *
 * Rates are edited a zone at a time. The grid is eighteen zones by fifty-eight steps —
 * over a thousand cells — and a screen showing all of them at once is a screen nobody can
 * check their own work on.
 *
 * Percentages are shown as they are stored, as decimals, with the percentage beside them.
 * Converting in the input is how a fuel surcharge becomes 4,675%.
 */

type Edit = { bind: string; value: string | number | null };

export default function UpsCardEditor({
  cardKey,
  data,
  canEdit,
}: {
  cardKey: string;
  data: UpsCardData;
  canEdit: boolean;
}) {
  const [zone, setZone] = useState(data.zoneKeys[0] ?? 'Z1');
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const value = (bind: string, stored: number | string | null | undefined) =>
    dirty[bind] ?? (stored === null || stored === undefined ? '' : String(stored));

  const set = (bind: string, next: string) => {
    setDirty({ ...dirty, [bind]: next });
    setSaved(null);
  };

  const edits: Edit[] = useMemo(
    () =>
      Object.entries(dirty).map(([bind, raw]) => {
        const text = raw.trim();
        if (text === '') return { bind, value: null };
        const numeric = Number(text);
        return { bind, value: Number.isFinite(numeric) ? numeric : text };
      }),
    [dirty],
  );

  const save = () => {
    setError(null);
    startTransition(async () => {
      try {
        await saveParamEdits(cardKey, edits);
        setSaved(edits.length);
        setDirty({});
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save those changes.');
      }
    });
  };

  const cell = (bind: string, stored: number | string | null | undefined, width = 110) => (
    <input
      value={value(bind, stored)}
      disabled={!canEdit}
      inputMode="decimal"
      style={{
        width,
        textAlign: 'right',
        fontFamily: 'var(--font-mono)',
        ...(dirty[bind] === undefined ? {} : { background: 'var(--band)', fontWeight: 600 }),
      }}
      onChange={(event) => set(bind, event.target.value)}
    />
  );

  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

  return (
    <>
      <div className="panel">
        <header>
          <h3>Parameters</h3>
          <span className="hint">One number here moves every quote on the card</span>
        </header>
        <div className="body">
          <table className="data" style={{ maxWidth: 640 }}>
            <tbody>
              {(
                [
                  ['margin', 'Margin on basic freight', data.params.margin, true],
                  ['fuelRate', 'Fuel surcharge', data.params.fuelRate, true],
                  ['surgeDiscount', 'Surge discount', data.params.surgeDiscount, true],
                  ['gstRate', 'GST', data.params.gstRate, true],
                  ['volumetricDivisor', 'Volumetric divisor', data.params.volumetricDivisor, false],
                  [
                    'minChargeableWeight',
                    'Minimum chargeable weight (kg)',
                    data.params.minChargeableWeight,
                    false,
                  ],
                ] as [string, string, number, boolean][]
              ).map(([key, label, stored, isRate]) => (
                <tr key={key}>
                  <td>{label}</td>
                  <td className="num">{cell(`ups.params.${key}`, stored)}</td>
                  <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                    {isRate ? `stored as a decimal — ${pct(stored)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <header>
          <h3>Surge fees</h3>
          <span className="hint">Published ₹/kg, before the discount</span>
        </header>
        <div className="body">
          <table className="data" style={{ maxWidth: 640 }}>
            <tbody>
              {Object.entries(data.surge).map(([region, gross]) => (
                <tr key={region}>
                  <td>{region}</td>
                  <td className="num">{cell(`ups.surge.${region}`, gross)}</td>
                  <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                    net {(gross * (1 - data.params.surgeDiscount)).toFixed(2)} after the discount
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <header>
          <h3>Rates — one zone at a time</h3>
          <span className="hint">
            {data.zoneKeys.length} zones × {1 + data.rates.document.length + data.rates.package.length + data.rates.bulk.length} steps
          </span>
        </header>
        <div className="body">
          <div className="inline-form" style={{ marginBottom: 12 }}>
            <div className="field" style={{ maxWidth: 200 }}>
              <label htmlFor="ups-zone">Zone</label>
              <select id="ups-zone" value={zone} onChange={(event) => setZone(event.target.value)}>
                {data.zoneKeys.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
            <span style={{ color: 'var(--ink-soft)', fontSize: 11.5, alignSelf: 'end', paddingBottom: 6 }}>
              Changes to other zones are kept while you switch.
            </span>
          </div>

          <div className="two-col">
            <div>
              <h4 style={{ margin: '0 0 6px' }}>Envelope &amp; Document</h4>
              <table className="data">
                <tbody>
                  <tr>
                    <td>UPS Envelope</td>
                    <td className="num">{cell(`ups.rates.envelope.${zone}`, data.rates.envelope[zone])}</td>
                  </tr>
                  {data.rates.document.map((row, index) => (
                    <tr key={`doc-${row.toKg}`}>
                      <td>Document · {row.toKg} kg</td>
                      <td className="num">
                        {cell(`ups.rates.document.${index}.rates.${zone}`, row.rates[zone])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h4 style={{ margin: '14px 0 6px' }}>Per-kilogram bands</h4>
              <table className="data">
                <tbody>
                  {data.rates.bulk.map((band, index) => (
                    <tr key={band.label}>
                      <td>{band.label}</td>
                      <td className="num">
                        {cell(`ups.rates.bulk.${index}.rates.${zone}`, band.rates[zone])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h4 style={{ margin: '0 0 6px' }}>Package</h4>
              <div style={{ maxHeight: 460, overflowY: 'auto' }}>
                <table className="data">
                  <tbody>
                    {data.rates.package.map((row, index) => (
                      <tr key={`pkg-${row.toKg}`}>
                        <td>{row.toKg} kg</td>
                        <td className="num">
                          {cell(`ups.rates.package.${index}.rates.${zone}`, row.rates[zone])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <header>
          <h3>Accessorial charges</h3>
          <span className="hint">A waiver of 1 is fully waived</span>
        </header>
        <div className="body">
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Charge</th>
                  <th className="num">Minimum</th>
                  <th className="num">Per kg</th>
                  <th className="num">Waiver</th>
                </tr>
              </thead>
              <tbody>
                {data.accessorials.map((charge, index) => (
                  <tr key={charge.id}>
                    <td>
                      {charge.name}
                      <div style={{ color: 'var(--ink-faint)', fontSize: 11 }}>{charge.unit}</div>
                    </td>
                    <td className="num">{cell(`ups.accessorials.${index}.minimum`, charge.minimum, 100)}</td>
                    <td className="num">{cell(`ups.accessorials.${index}.perKg`, charge.perKg, 80)}</td>
                    <td className="num">{cell(`ups.accessorials.${index}.waiver`, charge.waiver, 80)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel">
        {error && <div className="error">{error}</div>}
        {saved !== null && (
          <div className="callout info" style={{ marginTop: 0 }}>
            {saved} value{saved === 1 ? '' : 's'} written to the draft. They appear in{' '}
            <strong>Pending changes</strong> and reach production only once an admin approves them.
          </div>
        )}
        <div className="actionbar">
          <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
            {edits.length === 0
              ? 'Nothing changed yet.'
              : `${edits.length} value${edits.length === 1 ? '' : 's'} changed, not yet saved.`}
          </span>
          <span className="spacer" />
          {edits.length > 0 && (
            <button type="button" onClick={() => { setDirty({}); setSaved(null); }} disabled={pending}>
              Discard
            </button>
          )}
          <button
            type="button"
            className="primary"
            onClick={save}
            disabled={!canEdit || pending || edits.length === 0}
          >
            {pending ? 'Saving…' : 'Save to draft'}
          </button>
        </div>
      </div>
    </>
  );
}
