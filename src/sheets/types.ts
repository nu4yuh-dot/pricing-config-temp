/**
 * Declarative descriptions of the sixteen tabs.
 *
 * One spec drives three things at once: rendering the grid at the same
 * coordinates as the workbook, resolving `Surface Rates!J5` to a real address, and
 * labelling a changed cell well enough for an approver to judge it. See the design
 * spec §6.
 */

/** A dotted path into `RateCardData`, e.g. `grids.surface.minCharge.PNQ.NCR`. */
export type BindPath = string;

export type CellFormat = 'currency' | 'rate' | 'percent' | 'days' | 'number' | 'text';

/** A banner line, as in `A1` of every rate sheet. */
export interface TitleBlock {
  type: 'title';
  at: string;
  text: string;
  level?: 1 | 2;
}

/** A single line of explanatory prose. */
export interface NoteBlock {
  type: 'note';
  at: string;
  text: string;
}

/**
 * The "HOW TO READ" panels that sit to the right of each matrix in the source
 * (columns O and X). Reproduced in place rather than moved into tooltips.
 */
export interface NotePanelBlock {
  type: 'notePanel';
  at: string;
  title: string;
  lines: string[];
}

/**
 * An origin x destination grid. `at` is the section-title cell; the column header
 * row sits directly beneath it and data begins on the row after that, exactly as
 * the workbook stacks its four matrices.
 */
export interface MatrixBlock {
  type: 'matrix';
  at: string;
  title: string;
  rowKeys: readonly string[];
  colKeys: readonly string[];
  bind: BindPath;
  format?: CellFormat;
  /** Text for the top-left corner cell. The source uses `From\To`. */
  corner?: string;
  /** Human name for this grid in changeset labels, e.g. "min charge". */
  shortName?: string;
  readOnly?: boolean;
}

export interface TableColumn {
  header: string;
  /** Appended to the row's bind path. Omit for a computed or label-only column. */
  field?: string;
  format?: CellFormat;
  readOnly?: boolean;
  /** Values for a label-only column, keyed by row key. */
  values?: Record<string, string>;
}

/** A row-per-key table, as in `Pickup & Delivery` and `Cluster Guide`. */
export interface TableBlock {
  type: 'table';
  at: string;
  title?: string;
  rowKeys: readonly string[];
  columns: TableColumn[];
  /** Path to the record holding one entry per row key. */
  bind?: BindPath;
  rowHeader?: string;
}

export interface ParamRow {
  label: string;
  bind: BindPath;
  note?: string;
  format?: CellFormat;
  readOnly?: boolean;
}

/**
 * The `Charges & Terms` parameter list. The source held three columns — label, a
 * stale display copy, and the authoritative editable value — which disagreed with
 * each other. Here the value column is the only one.
 */
export interface ParamsBlock {
  type: 'params';
  at: string;
  title?: string;
  rows: ParamRow[];
}

/**
 * The EDL matrix: rows are km thresholds, columns weight thresholds, and both sets
 * of band edges are themselves editable.
 */
export interface BandMatrixBlock {
  type: 'bandMatrix';
  /**
   * The header row itself. Unlike `MatrixBlock`, this block has no section-title
   * row of its own — use a separate `TitleBlock` above it, as the source does.
   */
  at: string;
  rowBandsBind: BindPath;
  colBandsBind: BindPath;
  ratesBind: BindPath;
  rowHeader: string;
  colHeaderSuffix?: string;
  shortName?: string;
}

/** Numbered terms prose, as in `Charges & Terms` rows 20-28. */
export interface TermsBlock {
  type: 'terms';
  at: string;
  title: string;
  lines: string[];
}

/** A read-only region computed by the pricing engine rather than stored. */
export interface DerivedBlock {
  type: 'derived';
  at: string;
  title: string;
  /** Names the derived view so the page can render it; carries no stored data. */
  view: 'rateCalculator' | 'exOriginRateCard' | 'allInQuote' | 'nfoRates';
  note?: string;
}

export type Block =
  | TitleBlock
  | NoteBlock
  | NotePanelBlock
  | MatrixBlock
  | TableBlock
  | ParamsBlock
  | BandMatrixBlock
  | TermsBlock
  | DerivedBlock;

export interface SheetSpec {
  id: string;
  name: string;
  /**
   * Which source's cards this tab belongs on. Absent means the DNS cards.
   *
   * A tab is only shown, and only editable, on a card of its own source — otherwise
   * Bluedart Rates would appear blank on a DNS card, and editing it there would write
   * franchise rates onto a card that does not price them.
   */
  source?: 'dns' | 'bluedart';
  /** Widest column the sheet uses, so the grid renders the same envelope as Excel. */
  columns: number;
  blocks: Block[];
  /** True for tabs whose contents the engine computes. */
  derived?: boolean;
}

export type CellKind =
  | 'blank'
  | 'title'
  | 'note'
  | 'header'
  | 'rowLabel'
  | 'value'
  | 'derived';

export interface Cell {
  ref: string;
  kind: CellKind;
  value: string | number | null;
  editable: boolean;
  bind?: BindPath;
  /** Reads like "Surface Rates · min charge · PNQ→NCR" in a changeset. */
  label?: string;
  format?: CellFormat;
  /** Columns this cell spans, for the merged banner rows. */
  span?: number;
}

export interface RenderedSheet {
  id: string;
  name: string;
  columns: number;
  rows: number;
  cells: Map<string, Cell>;
  /** Reverse index: domain path to the cell that edits it. */
  byBind: Map<BindPath, string>;
}
