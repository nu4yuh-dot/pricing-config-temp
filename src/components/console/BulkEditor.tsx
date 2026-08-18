'use client';

import { useMemo, useState, useTransition } from 'react';
import { AIR_ZONES, SURFACE_ZONES } from '../../domain/zones';
import { ZONE_GROUPS, zonesInGroup } from '../../domain/zone-groups';
import type { StoredMode } from '../../domain/types';
import { round2 } from '../../pricing/weight';
import type { LaneRateValues, RateKey } from './LaneEditor';

/**
 * Bulk rate changes.
 *
 * "Put every lane out of Pune up 5%" is one sentence and used to be several hundred
 * cell edits. Here it is four dropdowns and a preview: nothing is written until the
 * affected lanes have been counted and shown.
 */

type Operation = 'set' | 'increase-pct' | 'decrease-pct' | 'increase-amount' | 'decrease-amount';

const OPERATIONS: { value: Operation; label: string; suffix: string }[] = [
  { value: 'increase-pct', label: 'Increase by', suffix: '%' },
  { value: 'decrease-pct', label: 'Decrease by', suffix: '%' },
  { value: 'increase-amount', label: 'Increase by', suffix: '₹' },
  { value: 'decrease-amount', label: 'Decrease by', suffix: '₹' },
  { value: 'set', label: 'Set to exactly', suffix: '₹' },
];

const RATE_CHOICES: { value: RateKey | 'all' | 'tiers'; label: string }[] = [
  { value: 'all', label: 'Minimum charge and all tiers' },
  { value: 'tiers', label: 'All per-kg tiers only' },
  { value: 'minCharge', label: 'Minimum charge only' },
  { value: 'tier1', label: 'Tier 1 (min–100 kg) only' },
  { value: 'tier2', label: 'Tier 2 (100–300 kg) only' },
  { value: 'tier3', label: 'Tier 3 (300 kg+) only' },
];

export interface BulkEditorProps {
  lanes: Record<string, LaneRateValues>;
  canEdit: boolean;
  /** For pointing at the rule editor when a rule is what the person actually wants. */
  cardKey: string;
  onApply: (
    edits: { mode: StoredMode; origin: string; destination: string; rate: RateKey; value: number | null }[],
  ) => Promise<void>;
}

const key = (mode: StoredMode, origin: string, destination: string) =>
  `${mode}:${origin}>${destination}`;

function applyOperation(current: number, operation: Operation, amount: number): number {
  switch (operation) {
    case 'set':
      return amount;
    case 'increase-pct':
      return current * (1 + amount / 100);
    case 'decrease-pct':
      return current * (1 - amount / 100);
    case 'increase-amount':
      return current + amount;
    case 'decrease-amount':
      return current - amount;
  }
}

export default function BulkEditor(props: BulkEditorProps) {
  const [mode, setMode] = useState<StoredMode>('surface');
  const [originScope, setOriginScope] = useState('*');
  const [destScope, setDestScope] = useState('*');
  const [rateScope, setRateScope] = useState<RateKey | 'all' | 'tiers'>('all');
  const [operation, setOperation] = useState<Operation>('increase-pct');
  const [amount, setAmount] = useState('5');
  const [includeIntraZone, setIncludeIntraZone] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const zones = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;

  /**
   * A scope token is `*` for everything, `group:<key>` for a named group, or a bare
   * zone code. Groups are what make "one rate for the metros" a single operation
   * instead of fifty-six lane edits.
   */
  const resolveScope = (token: string): string[] => {
    if (token === '*') return [...zones];
    if (token.startsWith('group:')) return zonesInGroup(token.slice('group:'.length), mode);
    return [token];
  };

  const rateKeys: RateKey[] = useMemo(() => {
    if (rateScope === 'all') return ['minCharge', 'tier1', 'tier2', 'tier3'];
    if (rateScope === 'tiers') return ['tier1', 'tier2', 'tier3'];
    return [rateScope];
  }, [rateScope]);

  /** The edits this operation would make, computed before anything is written. */
  const planned = useMemo(() => {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric)) return [];

    const edits: {
      mode: StoredMode;
      origin: string;
      destination: string;
      rate: RateKey;
      from: number;
      value: number;
    }[] = [];

    const origins = resolveScope(originScope);
    const destinations = resolveScope(destScope);

    for (const origin of origins) {
      for (const destination of destinations) {
        if (!includeIntraZone && origin === destination) continue;

        const lane = props.lanes[key(mode, origin, destination)];
        // An unserved lane is skipped: a percentage of nothing is still nothing,
        // and opening lanes is a deliberate act, not a side effect of a bulk edit.
        if (!lane || lane.minCharge === null) continue;

        for (const rate of rateKeys) {
          const current = lane[rate];
          if (current === null) continue;
          const next = round2(applyOperation(current, operation, numeric));
          if (next === current) continue;
          edits.push({ mode, origin, destination, rate, from: current, value: next });
        }
      }
    }
    return edits;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, originScope, destScope, includeIntraZone, props.lanes, mode, rateKeys, operation, amount]);

  const negatives = planned.filter((edit) => edit.value <= 0);

  /**
   * Would a lane rule say this better?
   *
   * Only for `set`: a proportional change genuinely needs a cell per lane, because each
   * lane lands somewhere different and no single rate can express that. Setting one price
   * across a group is the opposite — it is one decision, and storing it as N cells is how
   * a four-instruction edit became 1,681 rows.
   */
  const ruleWouldBeBetter =
    operation === 'set' &&
    planned.length > 4 &&
    (originScope.startsWith('group:') ||
      destScope.startsWith('group:') ||
      originScope === '*' ||
      destScope === '*');
  const suffix = OPERATIONS.find((entry) => entry.value === operation)?.suffix ?? '';

  const apply = () => {
    setError(null);
    setDone(null);
    startTransition(async () => {
      try {
        await props.onApply(
          planned.map(({ mode: m, origin, destination, rate, value }) => ({
            mode: m,
            origin,
            destination,
            rate,
            value,
          })),
        );
        setDone(planned.length);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not apply that change.');
      }
    });
  };

  return (
    <div className="panel">
      <header>
        <h3>Change many lanes at once</h3>
        <span className="hint">Nothing is written until you have seen the preview</span>
      </header>
      <div className="body">
        <div className="selector" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="bulk-mode">Mode</label>
            <select
              id="bulk-mode"
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as StoredMode);
                setOriginScope('*');
                setDestScope('*');
                setDone(null);
              }}
            >
              <option value="surface">Surface</option>
              <option value="air">Air (NFO follows)</option>
              <option value="rail">Rail</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="bulk-origin">From</label>
            <select
              id="bulk-origin"
              value={originScope}
              onChange={(event) => {
                setOriginScope(event.target.value);
                setDone(null);
              }}
            >
              <option value="*">Every origin</option>
              <optgroup label="Groups">
                {ZONE_GROUPS.map((group) => (
                  <option key={group.key} value={`group:${group.key}`}>
                    {group.name} ({zonesInGroup(group.key, mode).length} zones)
                  </option>
                ))}
              </optgroup>
              <optgroup label="Single zone">
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          <span className="arrow">→</span>

          <div className="field">
            <label htmlFor="bulk-dest">To</label>
            <select
              id="bulk-dest"
              value={destScope}
              onChange={(event) => {
                setDestScope(event.target.value);
                setDone(null);
              }}
            >
              <option value="*">Every destination</option>
              <optgroup label="Groups">
                {ZONE_GROUPS.map((group) => (
                  <option key={group.key} value={`group:${group.key}`}>
                    {group.name} ({zonesInGroup(group.key, mode).length} zones)
                  </option>
                ))}
              </optgroup>
              <optgroup label="Single zone">
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>

        <div className="selector" style={{ marginBottom: 14 }}>
          <div className="field" style={{ minWidth: 250 }}>
            <label htmlFor="bulk-rates">Which rates</label>
            <select
              id="bulk-rates"
              value={rateScope}
              onChange={(event) => {
                setRateScope(event.target.value as RateKey | 'all' | 'tiers');
                setDone(null);
              }}
            >
              {RATE_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="bulk-op">Operation</label>
            <select
              id="bulk-op"
              value={operation}
              onChange={(event) => {
                setOperation(event.target.value as Operation);
                setDone(null);
              }}
            >
              {OPERATIONS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label} ({entry.suffix})
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ minWidth: 110 }}>
            <label htmlFor="bulk-amount">Amount {suffix}</label>
            <input
              id="bulk-amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setDone(null);
              }}
            />
          </div>

          <div className="field">
            <label htmlFor="bulk-intra">Include same-zone</label>
            <input
              id="bulk-intra"
              type="checkbox"
              checked={includeIntraZone}
              onChange={(event) => {
                setIncludeIntraZone(event.target.checked);
                setDone(null);
              }}
            />
          </div>
        </div>

        <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: '0 0 12px' }}>
          {(() => {
            const describe = (token: string, side: string) => {
              if (token === '*') return `every ${side}`;
              if (token.startsWith('group:')) {
                const group = ZONE_GROUPS.find((g) => g.key === token.slice(6));
                return group ? `${group.name} (${group.description})` : side;
              }
              return token;
            };
            return `From ${describe(originScope, 'origin')} to ${describe(destScope, 'destination')}.`;
          })()}
        </p>

        {ruleWouldBeBetter && (
          <div className="callout info" style={{ marginTop: 0, marginBottom: 12 }}>
            <strong>This is a rule, not {planned.length} cells.</strong>
            <p style={{ margin: '6px 0 0' }}>
              One price across a whole group is a single lane rule — four values, one review
              line, and it keeps meaning &ldquo;the West group&rdquo; when a zone is added to
              West later. Written as cells it is {planned.length} of them, and the intent is
              gone the moment they land. Build it on{' '}
              <a href={`/console/${props.cardKey}/geography`}>Smart geography</a> instead.
            </p>
          </div>
        )}

        <div className="preview-box">
          {done !== null ? (
            <>
              <span className="chip live">Applied</span>{' '}
              {done} rate{done === 1 ? '' : 's'} written to the draft. Review and submit them from
              the draft summary.
            </>
          ) : planned.length === 0 ? (
            <>Nothing would change with these settings.</>
          ) : (
            <>
              <span className="count">{planned.length}</span> rate
              {planned.length === 1 ? '' : 's'} across{' '}
              <strong>{new Set(planned.map((e) => `${e.origin}>${e.destination}`)).size}</strong>{' '}
              lane
              {new Set(planned.map((e) => `${e.origin}>${e.destination}`)).size === 1 ? '' : 's'}{' '}
              would change.
              <div className="pill-list">
                {planned.slice(0, 12).map((edit, index) => (
                  <span className="pill" key={index}>
                    {edit.origin}→{edit.destination} {edit.rate}: {edit.from} → {edit.value}
                  </span>
                ))}
                {planned.length > 12 && (
                  <span className="pill">…and {planned.length - 12} more</span>
                )}
              </div>
              {negatives.length > 0 && (
                <p style={{ color: 'var(--rejected)', margin: '10px 0 0', fontSize: 11.5 }}>
                  ⚠ {negatives.length} of these would land at zero or below, which cannot be
                  charged. Reduce the amount before applying.
                </p>
              )}
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
          <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
            Bulk changes land in the draft like any other edit, and still need approval.
          </span>
          <span className="spacer" />
          <button
            className="primary"
            onClick={apply}
            disabled={planned.length === 0 || negatives.length > 0 || pending}
          >
            {pending ? 'Applying…' : `Apply to ${planned.length} rate${planned.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
    </div>
  );
}
