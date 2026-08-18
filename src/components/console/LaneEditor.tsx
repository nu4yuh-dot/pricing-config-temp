'use client';

import { useMemo, useState, useTransition } from 'react';
import { AIR_ZONES, SURFACE_ZONES } from '../../domain/zones';
import { MODES, type Mode, type StoredMode } from '../../domain/types';
import { computeFreight, applicableTierRate } from '../../pricing/freight';
import type { FreightMethod } from '../../domain/types';
import { round2 } from '../../pricing/weight';

/**
 * Guided lane editing.
 *
 * The spreadsheet view asks you to know that the 300+ kg rate for PNQ→NCR lives at
 * `V77` on the Surface Rates tab. This asks you to pick a mode, an origin and a
 * destination from dropdowns, then shows the four rates as labelled fields with the
 * resulting quote beside them. Same data, same approval path, far less to know.
 */

export type RateKey = 'minCharge' | 'tier1' | 'tier2' | 'tier3';

const RATE_KEYS: RateKey[] = ['minCharge', 'tier1', 'tier2', 'tier3'];

export interface LaneRateValues {
  minCharge: number | null;
  tier1: number | null;
  tier2: number | null;
  tier3: number | null;
}

export interface LaneEditorProps {
  /** Rates for every lane, keyed `mode:origin>dest`. */
  lanes: Record<string, LaneRateValues>;
  /** The comparison basis: live values for a base card, base values for a contract. */
  baseline: Record<string, LaneRateValues>;
  freightMethod: FreightMethod;
  minWeightAir: number;
  minWeightSurface: number;
  /** Extra charges used for the live preview. */
  preview: {
    fuelAir: number;
    fuelSurface: number;
    fuelRail: number;
    gstAir: number;
    gstSurface: number;
    docket: number;
    nfoMultiplier: number;
  };
  canEdit: boolean;
  /** How the baseline should be described in the UI. */
  baselineLabel: string;
  onSave: (
    edits: { mode: StoredMode; origin: string; destination: string; rate: RateKey; value: number | null }[],
  ) => Promise<void>;
}

/** Short labels, so the four fields stay one even row. */
function rateMeta(minWeight: number): { key: RateKey; label: string; unit: string }[] {
  return [
    { key: 'minCharge', label: `Minimum ≤${minWeight} kg`, unit: '₹' },
    { key: 'tier1', label: `${minWeight}–100 kg`, unit: '₹/kg' },
    { key: 'tier2', label: '100–300 kg', unit: '₹/kg' },
    { key: 'tier3', label: '300 kg +', unit: '₹/kg' },
  ];
}

const networkFor = (mode: Mode): StoredMode => (mode === 'nfo' ? 'air' : mode);
const key = (mode: StoredMode, origin: string, destination: string) =>
  `${mode}:${origin}>${destination}`;

const PREVIEW_WEIGHTS = [50, 200, 500, 1000];

export default function LaneEditor(props: LaneEditorProps) {
  const [mode, setMode] = useState<Mode>('surface');
  const [origin, setOrigin] = useState('PNQ');
  const [destination, setDestination] = useState('NCR');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const network = networkFor(mode);
  const zones = network === 'air' ? AIR_ZONES : SURFACE_ZONES;
  const laneId = key(network, origin, destination);

  const stored = props.lanes[laneId] ?? { minCharge: null, tier1: null, tier2: null, tier3: null };
  const baseline = props.baseline[laneId] ?? stored;
  const multiplier = mode === 'nfo' ? props.preview.nfoMultiplier : 1;

  /** Draft state falls back to stored values, so untouched fields show reality. */
  const fieldValue = (rate: RateKey): string => {
    const draftKey = `${laneId}:${rate}`;
    if (draftKey in drafts) return drafts[draftKey] as string;
    const value = stored[rate];
    return value === null ? '' : String(value);
  };

  const parsed = (rate: RateKey): number | null => {
    const raw = fieldValue(rate).trim();
    if (raw === '' || raw === '-') return null;
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : null;
  };

  const isChanged = (rate: RateKey): boolean => parsed(rate) !== stored[rate];
  const isOverridden = (rate: RateKey): boolean => stored[rate] !== baseline[rate];

  const dirty = useMemo(
    () => RATE_KEYS.filter((rate) => isChanged(rate)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, laneId, stored],
  );

  const served = parsed('minCharge') !== null;

  const currentRates: LaneRateValues = {
    minCharge: parsed('minCharge'),
    tier1: parsed('tier1'),
    tier2: parsed('tier2'),
    tier3: parsed('tier3'),
  };

  const minWeight = network === 'air' ? props.minWeightAir : props.minWeightSurface;
  const rateFields = rateMeta(minWeight);
  const fuel =
    mode === 'rail'
      ? props.preview.fuelRail
      : network === 'air'
        ? props.preview.fuelAir
        : props.preview.fuelSurface;
  const gst = network === 'air' ? props.preview.gstAir : props.preview.gstSurface;

  /** Freight only — cartage and ODA depend on pincodes, which this view has not got. */
  const quoteAt = (weight: number, rates: LaneRateValues): number | null => {
    const scaled: LaneRateValues = {
      minCharge: rates.minCharge === null ? null : rates.minCharge * multiplier,
      tier1: rates.tier1 === null ? null : rates.tier1 * multiplier,
      tier2: rates.tier2 === null ? null : rates.tier2 * multiplier,
      tier3: rates.tier3 === null ? null : rates.tier3 * multiplier,
    };
    const freight = computeFreight(props.freightMethod, weight, minWeight, scaled);
    if (freight === null) return null;
    const withFuel = freight * (1 + fuel);
    return round2((withFuel + props.preview.docket) * (1 + gst));
  };

  const setServed = (next: boolean) => {
    if (!props.canEdit) return;
    setSaved(false);
    if (next) {
      // Reopening a lane seeds it from the baseline so it is not left blank.
      setDrafts((current) => ({
        ...current,
        [`${laneId}:minCharge`]: String(baseline.minCharge ?? 0),
        [`${laneId}:tier1`]: String(baseline.tier1 ?? 0),
        [`${laneId}:tier2`]: String(baseline.tier2 ?? 0),
        [`${laneId}:tier3`]: String(baseline.tier3 ?? 0),
      }));
    } else {
      setDrafts((current) => ({
        ...current,
        [`${laneId}:minCharge`]: '',
        [`${laneId}:tier1`]: '',
        [`${laneId}:tier2`]: '',
        [`${laneId}:tier3`]: '',
      }));
    }
  };

  const save = () => {
    setError(null);
    startTransition(async () => {
      try {
        await props.onSave(
          dirty.map((rate) => ({
            mode: network,
            origin,
            destination,
            rate,
            value: parsed(rate),
          })),
        );
        setDrafts({});
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save that change.');
      }
    });
  };

  const intraZone = origin === destination;

  return (
    <div className="two-col">
      <div>
        <div className="panel">
          <header>
            <h3>Choose a lane</h3>
            <span className="hint">Three dropdowns — no cell references</span>
          </header>
          <div className="body">
            <div className="selector">
              <div className="field">
                <label htmlFor="le-mode">Mode</label>
                <select
                  id="le-mode"
                  value={mode}
                  onChange={(event) => {
                    const next = event.target.value as Mode;
                    setMode(next);
                    setSaved(false);
                    // Air runs on 12 hubs; keep the selection valid when switching.
                    const nextZones = networkFor(next) === 'air' ? AIR_ZONES : SURFACE_ZONES;
                    if (!nextZones.includes(origin as never)) setOrigin(nextZones[0] as string);
                    if (!nextZones.includes(destination as never)) {
                      setDestination((nextZones[1] ?? nextZones[0]) as string);
                    }
                  }}
                >
                  {MODES.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry === 'nfo' ? 'NFO / JIT (2× air)' : entry[0]?.toUpperCase() + entry.slice(1)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="le-origin">From</label>
                <select
                  id="le-origin"
                  value={origin}
                  onChange={(event) => {
                    setOrigin(event.target.value);
                    setSaved(false);
                  }}
                >
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </div>

              <span className="arrow">→</span>

              <div className="field">
                <label htmlFor="le-dest">To</label>
                <select
                  id="le-dest"
                  value={destination}
                  onChange={(event) => {
                    setDestination(event.target.value);
                    setSaved(false);
                  }}
                >
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label>Do we carry this lane?</label>
                <div className="served-toggle">
                  <button
                    type="button"
                    aria-pressed={served}
                    onClick={() => setServed(true)}
                    disabled={!props.canEdit}
                    title="This lane can be quoted and booked at the rates below"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    className="off"
                    aria-pressed={!served}
                    onClick={() => setServed(false)}
                    disabled={!props.canEdit}
                    title="Quotes for this lane will be declined outright"
                  >
                    No
                  </button>
                </div>
              </div>
            </div>

            {/*
              Closing a lane is not the same as pricing it high — it removes the lane
              from quoting entirely. Said plainly, at the moment of the decision.
            */}
            <p
              style={{
                margin: '10px 0 0',
                fontSize: 11.5,
                color: served ? 'var(--ink-faint)' : 'var(--rejected)',
              }}
            >
              {served ? (
                <>
                  Quotes for {origin} → {destination} by{' '}
                  {network === 'air' ? 'air' : network === 'rail' ? 'rail' : 'surface'} will use the
                  rates below. Customers can book it.
                </>
              ) : (
                <>
                  <strong>Nothing can be quoted or booked on this lane.</strong> The calculator will
                  decline it and the booking site will refuse it — this is not the same as pricing it
                  high. Set the rates first, then switch it on.
                </>
              )}
            </p>

            {mode === 'nfo' && (
              <p style={{ color: 'var(--ink-faint)', fontSize: 11.5, marginBottom: 0 }}>
                NFO is derived as {props.preview.nfoMultiplier}× the Air card, so edit Air and NFO
                follows. The fields below show the underlying Air rates.
              </p>
            )}
            {intraZone && (
              <p style={{ color: 'var(--ink-faint)', fontSize: 11.5, marginBottom: 0 }}>
                Same-zone lane: no pickup or delivery cartage is charged on this one.
              </p>
            )}
          </div>
        </div>

        <div className="panel">
          <header>
            <h3>
              {network === 'air' ? 'Air' : network === 'rail' ? 'Rail' : 'Surface'} · {origin} →{' '}
              {destination}
            </h3>
            <span className="hint">
              {served
                ? `Minimum charge covers any shipment up to ${minWeight} kg`
                : 'Not carried — quotes for this lane are declined'}
            </span>
          </header>
          <div className="body">
            {served ? (
              <div className="rate-fields">
                {rateFields.map((meta) => {
                  const changed = isChanged(meta.key);
                  const overridden = isOverridden(meta.key);
                  return (
                    <div
                      key={meta.key}
                      className={`rate-field${changed ? ' changed' : overridden ? ' overridden' : ''}`}
                    >
                      <label htmlFor={`rate-${meta.key}`}>
                        {meta.label} <span className="unit">{meta.unit}</span>
                      </label>
                      <input
                        id={`rate-${meta.key}`}
                        inputMode="decimal"
                        value={fieldValue(meta.key)}
                        disabled={!props.canEdit}
                        onChange={(event) => {
                          setSaved(false);
                          setDrafts((current) => ({
                            ...current,
                            [`${laneId}:${meta.key}`]: event.target.value,
                          }));
                        }}
                      />
                      <div className="baseline">
                        {changed ? (
                          <>
                            was <strong>{stored[meta.key] ?? '—'}</strong>
                          </>
                        ) : overridden ? (
                          <>
                            {props.baselineLabel} {baseline[meta.key] ?? '—'}
                          </>
                        ) : (
                          <>&nbsp;</>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty">
                This lane is not carried, so there are no rates to set.
                <br />
                Switch to <strong>Yes</strong> above to open it. It will be seeded from
                standard rates, which you can then adjust before submitting.
              </div>
            )}
          </div>

          {props.canEdit && (
            <div className="actionbar">
              {dirty.length > 0 ? (
                <span className="chip draft count">
                  {dirty.length} field{dirty.length === 1 ? '' : 's'} changed
                </span>
              ) : saved ? (
                <span className="chip live">Saved to draft</span>
              ) : (
                <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                  No changes on this lane
                </span>
              )}
              {error && <span style={{ color: 'var(--rejected)', fontSize: 11.5 }}>{error}</span>}
              <span className="spacer" />
              {dirty.length > 0 && (
                <button onClick={() => setDrafts({})} disabled={pending}>
                  Revert
                </button>
              )}
              <button className="primary" onClick={save} disabled={dirty.length === 0 || pending}>
                {pending ? 'Saving…' : 'Save to draft'}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <header>
          <h3>What this lane quotes</h3>
          <span className="hint">Freight, fuel, docket and GST</span>
        </header>
        <div className="body">
          {served ? (
            <div className="consequence">
              <table>
                <tbody>
                  {PREVIEW_WEIGHTS.map((weight) => {
                    const now = quoteAt(weight, currentRates);
                    const before = quoteAt(weight, stored);
                    const moved = now !== null && before !== null && now !== before;
                    return (
                      <tr key={weight} className={weight === 200 ? 'headline' : undefined}>
                        <td>{weight} kg</td>
                        <td>
                          {moved && <span className="was">₹{before?.toLocaleString('en-IN')}</span>}
                          {now === null ? '—' : `₹${now.toLocaleString('en-IN')}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p style={{ fontSize: 10.5, color: 'var(--ink-faint)', margin: '10px 0 0' }}>
                Excludes pickup, delivery and ODA — those depend on the pincodes, not the lane. Use
                the calculator for a full landed quote.
              </p>
              {props.freightMethod !== 'CUMULATIVE_SLABS' && (
                <p style={{ fontSize: 10.5, color: 'var(--ink-faint)', margin: '8px 0 0' }}>
                  This card applies a single tier rate chosen by total weight — at 200 kg that is{' '}
                  <strong>{applicableTierRate(200, currentRates) ?? '—'}</strong> ₹/kg.
                </p>
              )}
            </div>
          ) : (
            <div className="empty">
              Nothing to quote — we do not carry this lane.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
