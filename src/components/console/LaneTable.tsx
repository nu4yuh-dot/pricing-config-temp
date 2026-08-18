'use client';

import { useMemo, useState, useTransition } from 'react';
import type { StoredMode } from '../../domain/types';
import type { LaneSummary } from '../../console/lanes';
import type { LaneEdit } from '../../app/console-actions';
import type { RateKey } from './LaneEditor';

/**
 * Every lane in one filterable table, with the four rates inline.
 *
 * This is the bridge between the guided editor (one lane at a time) and a bulk
 * operation (hundreds at once): when you want to see and adjust a handful of
 * related lanes, neither of those fits.
 */

const RATES: { key: RateKey; head: string }[] = [
  { key: 'minCharge', head: 'Minimum ₹' },
  { key: 'tier1', head: 'Tier 1 ₹/kg' },
  { key: 'tier2', head: 'Tier 2 ₹/kg' },
  { key: 'tier3', head: 'Tier 3 ₹/kg' },
];

export default function LaneTable(props: {
  cardKey: string;
  mode: StoredMode;
  lanes: LaneSummary[];
  canEdit: boolean;
  onSave: (edits: LaneEdit[]) => Promise<void>;
}) {
  const [filter, setFilter] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [hideUnserved, setHideUnserved] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = filter.trim().toUpperCase();
    return props.lanes.filter((lane) => {
      if (onlyChanged && !lane.changed) return false;
      if (hideUnserved && !lane.served) return false;
      if (!needle) return true;
      return (
        lane.origin.includes(needle) ||
        lane.destination.includes(needle) ||
        `${lane.origin}>${lane.destination}`.includes(needle)
      );
    });
  }, [props.lanes, filter, onlyChanged, hideUnserved]);

  const fieldId = (lane: LaneSummary, rate: RateKey) => `${lane.key}:${rate}`;

  const valueOf = (lane: LaneSummary, rate: RateKey): string => {
    const id = fieldId(lane, rate);
    if (id in drafts) return drafts[id] as string;
    const value = lane.rates[rate];
    return value === null ? '' : String(value);
  };

  const parsedOf = (lane: LaneSummary, rate: RateKey): number | null => {
    const raw = valueOf(lane, rate).trim();
    if (raw === '' || raw === '-') return null;
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : null;
  };

  const dirty = useMemo(() => {
    const edits: LaneEdit[] = [];
    for (const lane of props.lanes) {
      for (const { key } of RATES) {
        const id = fieldId(lane, key);
        if (!(id in drafts)) continue;
        const next = parsedOf(lane, key);
        if (next === lane.rates[key]) continue;
        edits.push({
          mode: lane.mode,
          origin: lane.origin,
          destination: lane.destination,
          rate: key,
          value: next,
        });
      }
    }
    return edits;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, props.lanes]);

  const save = () => {
    setError(null);
    startTransition(async () => {
      try {
        await props.onSave(dirty);
        setDrafts({});
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save those edits.');
      }
    });
  };

  const changedCount = props.lanes.filter((lane) => lane.changed).length;

  return (
    <div className="panel">
      <header>
        <h3>
          {props.mode === 'air' ? 'Air' : props.mode === 'rail' ? 'Rail' : 'Surface'} lanes
        </h3>
        <span className="hint">
          {visible.length} shown of {props.lanes.length}
          {changedCount > 0 && ` · ${changedCount} differ from live`}
        </span>
      </header>

      <div className="body">
        <div className="selector" style={{ marginBottom: 12 }}>
          <div className="field">
            <label htmlFor="lt-mode">Mode</label>
            <select
              id="lt-mode"
              value={props.mode}
              onChange={(event) => {
                window.location.href = `/console/${props.cardKey}/rates?browse=${event.target.value}`;
              }}
            >
              <option value="surface">Surface</option>
              <option value="air">Air</option>
              <option value="rail">Rail</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="lt-filter">Filter by zone</label>
            <input
              id="lt-filter"
              placeholder="PNQ, or PNQ&gt;NCR"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="lt-changed">Only changed</label>
            <input
              id="lt-changed"
              type="checkbox"
              checked={onlyChanged}
              onChange={(event) => setOnlyChanged(event.target.checked)}
            />
          </div>
          <div className="field">
            <label htmlFor="lt-unserved">Hide unserved</label>
            <input
              id="lt-unserved"
              type="checkbox"
              checked={hideUnserved}
              onChange={(event) => setHideUnserved(event.target.checked)}
            />
          </div>
        </div>

        <div style={{ maxHeight: 420, overflow: 'auto', border: '1px solid var(--rule)' }}>
          <table className="lanes">
            <thead>
              <tr>
                <th className="left">Lane</th>
                {RATES.map((rate) => (
                  <th key={rate.key}>{rate.head}</th>
                ))}
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((lane) => (
                <tr key={lane.key} className={lane.served ? undefined : 'unserved'}>
                  <td className="left">
                    <strong>{lane.origin}</strong> → <strong>{lane.destination}</strong>
                  </td>
                  {RATES.map(({ key }) => {
                    const id = fieldId(lane, key);
                    const edited = id in drafts && parsedOf(lane, key) !== lane.rates[key];
                    return (
                      <td key={key}>
                        {lane.served ? (
                          <input
                            className={edited ? 'changed' : lane.changed ? 'overridden' : ''}
                            inputMode="decimal"
                            value={valueOf(lane, key)}
                            disabled={!props.canEdit}
                            onChange={(event) =>
                              setDrafts((current) => ({ ...current, [id]: event.target.value }))
                            }
                          />
                        ) : (
                          <span style={{ color: 'var(--ink-faint)' }}>—</span>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    {lane.served ? (
                      lane.changed ? (
                        <span className="chip draft count">changed</span>
                      ) : (
                        <span style={{ color: 'var(--ink-faint)' }}>live</span>
                      )
                    ) : (
                      <span className="chip rejected count">not served</span>
                    )}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="left" style={{ color: 'var(--ink-faint)' }}>
                    No lanes match those filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {error && (
          <div className="error" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </div>

      {props.canEdit && dirty.length > 0 && (
        <div className="actionbar">
          <span className="chip draft count">
            {dirty.length} rate{dirty.length === 1 ? '' : 's'} edited
          </span>
          <span className="spacer" />
          <button onClick={() => setDrafts({})} disabled={pending}>
            Revert
          </button>
          <button className="primary" onClick={save} disabled={pending}>
            {pending ? 'Saving…' : 'Save to draft'}
          </button>
        </div>
      )}
    </div>
  );
}
