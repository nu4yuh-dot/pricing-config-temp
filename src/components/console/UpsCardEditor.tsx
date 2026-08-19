'use client';

import { useMemo, useState, useTransition } from 'react';

/**
 * The card's four tables, one at a time.
 *
 * All four stacked is a very long page — the rates table alone is eighteen zones by
 * fifty-eight steps. Saving still writes every change across every tab, so each tab
 * carries its own count and an edit made on another one cannot be saved unseen.
 */
type UpsSection = 'params' | 'surge' | 'rates' | 'accessorials' | 'reference';

/** `bind` is the prefix a tab's changes share. The reference tab edits nothing. */
const SECTIONS: { key: UpsSection; label: string; bind?: string }[] = [
  { key: 'params', label: 'Parameters', bind: 'ups.params.' },
  { key: 'surge', label: 'Surge fees', bind: 'ups.surge.' },
  { key: 'rates', label: 'Rates', bind: 'ups.rates.' },
  { key: 'accessorials', label: 'Accessorial charges', bind: 'ups.accessorials.' },
  { key: 'reference', label: 'Destinations & zones' },
];
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
  reference,
}: {
  cardKey: string;
  data: UpsCardData;
  canEdit: boolean;
  /**
   * The destination-and-zone tables. They belong to this card but edit nothing, and on
   * the page they sat below the editor — which meant they appeared under every tab.
   */
  reference?: React.ReactNode;
}) {
  const [zone, setZone] = useState(data.zoneKeys[0] ?? 'Z1');
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [section, setSection] = useState<UpsSection>('params');
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

  const changedIn = (prefix?: string) =>
    prefix === undefined ? 0 : edits.filter((edit) => edit.bind.startsWith(prefix)).length;

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

  /**
   * A cell in a dense matrix, styled like the transit-times grid: the input fills the
   * cell with no border of its own, and the changed state sits on the cell rather than
   * inside the box. Twenty charges by three columns as bordered inputs is a wall.
   */
  const gridCell = (bind: string, stored: number | string | null | undefined, label: string) => (
    <td className={dirty[bind] === undefined ? '' : 'changed'}>
      <input
        aria-label={label}
        title={label}
        value={value(bind, stored)}
        disabled={!canEdit}
        inputMode="decimal"
        onChange={(event) => set(bind, event.target.value)}
      />
    </td>
  );

  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

  return (
    <>
      <div className="subtabs" role="tablist">
        {SECTIONS.map((entry) => {
          const count = changedIn(entry.bind);
          return (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={entry.key === section}
              onClick={() => setSection(entry.key)}
            >
              {entry.label}
              {count > 0 && <span className="chip draft count">{count}</span>}
            </button>
          );
        })}
      </div>

      {section === 'params' && (
      <div className="panel">
        <header>
          <h3>Parameters</h3>
          <span className="hint">One number here moves every quote on the card</span>
        </header>
        <div className="body">
          <div className="gridscroll" style={{ maxWidth: 640 }}>
          <table className="data gridedit">
            <thead>
              <tr>
                <th>Parameter</th>
                <th>Value</th>
                <th>Stored as</th>
              </tr>
            </thead>
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
                  <td>
                    <strong>{label}</strong>
                  </td>
                  {gridCell(`ups.params.${key}`, stored, label)}
                  <td className="text">{isRate ? `a decimal — ${pct(stored)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </div>
      )}

      {section === 'surge' && (
      <div className="panel">
        <header>
          <h3>Surge fees</h3>
          <span className="hint">Published ₹/kg, before the discount</span>
        </header>
        <div className="body">
          <div className="gridscroll" style={{ maxWidth: 640 }}>
          <table className="data gridedit">
            <thead>
              <tr>
                <th>World region</th>
                <th>Published ₹/kg</th>
                <th>Net after discount</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.surge).map(([region, gross]) => (
                <tr key={region}>
                  <td>
                    <strong>{region}</strong>
                  </td>
                  {gridCell(`ups.surge.${region}`, gross, `${region} — published per kg`)}
                  <td className="text">
                    {(gross * (1 - data.params.surgeDiscount)).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </div>
      )}

      {section === 'rates' && (
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
              <div className="gridscroll">
                <table className="data gridedit">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>₹ for zone {zone}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <strong>UPS Envelope</strong>
                      </td>
                      {gridCell(`ups.rates.envelope.${zone}`, data.rates.envelope[zone], `Envelope — zone ${zone}`)}
                    </tr>
                    {data.rates.document.map((row, index) => (
                      <tr key={`doc-${row.toKg}`}>
                        <td>
                          <strong>Document · {row.toKg} kg</strong>
                        </td>
                        {gridCell(`ups.rates.document.${index}.rates.${zone}`, row.rates[zone], `Document ${row.toKg} kg — zone ${zone}`)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h4 style={{ margin: '14px 0 6px' }}>Per-kilogram bands</h4>
              <div className="gridscroll">
                <table className="data gridedit">
                  <thead>
                    <tr>
                      <th>Band</th>
                      <th>₹/kg for zone {zone}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rates.bulk.map((band, index) => (
                      <tr key={band.label}>
                        <td>
                          <strong>{band.label}</strong>
                        </td>
                        {gridCell(`ups.rates.bulk.${index}.rates.${zone}`, band.rates[zone], `${band.label} — zone ${zone}`)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h4 style={{ margin: '0 0 6px' }}>Package</h4>
              <div className="gridscroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
                <table className="data gridedit">
                  <thead>
                    <tr>
                      <th>Up to</th>
                      <th>₹ for zone {zone}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rates.package.map((row, index) => (
                      <tr key={`pkg-${row.toKg}`}>
                        <td>
                          <strong>{row.toKg} kg</strong>
                        </td>
                        {gridCell(`ups.rates.package.${index}.rates.${zone}`, row.rates[zone], `Package ${row.toKg} kg — zone ${zone}`)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
      )}

      {section === 'reference' && (
      <div className="panel">
        <header>
          <h3>Destinations &amp; zones</h3>
          <span className="hint">Read-only — rebuilt from the workbook</span>
        </header>
        <div className="body">{reference}</div>
      </div>
      )}

      {section === 'accessorials' && (
      <div className="panel">
        <header>
          <h3>Accessorial charges</h3>
          <span className="hint">A waiver of 1 is fully waived</span>
        </header>
        <div className="body">
          <div className="gridscroll">
            <table className="data gridedit">
              <thead>
                <tr>
                  <th>Charge</th>
                  <th>Minimum ₹</th>
                  <th>Per kg ₹</th>
                  <th>Waiver</th>
                </tr>
              </thead>
              <tbody>
                {data.accessorials.map((charge, index) => (
                  <tr key={charge.id}>
                    <td>
                      <strong>{charge.name}</strong>{' '}
                      <span className="meta">{charge.unit}</span>
                    </td>
                    {gridCell(`ups.accessorials.${index}.minimum`, charge.minimum, `${charge.name} — minimum`)}
                    {gridCell(`ups.accessorials.${index}.perKg`, charge.perKg, `${charge.name} — per kg`)}
                    {gridCell(`ups.accessorials.${index}.waiver`, charge.waiver, `${charge.name} — waiver`)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      )}

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
