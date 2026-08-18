'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { columnLetter, formatRef, parseRef } from '../sheets/address';
import type { CellFormat, CellKind } from '../sheets/types';

/**
 * A spreadsheet grid, built rather than borrowed.
 *
 * Off-the-shelf grids fight this specific combination: A1 addressing, four matrix
 * blocks stacked on one sheet with prose panels at fixed coordinates, per-cell
 * approval state, and Excel's exact keyboard semantics. Building it is less work
 * than bending a library, and it does not cap fidelity.
 */

export interface GridCell {
  ref: string;
  kind: CellKind;
  value: string | number | null;
  editable: boolean;
  bind?: string;
  label?: string;
  format?: CellFormat;
  span?: number;
}

export interface SheetGridProps {
  cells: GridCell[];
  columns: number;
  rows: number;
  /** Live (approved) values, so unsubmitted edits can be marked as changed. */
  liveValues?: Record<string, string | number | null>;
  /** Bind paths currently awaiting approval. */
  pendingBinds?: string[];
  /** Bind paths a reviewer rejected, with their comments. */
  rejectedBinds?: Record<string, string>;
  /** Bind paths carrying a validation warning, with the message. */
  flaggedBinds?: Record<string, string>;
  /** False when the sheet is read-only for this user or frozen for review. */
  canEdit: boolean;
  /** Why editing is unavailable, shown in the status bar. */
  lockReason?: string;
  onCommit?: (edits: { bind: string; value: string | number | null }[]) => Promise<void> | void;
}

interface Coord {
  row: number;
  column: number;
}

const DEFAULT_COL_WIDTH = 74;
const LABEL_COL_WIDTH = 128;
/** Must match --gutter-w in globals.css. */
const GUTTER_WIDTH = 44;

function formatValue(value: string | number | null, format?: CellFormat): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  switch (format) {
    case 'percent':
      // Stored as a fraction; shown the way the team says it out loud.
      return `${Number((value * 100).toFixed(4))}%`;
    case 'currency':
      return value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    case 'days':
      return String(value);
    default:
      return String(value);
  }
}

/** Turn typed text back into a stored value, undoing the display formatting. */
function parseInput(raw: string, format?: CellFormat): string | number | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-' || trimmed === '—') return null;

  if (format === 'text') return trimmed;

  const isPercent = trimmed.endsWith('%');
  const numeric = Number(trimmed.replace(/[%,\s]/g, ''));
  if (Number.isNaN(numeric)) return trimmed;
  if (format === 'percent') return isPercent ? numeric / 100 : numeric;
  return numeric;
}

export default function SheetGrid(props: SheetGridProps) {
  const {
    cells,
    columns,
    rows,
    liveValues = {},
    pendingBinds = [],
    rejectedBinds = {},
    flaggedBinds = {},
    canEdit,
    lockReason,
    onCommit,
  } = props;

  const byRef = useMemo(() => new Map(cells.map((cell) => [cell.ref, cell])), [cells]);
  const pending = useMemo(() => new Set(pendingBinds), [pendingBinds]);

  /** Local unsaved edits, keyed by cell reference. */
  const [edits, setEdits] = useState<Map<string, string | number | null>>(new Map());
  const [active, setActive] = useState<Coord>({ row: 1, column: 1 });
  const [anchor, setAnchor] = useState<Coord | null>(null);
  const [editing, setEditing] = useState<{ ref: string; draft: string } | null>(null);
  const [undoStack, setUndoStack] = useState<Map<string, string | number | null>[]>([]);
  const [redoStack, setRedoStack] = useState<Map<string, string | number | null>[]>([]);
  const [saving, setSaving] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);

  const activeRef = formatRef(active.column, active.row);
  const activeCell = byRef.get(activeRef);

  const valueAt = useCallback(
    (ref: string): string | number | null => {
      if (edits.has(ref)) return edits.get(ref) ?? null;
      return byRef.get(ref)?.value ?? null;
    },
    [edits, byRef],
  );

  /** Column widths: label columns are wider, as they hold zone names and prose. */
  const widths = useMemo(() => {
    const result: number[] = [];
    for (let column = 1; column <= columns; column++) {
      let width = DEFAULT_COL_WIDTH;
      for (let row = 1; row <= Math.min(rows, 40); row++) {
        const cell = byRef.get(formatRef(column, row));
        if (cell && (cell.kind === 'rowLabel' || cell.format === 'text')) {
          width = LABEL_COL_WIDTH;
          break;
        }
      }
      result.push(width);
    }
    return result;
  }, [byRef, columns, rows]);

  const pushUndo = useCallback(
    (snapshot: Map<string, string | number | null>) => {
      setUndoStack((stack) => [...stack.slice(-49), snapshot]);
      setRedoStack([]);
    },
    [],
  );

  const applyEdits = useCallback(
    (entries: [string, string | number | null][]) => {
      if (entries.length === 0) return;
      setEdits((current) => {
        pushUndo(new Map(current));
        const next = new Map(current);
        for (const [ref, value] of entries) {
          const cell = byRef.get(ref);
          if (!cell?.editable) continue;
          next.set(ref, value);
        }
        return next;
      });
    },
    [byRef, pushUndo],
  );

  const move = useCallback(
    (dRow: number, dColumn: number, extendSelection = false) => {
      setActive((current) => {
        const next = {
          row: Math.min(Math.max(current.row + dRow, 1), rows),
          column: Math.min(Math.max(current.column + dColumn, 1), columns),
        };
        if (extendSelection) {
          setAnchor((existing) => existing ?? current);
        } else {
          setAnchor(null);
        }
        return next;
      });
    },
    [rows, columns],
  );

  const beginEdit = useCallback(
    (seed?: string) => {
      if (!canEdit) return;
      const cell = byRef.get(activeRef);
      if (!cell?.editable) return;
      const current = valueAt(activeRef);
      setEditing({
        ref: activeRef,
        draft: seed ?? (current === null ? '' : formatValue(current, cell.format)),
      });
    },
    [activeRef, byRef, canEdit, valueAt],
  );

  const commitEdit = useCallback(
    (advance: 'down' | 'right' | 'none' = 'down') => {
      if (!editing) return;
      const cell = byRef.get(editing.ref);
      if (cell?.editable) {
        applyEdits([[editing.ref, parseInput(editing.draft, cell.format)]]);
      }
      setEditing(null);
      if (advance === 'down') move(1, 0);
      if (advance === 'right') move(0, 1);
    },
    [editing, byRef, applyEdits, move],
  );

  /** The rectangle between the anchor and the active cell. */
  const range = useMemo(() => {
    if (!anchor) return null;
    return {
      top: Math.min(anchor.row, active.row),
      bottom: Math.max(anchor.row, active.row),
      left: Math.min(anchor.column, active.column),
      right: Math.max(anchor.column, active.column),
    };
  }, [anchor, active]);

  const rangeRefs = useCallback((): string[] => {
    if (!range) return [activeRef];
    const refs: string[] = [];
    for (let row = range.top; row <= range.bottom; row++) {
      for (let column = range.left; column <= range.right; column++) {
        refs.push(formatRef(column, row));
      }
    }
    return refs;
  }, [range, activeRef]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;

      if (editing) {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitEdit('down');
        } else if (event.key === 'Tab') {
          event.preventDefault();
          commitEdit('right');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setEditing(null);
        }
        return;
      }

      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        setUndoStack((stack) => {
          if (stack.length === 0) return stack;
          const previous = stack[stack.length - 1] as Map<string, string | number | null>;
          setRedoStack((redo) => [...redo, new Map(edits)]);
          setEdits(previous);
          return stack.slice(0, -1);
        });
        return;
      }

      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        setRedoStack((stack) => {
          if (stack.length === 0) return stack;
          const next = stack[stack.length - 1] as Map<string, string | number | null>;
          setUndoStack((undo) => [...undo, new Map(edits)]);
          setEdits(next);
          return stack.slice(0, -1);
        });
        return;
      }

      if (meta && event.key.toLowerCase() === 'c') {
        // Tab-separated, so a copied range pastes straight into Excel.
        const refs = rangeRefs();
        const grouped = new Map<number, string[]>();
        for (const ref of refs) {
          const { row } = parseRef(ref);
          if (!grouped.has(row)) grouped.set(row, []);
          const cell = byRef.get(ref);
          grouped.get(row)?.push(formatValue(valueAt(ref), cell?.format));
        }
        const text = [...grouped.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, values]) => values.join('\t'))
          .join('\n');
        void navigator.clipboard?.writeText(text);
        return;
      }

      if (meta && event.key.toLowerCase() === 'd') {
        // Fill down from the top row of the selection.
        event.preventDefault();
        if (!range) return;
        const entries: [string, string | number | null][] = [];
        for (let column = range.left; column <= range.right; column++) {
          const source = valueAt(formatRef(column, range.top));
          for (let row = range.top + 1; row <= range.bottom; row++) {
            entries.push([formatRef(column, row), source]);
          }
        }
        applyEdits(entries);
        return;
      }

      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault();
          move(-1, 0, event.shiftKey);
          return;
        case 'ArrowDown':
          event.preventDefault();
          move(1, 0, event.shiftKey);
          return;
        case 'ArrowLeft':
          event.preventDefault();
          move(0, -1, event.shiftKey);
          return;
        case 'ArrowRight':
          event.preventDefault();
          move(0, 1, event.shiftKey);
          return;
        case 'Tab':
          event.preventDefault();
          move(0, event.shiftKey ? -1 : 1);
          return;
        case 'Enter':
          event.preventDefault();
          if (canEdit && byRef.get(activeRef)?.editable) beginEdit();
          else move(1, 0);
          return;
        case 'F2':
          event.preventDefault();
          beginEdit();
          return;
        case 'Escape':
          setAnchor(null);
          return;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          if (!canEdit) return;
          applyEdits(rangeRefs().map((ref) => [ref, null]));
          return;
        case 'Home':
          event.preventDefault();
          setActive((current) => ({ ...current, column: 1 }));
          return;
        default:
          break;
      }

      // Type-to-replace: printable characters open the editor with that character.
      if (!meta && event.key.length === 1 && canEdit) {
        const cell = byRef.get(activeRef);
        if (cell?.editable) {
          event.preventDefault();
          beginEdit(event.key);
        }
      }
    },
    [
      editing,
      commitEdit,
      edits,
      rangeRefs,
      byRef,
      valueAt,
      range,
      applyEdits,
      move,
      canEdit,
      activeRef,
      beginEdit,
    ],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      if (!canEdit) return;
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;
      event.preventDefault();

      const grid = text.replace(/\r/g, '').split('\n').map((line) => line.split('\t'));
      const entries: [string, string | number | null][] = [];
      grid.forEach((line, rowOffset) => {
        line.forEach((raw, columnOffset) => {
          const ref = formatRef(active.column + columnOffset, active.row + rowOffset);
          const cell = byRef.get(ref);
          if (!cell?.editable) return;
          entries.push([ref, parseInput(raw, cell.format)]);
        });
      });
      applyEdits(entries);
    },
    [active, byRef, applyEdits, canEdit],
  );

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  /**
   * Keep the active cell in view when navigating by keyboard — but never on first
   * render. A1 usually holds a banner spanning the whole sheet, and asking the
   * browser to bring a 2000px-wide cell into view scrolls the grid sideways, which
   * hides column A under the sticky row-number gutter. Wide cells are also skipped
   * for the same reason.
   */
  const hasNavigated = useRef(false);
  useEffect(() => {
    if (!hasNavigated.current) {
      hasNavigated.current = true;
      return;
    }
    const element = wrapRef.current?.querySelector<HTMLElement>(`[data-ref="${activeRef}"]`);
    if (!element) return;
    const spansWide = (byRef.get(activeRef)?.span ?? 1) > 1;
    element.scrollIntoView({ block: 'nearest', ...(spansWide ? {} : { inline: 'nearest' }) });
  }, [activeRef, byRef]);

  const dirtyRefs = useMemo(() => {
    const result = new Set<string>();
    for (const [ref, value] of edits) {
      const cell = byRef.get(ref);
      const baseline = cell?.bind ? liveValues[cell.bind] : cell?.value;
      if (value !== (baseline ?? null)) result.add(ref);
    }
    return result;
  }, [edits, byRef, liveValues]);

  const save = async () => {
    if (!onCommit || dirtyRefs.size === 0) return;
    setSaving(true);
    try {
      const payload = [...dirtyRefs]
        .map((ref) => {
          const cell = byRef.get(ref);
          return cell?.bind ? { bind: cell.bind, value: edits.get(ref) ?? null } : null;
        })
        .filter((entry): entry is { bind: string; value: string | number | null } => entry !== null);
      await onCommit(payload);
      setEdits(new Map());
      setUndoStack([]);
      setRedoStack([]);
    } finally {
      setSaving(false);
    }
  };

  const editorGeometry = editing
    ? (() => {
        const element = wrapRef.current?.querySelector<HTMLElement>(`[data-ref="${editing.ref}"]`);
        if (!element || !wrapRef.current) return null;
        const cellBox = element.getBoundingClientRect();
        const wrapBox = wrapRef.current.getBoundingClientRect();
        return {
          left: cellBox.left - wrapBox.left + wrapRef.current.scrollLeft,
          top: cellBox.top - wrapBox.top + wrapRef.current.scrollTop,
          width: cellBox.width,
          height: cellBox.height,
        };
      })()
    : null;

  return (
    <>
      <div className="toolbar">
        <span className="namebox" title="Active cell">
          {activeRef}
        </span>
        <div className="valuebar">
          <span className="fx">=</span>
          {activeCell?.label ? (
            <>
              <strong>{activeCell.label}</strong>
              {' — '}
              {formatValue(valueAt(activeRef), activeCell.format) || '(empty)'}
            </>
          ) : (
            formatValue(valueAt(activeRef), activeCell?.format) || '(empty)'
          )}
        </div>
        {onCommit && (
          <button
            className="primary"
            onClick={save}
            disabled={dirtyRefs.size === 0 || saving || !canEdit}
          >
            {saving ? 'Saving…' : `Save ${dirtyRefs.size || ''} to draft`}
          </button>
        )}
      </div>

      <div
        className="gridwrap"
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        role="grid"
        aria-label="Rate card sheet"
      >
        {/*
          `table-layout: fixed` only takes effect when the table has a definite
          width; left to `auto` the browser silently falls back to auto layout and
          a long prose cell stretches its whole column. The total is stated here.
        */}
        <table
          className="grid"
          style={{ width: widths.reduce((total, width) => total + width, GUTTER_WIDTH) }}
        >
          <colgroup>
            <col style={{ width: GUTTER_WIDTH }} />
            {widths.map((width, index) => (
              <col key={index} style={{ width: `${width}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="corner" />
              {widths.map((_, index) => (
                <th
                  key={index}
                  className={active.column === index + 1 ? 'active-col' : undefined}
                  scope="col"
                >
                  {columnLetter(index + 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, rowIndex) => {
              const row = rowIndex + 1;
              return (
                <tr key={row}>
                  <th
                    className={`rownum${active.row === row ? ' active-row' : ''}`}
                    scope="row"
                  >
                    {row}
                  </th>
                  {widths.map((_, columnIndex) => {
                    const column = columnIndex + 1;
                    const ref = formatRef(column, row);
                    const cell = byRef.get(ref);
                    const value = valueAt(ref);
                    const bind = cell?.bind;

                    const isActive = active.row === row && active.column === column;
                    const inRange =
                      range !== null &&
                      row >= range.top &&
                      row <= range.bottom &&
                      column >= range.left &&
                      column <= range.right;

                    const classes = ['cell'];
                    if (cell) classes.push(`k-${cell.kind}`);
                    if (cell?.span && cell.span > 1) classes.push('spanned');
                    if (cell?.editable) classes.push(canEdit ? 'editable' : 'locked');
                    if (cell?.format === 'text') classes.push('text-cell');
                    if (value === null && cell?.kind === 'value') classes.push('unavailable');
                    if (dirtyRefs.has(ref)) classes.push('dirty');
                    if (bind && pending.has(bind)) classes.push('pending');
                    if (bind && rejectedBinds[bind]) classes.push('rejected');
                    if (bind && flaggedBinds[bind]) classes.push('flagged');
                    if (inRange && !isActive) classes.push('in-range');
                    if (isActive) classes.push('active');

                    const title = [
                      cell?.label,
                      bind && flaggedBinds[bind] ? `⚠ ${flaggedBinds[bind]}` : null,
                      bind && rejectedBinds[bind] ? `Rejected: ${rejectedBinds[bind]}` : null,
                      bind && pending.has(bind) ? 'Awaiting approval' : null,
                    ]
                      .filter(Boolean)
                      .join('\n');

                    return (
                      <td
                        key={column}
                        data-ref={ref}
                        className={classes.join(' ')}
                        colSpan={cell?.span && cell.span > 1 ? cell.span : undefined}
                        title={title || undefined}
                        onMouseDown={(event) => {
                          if (event.shiftKey) setAnchor(active);
                          else setAnchor(null);
                          setActive({ row, column });
                          setEditing(null);
                          wrapRef.current?.focus();
                        }}
                        onDoubleClick={() => {
                          setActive({ row, column });
                          beginEdit();
                        }}
                      >
                        {value === null && cell?.kind === 'value'
                          ? '-'
                          : formatValue(value, cell?.format)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>

        {editing && editorGeometry && (
          <input
            ref={editorRef}
            className="cell-editor"
            style={{
              left: editorGeometry.left,
              top: editorGeometry.top,
              width: editorGeometry.width,
              height: editorGeometry.height,
            }}
            value={editing.draft}
            onChange={(event) => setEditing({ ref: editing.ref, draft: event.target.value })}
            onBlur={() => commitEdit('none')}
          />
        )}
      </div>

      <div className="statusbar">
        <span>
          {activeRef}
          {range ? ` · ${range.bottom - range.top + 1}×${range.right - range.left + 1} selected` : ''}
        </span>
        {dirtyRefs.size > 0 && (
          <span className="chip draft count">{dirtyRefs.size} unsaved</span>
        )}
        {pending.size > 0 && (
          <span className="chip pending count">{pending.size} awaiting approval</span>
        )}
        {!canEdit && lockReason && <span>{lockReason}</span>}
        <span className="spacer" />
        <span>
          <kbd>↑↓←→</kbd> move · <kbd>Enter</kbd> edit · <kbd>F2</kbd> edit ·{' '}
          <kbd>Tab</kbd> next · <kbd>⌘D</kbd> fill down · <kbd>⌘Z</kbd> undo ·{' '}
          <kbd>Del</kbd> clear
        </span>
      </div>
    </>
  );
}
