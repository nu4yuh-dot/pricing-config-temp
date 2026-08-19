'use client';

import { useState, useTransition } from 'react';

/**
 * Global charge parameters as a form.
 *
 * These are the highest-blast-radius values in the system — one of them reprices
 * every lane at once — so each is a labelled field with its unit, its effect stated,
 * and its live value shown for comparison.
 */

export interface ParamField {
  bind: string;
  label: string;
  unit: 'currency' | 'percent' | 'number';
  effect: string;
  value: number;
  liveValue: number;
  group: string;
}

const formatValue = (value: number, unit: ParamField['unit']): string =>
  unit === 'percent' ? String(Number((value * 100).toFixed(4))) : String(value);

const parseValue = (raw: string, unit: ParamField['unit']): number | null => {
  const trimmed = raw.trim().replace('%', '');
  if (trimmed === '') return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return null;
  return unit === 'percent' ? numeric / 100 : numeric;
};

export default function ParamsEditor(props: {
  fields: ParamField[];
  canEdit: boolean;
  /**
   * Show one group at a time behind tabs instead of stacking every panel.
   *
   * For a card with five or six groups and a hundred fields, stacking them is a very
   * long scroll. The save button stays global — it always writes every change across
   * every tab — so each tab carries its own count, and an edit you made two tabs ago
   * cannot be saved invisibly.
   */
  tabbed?: boolean;
  onSave: (edits: { bind: string; value: number | null }[]) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const shown = (field: ParamField): string =>
    field.bind in drafts ? (drafts[field.bind] as string) : formatValue(field.value, field.unit);

  const parsed = (field: ParamField): number | null => parseValue(shown(field), field.unit);

  const changed = props.fields.filter((field) => {
    const next = parsed(field);
    return next !== null && next !== field.value;
  });

  const groups = [...new Set(props.fields.map((field) => field.group))];
  const active = activeGroup ?? groups[0] ?? '';
  const shownGroups = props.tabbed ? groups.filter((group) => group === active) : groups;
  const changedIn = (group: string) =>
    changed.filter((field) => field.group === group).length;

  const save = () => {
    setError(null);
    startTransition(async () => {
      try {
        await props.onSave(changed.map((field) => ({ bind: field.bind, value: parsed(field) })));
        setDrafts({});
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save those changes.');
      }
    });
  };

  return (
    <>
      {props.tabbed && groups.length > 1 && (
        <div className="subtabs" role="tablist">
          {groups.map((group) => {
            const count = changedIn(group);
            return (
              <button
                key={group}
                role="tab"
                aria-selected={group === active}
                onClick={() => setActiveGroup(group)}
              >
                {group}
                {count > 0 && <span className="chip draft count">{count}</span>}
              </button>
            );
          })}
        </div>
      )}

      {shownGroups.map((group) => (
        <div className="panel" key={group}>
          <header>
            <h3>{group}</h3>
          </header>
          <div className="body">
            <div className="rate-fields">
              {props.fields
                .filter((field) => field.group === group)
                .map((field) => {
                  const next = parsed(field);
                  const isChanged = next !== null && next !== field.value;
                  const isDraft = field.value !== field.liveValue;
                  return (
                    <div
                      key={field.bind}
                      className={`rate-field${isChanged ? ' changed' : isDraft ? ' overridden' : ''}`}
                    >
                      <label htmlFor={field.bind}>
                        {field.label}{' '}
                        <span className="unit">
                          {field.unit === 'percent' ? '%' : field.unit === 'currency' ? '₹' : ''}
                        </span>
                      </label>
                      <input
                        id={field.bind}
                        inputMode="decimal"
                        value={shown(field)}
                        disabled={!props.canEdit}
                        onChange={(event) => {
                          setSaved(false);
                          setDrafts((current) => ({
                            ...current,
                            [field.bind]: event.target.value,
                          }));
                        }}
                      />
                      <div className="baseline">
                        {isChanged ? (
                          <>
                            was <strong>{formatValue(field.value, field.unit)}</strong>
                          </>
                        ) : isDraft ? (
                          <>live {formatValue(field.liveValue, field.unit)}</>
                        ) : (
                          field.effect
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      ))}

      {error && <div className="error">{error}</div>}

      {props.canEdit && (
        <div className="actionbar">
          {changed.length > 0 ? (
            <span className="chip draft count">
              {changed.length} parameter{changed.length === 1 ? '' : 's'} changed
            </span>
          ) : saved ? (
            <span className="chip live">Saved to draft</span>
          ) : (
            <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>No changes</span>
          )}
          <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
            Each of these reprices every lane on this card.
          </span>
          <span className="spacer" />
          {changed.length > 0 && (
            <button onClick={() => setDrafts({})} disabled={pending}>
              Revert
            </button>
          )}
          <button className="primary" onClick={save} disabled={changed.length === 0 || pending}>
            {pending ? 'Saving…' : 'Save to draft'}
          </button>
        </div>
      )}
    </>
  );
}
