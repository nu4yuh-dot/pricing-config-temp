'use client';

import { useMemo, useState, useTransition } from 'react';
import { SURFACE_ZONES } from '../../domain/zones';

/**
 * Guided FTL rate editing.
 *
 * FTL has no tiers to fill in — one lane, one vehicle, one price for the trip — so this is
 * simpler than the partload lane editor: pick the truck and the two ends, type the trip
 * price. Beside it sits every lane already rated for that vehicle, because the useful
 * question when pricing a truck is "what do we charge on the lanes we already run".
 */

export interface Vehicle {
  code: string;
  label: string;
  capacityKg: number;
}

export interface FtlRatesEditorProps {
  vehicles: Vehicle[];
  /** Trip prices keyed `vehicle:origin>destination`. Null means not offered. */
  rates: Record<string, number | null>;
  /** Live values, to show what a draft edit is moving away from. */
  baseline: Record<string, number | null>;
  canEdit: boolean;
  fuelFtl: number;
  gstFtl: number;
  onSave: (
    edits: { vehicle: string; origin: string; destination: string; value: number | null }[],
  ) => Promise<void>;
}

const key = (vehicle: string, origin: string, destination: string) =>
  `${vehicle}:${origin}>${destination}`;

const rupees = (value: number) =>
  value.toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function FtlRatesEditor(props: FtlRatesEditorProps) {
  const [vehicle, setVehicle] = useState(props.vehicles[0]?.code ?? '');
  const [origin, setOrigin] = useState('PNQ');
  const [destination, setDestination] = useState('BLR');
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const cell = key(vehicle, origin, destination);
  const stored = props.rates[cell] ?? null;
  const live = props.baseline[cell] ?? null;

  const shown = draft ?? (stored === null ? '' : String(stored));
  const parsed: number | null = shown.trim() === '' ? null : Number(shown.replace(/[₹,\s]/g, ''));
  const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0);
  const changed = valid && parsed !== stored;

  /** Every lane already rated for the selected vehicle. */
  const rated = useMemo(() => {
    const rows: { origin: string; destination: string; price: number }[] = [];
    for (const from of SURFACE_ZONES) {
      for (const to of SURFACE_ZONES) {
        const price = props.rates[key(vehicle, from, to)];
        if (typeof price === 'number') rows.push({ origin: from, destination: to, price });
      }
    }
    return rows.sort((a, b) => b.price - a.price);
  }, [props.rates, vehicle]);

  const selected = props.vehicles.find((entry) => entry.code === vehicle);

  const save = () => {
    setError(null);
    startTransition(async () => {
      try {
        await props.onSave([{ vehicle, origin, destination, value: parsed }]);
        setDraft(null);
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save that change.');
      }
    });
  };

  // What the trip actually bills at, so the price being typed can be judged whole.
  const landed = parsed === null ? null : parsed * (1 + props.fuelFtl) * (1 + props.gstFtl);

  return (
    <>
      <div className="panel">
        <header>
          <h3>Choose a truck and a lane</h3>
          <span className="hint">
            One price for the trip. No weight tiers — the truck is hired whole.
          </span>
        </header>
        <div className="body">
          <div className="inline-form">
            <div className="field">
              <label htmlFor="vehicle">Vehicle</label>
              <select
                id="vehicle"
                value={vehicle}
                onChange={(event) => {
                  setVehicle(event.target.value);
                  setDraft(null);
                  setSaved(false);
                }}
              >
                {props.vehicles.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.label} · {entry.capacityKg.toLocaleString('en-IN')} kg
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="origin">From</label>
              <select
                id="origin"
                value={origin}
                onChange={(event) => {
                  setOrigin(event.target.value);
                  setDraft(null);
                  setSaved(false);
                }}
              >
                {SURFACE_ZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="destination">To</label>
              <select
                id="destination"
                value={destination}
                onChange={(event) => {
                  setDestination(event.target.value);
                  setDraft(null);
                  setSaved(false);
                }}
              >
                {SURFACE_ZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="price">Trip price ₹</label>
              <input
                id="price"
                inputMode="decimal"
                className={changed ? 'changed' : undefined}
                value={shown}
                disabled={!props.canEdit}
                placeholder="not offered"
                onChange={(event) => {
                  setSaved(false);
                  setDraft(event.target.value);
                }}
              />
            </div>
          </div>

          {!valid && <div className="error">A trip price has to be a number, or blank.</div>}

          <table className="data" style={{ marginTop: 12 }}>
            <tbody>
              <tr>
                <td style={{ width: 200 }}>This lane</td>
                <td>
                  <strong>
                    {selected?.label} · {origin} → {destination}
                  </strong>
                </td>
              </tr>
              <tr>
                <td>Currently</td>
                <td className="num">
                  {stored === null ? 'Not offered on this lane' : `₹${rupees(stored)}`}
                  {live !== stored && (
                    <span style={{ color: 'var(--ink-faint)' }}>
                      {' '}
                      · live {live === null ? 'not offered' : `₹${rupees(live)}`}
                    </span>
                  )}
                </td>
              </tr>
              {landed !== null && (
                <tr>
                  <td>Bills at</td>
                  <td className="num">
                    ₹{rupees(Math.round(landed * 100) / 100)}
                    <span style={{ color: 'var(--ink-faint)' }}>
                      {' '}
                      · trip + {(props.fuelFtl * 100).toFixed(0)}% fuel +{' '}
                      {(props.gstFtl * 100).toFixed(0)}% GST, before cartage and charges
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <header>
          <h3>Lanes rated for this truck</h3>
          <span className="hint">
            {rated.length === 0
              ? 'None yet — nothing has been priced for this vehicle.'
              : `${rated.length} lane${rated.length === 1 ? '' : 's'}, dearest first.`}
          </span>
        </header>
        <div className="body">
          {rated.length > 0 && (
            <table className="data">
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th className="num">Trip price</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rated.map((row) => (
                  <tr key={`${row.origin}>${row.destination}`}>
                    <td>{row.origin}</td>
                    <td>{row.destination}</td>
                    <td className="num">₹{rupees(row.price)}</td>
                    <td>
                      <button
                        onClick={() => {
                          setOrigin(row.origin);
                          setDestination(row.destination);
                          setDraft(null);
                          setSaved(false);
                        }}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {props.canEdit && (
        <div className="actionbar">
          {changed ? (
            <span className="chip draft count">1 change</span>
          ) : saved ? (
            <span className="chip live">Saved to draft</span>
          ) : (
            <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>No changes</span>
          )}
          <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
            Clearing the price withdraws that truck from the lane.
          </span>
          <span className="spacer" />
          {changed && (
            <button onClick={() => setDraft(null)} disabled={pending}>
              Revert
            </button>
          )}
          <button className="primary" onClick={save} disabled={!changed || pending}>
            {pending ? 'Saving…' : 'Save to draft'}
          </button>
        </div>
      )}
    </>
  );
}
