'use client';

import { useMemo, useState, useTransition } from 'react';

/**
 * A discount — or an increase — applied across the money that is not a lane rate.
 *
 * Bulk changes moves lane grids, which is most of a repricing but not all of it. Cartage,
 * the docket fee and the ODA matrix are money too, and a "10% off" that quietly left them
 * alone would be a discount the customer does not actually receive in full.
 *
 * Grouped rather than per-cell on purpose: the ODA matrix alone is forty numbers, and
 * nobody discounts one band of it. The unit of decision is "the ODA matrix", so that is
 * the unit offered.
 */

export type ChargeOperation = 'decrease-pct' | 'increase-pct' | 'decrease-amount' | 'increase-amount';

const OPERATIONS: { value: ChargeOperation; label: string; suffix: string }[] = [
  { value: 'decrease-pct', label: 'Discount by', suffix: '%' },
  { value: 'increase-pct', label: 'Increase by', suffix: '%' },
  { value: 'decrease-amount', label: 'Reduce by', suffix: '₹' },
  { value: 'increase-amount', label: 'Increase by', suffix: '₹' },
];

/** One editable money value, already located by its bind path. */
export interface ChargeTarget {
  bind: string;
  value: number;
  /** The group this belongs to — the unit a person actually decides on. */
  group: string;
}

export interface ChargeGroup {
  key: string;
  label: string;
  hint: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function applyOperation(current: number, operation: ChargeOperation, amount: number): number {
  switch (operation) {
    case 'decrease-pct':
      return current * (1 - amount / 100);
    case 'increase-pct':
      return current * (1 + amount / 100);
    case 'decrease-amount':
      return current - amount;
    case 'increase-amount':
      return current + amount;
  }
}

export default function ChargeBulkEditor(props: {
  groups: ChargeGroup[];
  targets: ChargeTarget[];
  canEdit: boolean;
  onApply: (edits: { bind: string; value: number }[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [operation, setOperation] = useState<ChargeOperation>('decrease-pct');
  const [amount, setAmount] = useState('10');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const planned = useMemo(() => {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || selected.length === 0) return [];
    return props.targets
      .filter((target) => selected.includes(target.group))
      .map((target) => ({
        bind: target.bind,
        from: target.value,
        value: round2(applyOperation(target.value, operation, numeric)),
      }))
      .filter((edit) => edit.value !== edit.from);
  }, [props.targets, selected, operation, amount]);

  // A charge cannot go negative, and a zero cartage is almost always a mistake rather
  // than a giveaway. Both are shown before anything is written.
  const negatives = planned.filter((edit) => edit.value < 0);
  const zeroes = planned.filter((edit) => edit.value === 0);

  const suffix = OPERATIONS.find((entry) => entry.value === operation)?.suffix ?? '';

  const apply = () => {
    setError(null);
    setDone(null);
    startTransition(async () => {
      try {
        await props.onApply(planned.map(({ bind, value }) => ({ bind, value })));
        setDone(planned.length);
        setSelected([]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not apply that change.');
      }
    });
  };

  const countFor = (group: string) => props.targets.filter((t) => t.group === group).length;

  return (
    <div className="panel">
      <header>
        <h3>Discount the charges</h3>
        <span className="hint">Cartage, docket and ODA — the money that is not a lane rate</span>
      </header>
      <div className="body">
        <div className="selector" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="charge-op">Operation</label>
            <select
              id="charge-op"
              value={operation}
              onChange={(event) => {
                setOperation(event.target.value as ChargeOperation);
                setDone(null);
              }}
            >
              {OPERATIONS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="charge-amount">Amount {suffix}</label>
            <input
              id="charge-amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setDone(null);
              }}
            />
          </div>
        </div>

        <div className="pill-list" style={{ marginBottom: 14 }}>
          {props.groups.map((group) => {
            const count = countFor(group.key);
            return (
              <label key={group.key} title={group.hint}>
                <input
                  type="checkbox"
                  checked={selected.includes(group.key)}
                  disabled={!props.canEdit || count === 0}
                  onChange={() => {
                    setDone(null);
                    setSelected((current) =>
                      current.includes(group.key)
                        ? current.filter((entry) => entry !== group.key)
                        : [...current, group.key],
                    );
                  }}
                />
                {group.label} <span className="meta">{count}</span>
              </label>
            );
          })}
        </div>

        {planned.length > 0 && (
          <table className="data">
            <thead>
              <tr>
                <th>Value</th>
                <th className="num">Now</th>
                <th className="num">Becomes</th>
              </tr>
            </thead>
            <tbody>
              {planned.slice(0, 8).map((edit) => (
                <tr key={edit.bind}>
                  <td className="ref">{edit.bind}</td>
                  <td className="num">{edit.from}</td>
                  <td className="num">{edit.value}</td>
                </tr>
              ))}
              {planned.length > 8 && (
                <tr>
                  <td colSpan={3} style={{ color: 'var(--ink-faint)' }}>
                    …and {planned.length - 8} more
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {negatives.length > 0 && (
          <div className="error">
            {negatives.length} value{negatives.length === 1 ? '' : 's'} would go below zero. Reduce
            the amount, or choose fewer groups.
          </div>
        )}
        {negatives.length === 0 && zeroes.length > 0 && (
          <div className="callout">
            {zeroes.length} value{zeroes.length === 1 ? '' : 's'} would become zero. That is a
            charge waived entirely — deliberate is fine, accidental is not.
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>

      {props.canEdit && (
        <div className="actionbar">
          {done !== null ? (
            <span className="chip live">
              {done} value{done === 1 ? '' : 's'} written to the draft
            </span>
          ) : planned.length > 0 ? (
            <span className="chip draft count">{planned.length} values affected</span>
          ) : (
            <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
              Choose what to change
            </span>
          )}
          <span className="spacer" />
          <button
            className="primary"
            onClick={apply}
            disabled={planned.length === 0 || negatives.length > 0 || pending}
          >
            {pending ? 'Applying…' : 'Apply to draft'}
          </button>
        </div>
      )}
    </div>
  );
}
