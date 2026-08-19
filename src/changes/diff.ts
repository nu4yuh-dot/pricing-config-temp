import { renderSheet, getByPath } from '../sheets/resolve';
import { parseRef } from '../sheets/address';
import { editableSpecsFor } from '../sheets/specs';
import type { RateCardData } from '../domain/types';
import type { BindPath } from '../sheets/types';
import { diffLaneRules } from './rule-diff';

export type CellValue = string | number | null;

export interface Change {
  bind: BindPath;
  /** Tab the cell lives on, for grouping the review. */
  sheet: string;
  /** A1 reference, so the reviewer can find it exactly where it has always been. */
  cellRef: string;
  /** Reads like "Surface Rates · min charge · PNQ→NCR". */
  label: string;
  oldValue: CellValue;
  newValue: CellValue;
  /** Null when a percentage is meaningless: text, or a lane appearing/disappearing. */
  pctChange: number | null;
}

/**
 * One editable cell, located and labelled.
 *
 * Walking the sheet specs rather than the raw data means the diff can only ever
 * report cells a person could actually have edited, and every entry arrives already
 * carrying the sheet, cell reference and label the approval queue needs.
 */
export interface EditableCell {
  bind: BindPath;
  sheet: string;
  cellRef: string;
  label: string;
  sheetOrder: number;
  row: number;
  column: number;
}

/**
 * The editable cell set depends on the data, not only on the specs: the EDL band
 * matrix grows and shrinks with the number of distance and weight bands defined.
 * Callers pass every version involved so that a band added or removed still shows
 * up as a change rather than silently disappearing from the comparison.
 */
export function allEditableCells(...versions: unknown[]): EditableCell[] {
  const byBind = new Map<BindPath, EditableCell>();

  // Some specs are built from the data — the UPS tabs are, because the agreement decides
  // how many zones and weight steps there are. Collect them across every version so a row
  // present in one and not the other still produces a line.
  const specs = new Map<string, ReturnType<typeof editableSpecsFor>[number]>();
  for (const version of versions) {
    for (const spec of editableSpecsFor(version)) specs.set(spec.id, spec);
  }

  [...specs.values()].forEach((spec, sheetOrder) => {
    for (const version of versions) {
      for (const cell of renderSheet(spec, version).cells.values()) {
        if (!cell.editable || !cell.bind || byBind.has(cell.bind)) continue;
        const { row, column } = parseRef(cell.ref);
        byBind.set(cell.bind, {
          bind: cell.bind,
          sheet: spec.name,
          cellRef: cell.ref,
          label: cell.label ?? cell.bind,
          sheetOrder,
          row,
          column,
        });
      }
    }
  });

  return [...byBind.values()].sort(
    (a, b) => a.sheetOrder - b.sheetOrder || a.row - b.row || a.column - b.column,
  );
}

function percentChange(oldValue: CellValue, newValue: CellValue): number | null {
  if (typeof oldValue !== 'number' || typeof newValue !== 'number') return null;
  if (oldValue === 0) return null;
  return ((newValue - oldValue) / Math.abs(oldValue)) * 100;
}

/**
 * Compare two versions of a card's data and return one entry per changed cell,
 * ordered the way a reviewer reads a spreadsheet: sheet by sheet, top to bottom.
 */
export function diffCardData(before: RateCardData, after: RateCardData): Change[] {
  const changes: Change[] = [];

  for (const cell of allEditableCells(before, after)) {
    const oldValue = (getByPath(before, cell.bind) ?? null) as CellValue;
    const newValue = (getByPath(after, cell.bind) ?? null) as CellValue;
    if (oldValue === newValue) continue;

    changes.push({
      bind: cell.bind,
      sheet: cell.sheet,
      cellRef: cell.cellRef,
      label: cell.label,
      oldValue,
      newValue,
      pctChange: percentChange(oldValue, newValue),
    });
  }

  // A lane rule lives at no A1 address, so the sheet walk above cannot see one. Without
  // this a rule would price a lane and reach production without a line of review.
  //
  // The UPS tariff used to need the same treatment for the same reason. It has its own
  // tabs now, built from the card in `sheets/specs/ups.ts`, so the walk finds it like any
  // other card — and running both produced two lines for one edit, which an approver could
  // have decided differently on each.
  return [...changes, ...diffLaneRules(before, after)];
}

/** Index by bind path, for validators that need to locate a cell they flagged. */
export function editableCellIndex(data: RateCardData): Map<BindPath, EditableCell> {
  return new Map(allEditableCells(data).map((cell) => [cell.bind, cell]));
}
