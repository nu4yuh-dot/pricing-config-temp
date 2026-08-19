'use client';

import { useState, useTransition } from 'react';

/**
 * A matrix of cells, each bound to a domain path.
 *
 * The console had a form for the parameters and a lane editor for the grids, but
 * several things on a card are neither: transit times, per-zone cartage and the ODA
 * matrix are all small tables. They were reachable only through the sheet UI, which
 * means removing that UI would leave them uneditable — and two of the three change a
 * quoted price.
 *
 * Deliberately generic. Every value in this system is a cell with a dotted path, so a
 * grid needs to know nothing about what it is editing: the page names the rows, the
 * columns and the bind for each intersection, and the diff, review and approval
 * machinery picks the changes up unaltered.
 */

export interface GridCellSpec {
  bind: string;
  value: string | number | null;
  liveValue: string | number | null;
  /** Text keeps what was typed; a number is parsed, and blank means `null`. */
  kind: 'number' | 'text';
  /**
   * How the number is written down versus how it is stored. A percentage is held as a
   * fraction — 0.45 — and a person types 45, so the two have to be told apart.
   */
  unit?: 'currency' | 'percent' | 'number';
  /** Shown when the cell is empty — e.g. what a blank transit time means. */
  placeholder?: string;
  title?: string;
}

export interface GridSpec {
  key: string;
  title: string;
  hint?: string;
  /** Column headings, left to right, after the row-label column. */
  columns: string[];
  /** The row label, then one cell per column. A `null` cell renders as a gap. */
  rows: { label: string; cells: (GridCellSpec | null)[] }[];
  /** Heading for the row-label column. */
  rowHeader: string;
  note?: string;
}

const shownValue = (cell: GridCellSpec): string => {
  if (cell.value === null) return '';
  if (cell.unit === 'percent' && typeof cell.value === 'number') {
    return String(Number((cell.value * 100).toFixed(4)));
  }
  return String(cell.value);
};

const parseCell = (raw: string, cell: GridCellSpec): string | number | null => {
  const trimmed = raw.trim().replace('%', '');
  if (trimmed === '') return null;
  if (cell.kind === 'text') return trimmed;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return null;
  return cell.unit === 'percent' ? numeric / 100 : numeric;
};

export default function GridEditor(props: {
  grids: GridSpec[];
  canEdit: boolean;
  /** What each change means, shown beside the save button. */
  consequence: string;
  /**
   * Show one grid at a time behind tabs. Saving still writes every change across every
   * tab, so each tab carries its own count and an edit made two tabs ago stays visible.
   */
  tabbed?: boolean;
  onSave: (edits: { bind: string; value: string | number | null }[]) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [activeGrid, setActiveGrid] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const allCells = props.grids.flatMap((grid) =>
    grid.rows.flatMap((row) => row.cells.filter((cell): cell is GridCellSpec => cell !== null)),
  );

  const shown = (cell: GridCellSpec): string =>
    cell.bind in drafts ? (drafts[cell.bind] as string) : shownValue(cell);

  const parsed = (cell: GridCellSpec): string | number | null => parseCell(shown(cell), cell);

  // A cell counts as changed only against the draft it started from, so re-typing the
  // same number is not an edit and does not reach the reviewer as a no-op line.
  const isChanged = (cell: GridCellSpec): boolean => parsed(cell) !== cell.value;

  const changed = allCells.filter(isChanged);

  const active = activeGrid ?? props.grids[0]?.key ?? '';
  const shownGrids = props.tabbed ? props.grids.filter((grid) => grid.key === active) : props.grids;
  const changedIn = (grid: GridSpec) =>
    grid.rows
      .flatMap((row) => row.cells.filter((cell): cell is GridCellSpec => cell !== null))
      .filter(isChanged).length;

  const save = () => {
    setError(null);
    startTransition(async () => {
      try {
        await props.onSave(changed.map((cell) => ({ bind: cell.bind, value: parsed(cell) })));
        setDrafts({});
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save those changes.');
      }
    });
  };

  return (
    <>
      {props.tabbed && props.grids.length > 1 && (
        <div className="subtabs" role="tablist">
          {props.grids.map((grid) => {
            const count = changedIn(grid);
            return (
              <button
                key={grid.key}
                role="tab"
                aria-selected={grid.key === active}
                onClick={() => setActiveGrid(grid.key)}
              >
                {grid.title}
                {count > 0 && <span className="chip draft count">{count}</span>}
              </button>
            );
          })}
        </div>
      )}

      {shownGrids.map((grid) => (
        <div className="panel" key={grid.key}>
          <header>
            <h3>{grid.title}</h3>
            {grid.hint && <span className="hint">{grid.hint}</span>}
          </header>
          <div className="body">
            <div className="gridscroll">
              <table className="data gridedit">
                <thead>
                  <tr>
                    <th>{grid.rowHeader}</th>
                    {grid.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.map((row) => (
                    <tr key={row.label}>
                      <td>
                        <strong>{row.label}</strong>
                      </td>
                      {row.cells.map((cell, index) => {
                        if (cell === null) {
                          return (
                            <td key={`${row.label}-${index}`} className="gap">
                              ·
                            </td>
                          );
                        }
                        const changedHere = isChanged(cell);
                        const overridden = !changedHere && cell.value !== cell.liveValue;
                        return (
                          <td
                            key={cell.bind}
                            className={changedHere ? 'changed' : overridden ? 'overridden' : ''}
                          >
                            <input
                              aria-label={cell.title ?? cell.bind}
                              title={
                                changedHere
                                  ? `was ${cell.value === null ? 'blank' : cell.value}`
                                  : overridden
                                    ? `live ${cell.liveValue === null ? 'blank' : cell.liveValue}`
                                    : cell.title
                              }
                              inputMode={cell.kind === 'number' ? 'decimal' : 'text'}
                              placeholder={cell.placeholder ?? ''}
                              value={shown(cell)}
                              disabled={!props.canEdit}
                              onChange={(event) => {
                                setSaved(false);
                                setDrafts((current) => ({
                                  ...current,
                                  [cell.bind]: event.target.value,
                                }));
                              }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {grid.note && (
              <p style={{ color: 'var(--ink-faint)', fontSize: 11.5, marginBottom: 0 }}>
                {grid.note}
              </p>
            )}
          </div>
        </div>
      ))}

      {error && <div className="error">{error}</div>}

      {props.canEdit && (
        <div className="actionbar">
          {changed.length > 0 ? (
            <span className="chip draft count">
              {changed.length} cell{changed.length === 1 ? '' : 's'} changed
            </span>
          ) : saved ? (
            <span className="chip live">Saved to draft</span>
          ) : (
            <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>No changes</span>
          )}
          <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>{props.consequence}</span>
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
