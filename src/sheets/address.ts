/**
 * A1-style cell addressing.
 *
 * The grid shows column letters and row numbers and the name box shows the active
 * cell reference, so the team can keep saying "change D27" exactly as they do in
 * Excel today. Columns and rows are 1-based throughout, matching the spreadsheet.
 */

export interface Coordinate {
  column: number;
  row: number;
}

const REF_PATTERN = /^([A-Za-z]+)([1-9][0-9]*)$/;

/** 1 -> "A", 26 -> "Z", 27 -> "AA", 29 -> "AC". */
export function columnLetter(column: number): string {
  if (!Number.isInteger(column) || column < 1) {
    throw new Error(`invalid column number: ${column}`);
  }
  let remaining = column;
  let letters = '';
  while (remaining > 0) {
    const index = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + index) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

/** "A" -> 1, "AC" -> 29. Case-insensitive. */
export function columnNumber(letters: string): number {
  const upper = letters.toUpperCase();
  if (!/^[A-Z]+$/.test(upper)) {
    throw new Error(`invalid column letters: ${letters}`);
  }
  let column = 0;
  for (const character of upper) {
    column = column * 26 + (character.charCodeAt(0) - 64);
  }
  return column;
}

export function parseRef(ref: string): Coordinate {
  const match = REF_PATTERN.exec(ref.trim());
  if (!match) throw new Error(`invalid cell reference: ${ref}`);
  const [, letters, digits] = match;
  return { column: columnNumber(letters as string), row: Number(digits) };
}

export function formatRef(column: number, row: number): string {
  if (!Number.isInteger(row) || row < 1) throw new Error(`invalid row number: ${row}`);
  return `${columnLetter(column)}${row}`;
}

/** Moves `columns` right and `rows` down from an anchor reference. */
export function offsetRef(anchor: string, columns: number, rows: number): string {
  const { column, row } = parseRef(anchor);
  return formatRef(column + columns, row + rows);
}
