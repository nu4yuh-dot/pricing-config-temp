import { offsetRef, parseRef } from './address';
import type { Block, Cell, RenderedSheet, SheetSpec, BindPath } from './types';

/** Reads a dotted path. Returns undefined rather than throwing on a missing branch. */
export function getByPath(source: unknown, path: BindPath): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Writes a dotted path, returning a new object and sharing every untouched branch.
 * Edits go through this so a draft is never mutated in place — the previous value
 * has to stay readable to build the changeset diff.
 *
 * An array stays an array. Spreading one into an object literal turns `[10, 20]` into
 * `{0: 10, 1: 20}`, which reads identically by index and is not a list any more — and the
 * ODA matrix is walked by `.length`, so an edited band matrix silently stopped matching
 * and every out-of-area surcharge fell to zero. Nothing announced it, because an object
 * with numeric keys answers `rates[0][1]` perfectly well.
 */
export function setByPath<T>(source: T, path: BindPath, value: unknown): T {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return source;
  const container = (source ?? {}) as Record<string, unknown>;
  const nextValue =
    rest.length === 0 ? value : setByPath(container[head] ?? {}, rest.join('.'), value);

  if (Array.isArray(source)) {
    const copy = [...(source as unknown[])];
    copy[Number(head)] = nextValue;
    return copy as unknown as T;
  }
  return { ...container, [head]: nextValue } as T;
}

function put(sheet: RenderedSheet, cell: Cell): void {
  sheet.cells.set(cell.ref, cell);
  if (cell.editable && cell.bind) sheet.byBind.set(cell.bind, cell.ref);
  const { row, column } = parseRef(cell.ref);
  if (row > sheet.rows) sheet.rows = row;
  if (column > sheet.columns) sheet.columns = column;
}

const text = (ref: string, value: string, kind: Cell['kind'], span?: number): Cell => ({
  ref,
  kind,
  value,
  editable: false,
  ...(span === undefined ? {} : { span }),
});

/**
 * Columns from `ref` to the right-hand edge of the sheet.
 *
 * Prose cells span to the edge so they read the way they do in Excel, where a long
 * label simply runs across the empty cells beside it. Without this the text would
 * be clipped to one narrow column.
 */
function spanToEdge(ref: string, sheetColumns: number): number {
  return Math.max(sheetColumns - parseRef(ref).column + 1, 1);
}

function renderBlock(sheet: RenderedSheet, block: Block, data: unknown, sheetName: string): void {
  const edge = (ref: string) => spanToEdge(ref, sheet.columns);

  switch (block.type) {
    case 'title':
      put(sheet, text(block.at, block.text, 'title', edge(block.at)));
      return;

    case 'note':
      put(sheet, text(block.at, block.text, 'note', edge(block.at)));
      return;

    case 'notePanel': {
      put(sheet, text(block.at, block.title, 'header', edge(block.at)));
      block.lines.forEach((line, index) => {
        const ref = offsetRef(block.at, 0, index + 1);
        put(sheet, text(ref, line, 'note', edge(ref)));
      });
      return;
    }

    case 'terms': {
      put(sheet, text(block.at, block.title, 'header', edge(block.at)));
      block.lines.forEach((line, index) => {
        const ref = offsetRef(block.at, 0, index + 1);
        put(sheet, text(ref, line, 'note', edge(ref)));
      });
      return;
    }

    case 'matrix': {
      // Section title, then the header row, then one row per origin — the same
      // geometry the workbook uses to stack four matrices down one sheet.
      put(sheet, text(block.at, block.title, 'header', edge(block.at)));
      const headerRow = offsetRef(block.at, 0, 1);
      put(sheet, text(headerRow, block.corner ?? '', 'header'));
      block.colKeys.forEach((colKey, c) => {
        put(sheet, text(offsetRef(headerRow, c + 1, 0), colKey, 'header'));
      });

      block.rowKeys.forEach((rowKey, r) => {
        const rowRef = offsetRef(headerRow, 0, r + 1);
        put(sheet, text(rowRef, rowKey, 'rowLabel'));
        block.colKeys.forEach((colKey, c) => {
          const bind = `${block.bind}.${rowKey}.${colKey}`;
          const value = getByPath(data, bind);
          put(sheet, {
            ref: offsetRef(rowRef, c + 1, 0),
            kind: block.readOnly ? 'derived' : 'value',
            value: (value ?? null) as string | number | null,
            editable: !block.readOnly,
            bind,
            label: `${sheetName} · ${block.shortName ?? block.title} · ${rowKey}→${colKey}`,
            ...(block.format ? { format: block.format } : {}),
          });
        });
      });
      return;
    }

    case 'table': {
      put(sheet, text(block.at, block.rowHeader ?? '', 'header'));
      block.columns.forEach((column, c) => {
        put(sheet, text(offsetRef(block.at, c + 1, 0), column.header, 'header'));
      });

      block.rowKeys.forEach((rowKey, r) => {
        const rowRef = offsetRef(block.at, 0, r + 1);
        const rowLabel = block.rowLabels?.[rowKey] ?? rowKey;
        put(sheet, text(rowRef, rowLabel, 'rowLabel'));
        block.columns.forEach((column, c) => {
          const ref = offsetRef(rowRef, c + 1, 0);
          if (!column.field) {
            put(sheet, text(ref, column.values?.[rowKey] ?? '', 'rowLabel'));
            return;
          }
          const bind = `${block.bind}.${rowKey}.${column.field}`;
          const value = getByPath(data, bind);
          put(sheet, {
            ref,
            kind: column.readOnly ? 'derived' : 'value',
            value: (value ?? null) as string | number | null,
            editable: !column.readOnly,
            bind,
            label: `${sheetName} · ${column.header} · ${rowLabel}`,
            ...(column.format ? { format: column.format } : {}),
          });
        });
      });
      return;
    }

    case 'params': {
      if (block.title) put(sheet, text(block.at, block.title, 'header', edge(block.at)));
      block.rows.forEach((row, index) => {
        const rowRef = offsetRef(block.at, 0, index + 1);
        put(sheet, text(rowRef, row.label, 'rowLabel'));
        const value = getByPath(data, row.bind);
        put(sheet, {
          ref: offsetRef(rowRef, 1, 0),
          kind: row.readOnly ? 'derived' : 'value',
          value: (value ?? null) as string | number | null,
          editable: !row.readOnly,
          bind: row.bind,
          label: `${sheetName} · ${row.label}`,
          ...(row.format ? { format: row.format } : {}),
        });
        if (row.note) put(sheet, text(offsetRef(rowRef, 2, 0), row.note, 'note'));
      });
      return;
    }

    case 'bandMatrix': {
      const kmBands = (getByPath(data, block.rowBandsBind) ?? []) as number[];
      const weightBands = (getByPath(data, block.colBandsBind) ?? []) as number[];
      const rates = (getByPath(data, block.ratesBind) ?? []) as number[][];

      // Unlike the rate sheets, the source EDL matrix has no section-title row:
      // its header sits directly on the anchor. The title lives in a separate
      // title block above it.
      const headerRow = block.at;
      put(sheet, text(headerRow, block.rowHeader, 'header'));
      weightBands.forEach((band, c) => {
        put(sheet, {
          ref: offsetRef(headerRow, c + 1, 0),
          kind: 'value',
          value: band,
          editable: true,
          bind: `${block.colBandsBind}.${c}`,
          label: `${sheetName} · weight band ${c + 1} lower bound`,
          format: 'number',
        });
      });

      kmBands.forEach((km, r) => {
        const rowRef = offsetRef(headerRow, 0, r + 1);
        put(sheet, {
          ref: rowRef,
          kind: 'value',
          value: km,
          editable: true,
          bind: `${block.rowBandsBind}.${r}`,
          label: `${sheetName} · km band ${r + 1} lower bound`,
          format: 'number',
        });
        weightBands.forEach((band, c) => {
          put(sheet, {
            ref: offsetRef(rowRef, c + 1, 0),
            kind: 'value',
            value: rates[r]?.[c] ?? null,
            editable: true,
            bind: `${block.ratesBind}.${r}.${c}`,
            label: `${sheetName} · ${block.shortName ?? 'surcharge'} · from ${km} km · from ${band} kg`,
            format: 'currency',
          });
        });
      });
      return;
    }

    case 'derived': {
      put(sheet, text(block.at, block.title, 'title', edge(block.at)));
      if (block.note) {
        const ref = offsetRef(block.at, 0, 1);
        put(sheet, text(ref, block.note, 'note', edge(ref)));
      }
      return;
    }
  }
}

/**
 * Turn a spec plus a rate card's data into an addressable grid.
 *
 * The result is deliberately a flat map of cells rather than a nested structure:
 * the grid component needs random access by reference for keyboard navigation, and
 * the changeset builder needs to go from a domain path back to the cell an approver
 * would look at.
 */
export function renderSheet(spec: SheetSpec, data: unknown): RenderedSheet {
  const sheet: RenderedSheet = {
    id: spec.id,
    name: spec.name,
    columns: spec.columns,
    rows: 0,
    cells: new Map(),
    byBind: new Map(),
  };
  for (const block of spec.blocks) renderBlock(sheet, block, data, spec.name);
  return sheet;
}
