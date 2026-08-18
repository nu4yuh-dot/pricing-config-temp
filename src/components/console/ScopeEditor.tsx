'use client';

import { useState, useTransition } from 'react';
import { AIR_ZONES, SURFACE_ZONES } from '../../domain/zones';
import { MODES, type Mode, type StoredMode } from '../../domain/types';
import { laneKey, type ContractScope, type WeightBand } from '../../domain/customers';

/**
 * What a contract covers.
 *
 * Restrictions are opt-in: an empty contract covers everything, which is the safe
 * default for a customer who has just been onboarded. Narrowing is deliberate,
 * because anything outside the scope stops being bookable at contract prices.
 */
export default function ScopeEditor(props: {
  scope: ContractScope;
  canEdit: boolean;
  onSave: (scope: ContractScope) => Promise<void>;
}) {
  const [modes, setModes] = useState<Mode[] | null>(props.scope.modes);
  const [lanes, setLanes] = useState<string[] | null>(props.scope.lanes);
  const [bands, setBands] = useState<WeightBand[] | null>(props.scope.weightBands);
  const [laneMode, setLaneMode] = useState<StoredMode>('surface');
  const [laneOrigin, setLaneOrigin] = useState('PNQ');
  const [laneDest, setLaneDest] = useState('NCR');
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    JSON.stringify({ modes, lanes, weightBands: bands }) !==
    JSON.stringify({
      modes: props.scope.modes,
      lanes: props.scope.lanes,
      weightBands: props.scope.weightBands,
    });

  const zones = laneMode === 'air' ? AIR_ZONES : SURFACE_ZONES;

  const toggleMode = (mode: Mode) => {
    setSaved(false);
    setModes((current) => {
      if (current === null) return MODES.filter((entry) => entry !== mode);
      const next = current.includes(mode)
        ? current.filter((entry) => entry !== mode)
        : [...current, mode];
      return next.length === MODES.length ? null : next;
    });
  };

  const addLane = () => {
    setSaved(false);
    const key = laneKey(laneMode, laneOrigin, laneDest);
    setLanes((current) => {
      const list = current ?? [];
      return list.includes(key) ? list : [...list, key].sort();
    });
  };

  const save = () => {
    setError(null);
    startTransition(async () => {
      try {
        await props.onSave({ modes, lanes, weightBands: bands });
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save the scope.');
      }
    });
  };

  return (
    <div className="panel">
      <header>
        <h3>Contract coverage</h3>
        <span className="hint">
          Anything outside this cannot be booked at contract prices without approval
        </span>
      </header>

      <div className="body">
        {/* Modes */}
        <div style={{ marginBottom: 18 }}>
          <div className="field" style={{ marginBottom: 6 }}>
            <label>Modes</label>
          </div>
          <div className="pill-list" style={{ marginTop: 0 }}>
            {MODES.map((mode) => {
              const on = modes === null || modes.includes(mode);
              return (
                <button
                  key={mode}
                  type="button"
                  className={`pill${on ? ' on' : ''}`}
                  disabled={!props.canEdit}
                  onClick={() => toggleMode(mode)}
                >
                  {mode}
                </button>
              );
            })}
          </div>
          <p style={{ fontSize: 11, color: 'var(--ink-faint)', margin: '6px 0 0' }}>
            {modes === null
              ? 'All modes covered — nothing stored, so new modes are covered automatically.'
              : `Restricted to ${modes.join(', ') || 'nothing'}.`}
          </p>
        </div>

        {/* Lanes */}
        <div style={{ marginBottom: 18 }}>
          <div className="field" style={{ marginBottom: 6 }}>
            <label>Lanes</label>
          </div>

          {lanes === null ? (
            <>
              <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
                All lanes are covered.
              </p>
              {props.canEdit && (
                <button
                  type="button"
                  onClick={() => {
                    setSaved(false);
                    setLanes([]);
                  }}
                >
                  Restrict to specific lanes
                </button>
              )}
            </>
          ) : (
            <>
              <div className="selector" style={{ marginBottom: 10 }}>
                <div className="field">
                  <label htmlFor="sc-mode">Mode</label>
                  <select
                    id="sc-mode"
                    value={laneMode}
                    onChange={(event) => setLaneMode(event.target.value as StoredMode)}
                  >
                    <option value="surface">Surface</option>
                    <option value="air">Air</option>
                    <option value="rail">Rail</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="sc-origin">From</label>
                  <select
                    id="sc-origin"
                    value={laneOrigin}
                    onChange={(event) => setLaneOrigin(event.target.value)}
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
                  <label htmlFor="sc-dest">To</label>
                  <select
                    id="sc-dest"
                    value={laneDest}
                    onChange={(event) => setLaneDest(event.target.value)}
                  >
                    {zones.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                </div>
                {props.canEdit && (
                  <button type="button" onClick={addLane}>
                    Add lane
                  </button>
                )}
              </div>

              <div className="pill-list" style={{ marginTop: 0 }}>
                {lanes.length === 0 && (
                  <span style={{ fontSize: 11.5, color: 'var(--rejected)' }}>
                    No lanes yet — nothing is bookable at contract prices until you add some.
                  </span>
                )}
                {lanes.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="pill on"
                    disabled={!props.canEdit}
                    title="Remove"
                    onClick={() => {
                      setSaved(false);
                      setLanes((current) => (current ?? []).filter((entry) => entry !== key));
                    }}
                  >
                    {key.replace(':', ' ').replace('>', ' → ')} ✕
                  </button>
                ))}
              </div>

              {props.canEdit && (
                <button
                  type="button"
                  style={{ marginTop: 10 }}
                  onClick={() => {
                    setSaved(false);
                    setLanes(null);
                  }}
                >
                  Cover all lanes instead
                </button>
              )}
            </>
          )}
        </div>

        {/* Weight bands */}
        <div>
          <div className="field" style={{ marginBottom: 6 }}>
            <label>Weight bands</label>
          </div>
          {bands === null ? (
            <>
              <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
                All weights are covered.
              </p>
              {props.canEdit && (
                <button
                  type="button"
                  onClick={() => {
                    setSaved(false);
                    setBands([{ from: 0, to: null }]);
                  }}
                >
                  Restrict to specific weight bands
                </button>
              )}
            </>
          ) : (
            <>
              {bands.map((band, index) => (
                <div className="selector" key={index} style={{ marginBottom: 8 }}>
                  <div className="field" style={{ minWidth: 110 }}>
                    <label>From kg</label>
                    <input
                      inputMode="decimal"
                      value={band.from}
                      disabled={!props.canEdit}
                      onChange={(event) => {
                        setSaved(false);
                        const value = Number(event.target.value);
                        setBands((current) =>
                          (current ?? []).map((entry, i) =>
                            i === index
                              ? { ...entry, from: Number.isFinite(value) ? value : 0 }
                              : entry,
                          ),
                        );
                      }}
                    />
                  </div>
                  <div className="field" style={{ minWidth: 110 }}>
                    <label>To kg (blank = no limit)</label>
                    <input
                      inputMode="decimal"
                      value={band.to ?? ''}
                      disabled={!props.canEdit}
                      onChange={(event) => {
                        setSaved(false);
                        const raw = event.target.value.trim();
                        const value = raw === '' ? null : Number(raw);
                        setBands((current) =>
                          (current ?? []).map((entry, i) =>
                            i === index
                              ? { ...entry, to: value !== null && Number.isFinite(value) ? value : null }
                              : entry,
                          ),
                        );
                      }}
                    />
                  </div>
                  {props.canEdit && (
                    <button
                      type="button"
                      onClick={() => {
                        setSaved(false);
                        setBands((current) => (current ?? []).filter((_, i) => i !== index));
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {props.canEdit && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setSaved(false);
                      setBands((current) => [...(current ?? []), { from: 0, to: null }]);
                    }}
                  >
                    Add band
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSaved(false);
                      setBands(null);
                    }}
                  >
                    Cover all weights instead
                  </button>
                </div>
              )}
              <p style={{ fontSize: 11, color: 'var(--ink-faint)', margin: '8px 0 0' }}>
                Bands are half open: a band ending at 100 covers up to 99.9 kg, and 100 kg belongs to
                the next one.
              </p>
            </>
          )}
        </div>

        {error && (
          <div className="error" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>

      {props.canEdit && (
        <div className="actionbar">
          {dirty ? (
            <span className="chip draft count">Coverage changed</span>
          ) : saved ? (
            <span className="chip live">Saved to draft</span>
          ) : (
            <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>No changes</span>
          )}
          <span className="spacer" />
          <button className="primary" onClick={save} disabled={!dirty || pending}>
            {pending ? 'Saving…' : 'Save coverage to draft'}
          </button>
        </div>
      )}
    </div>
  );
}
