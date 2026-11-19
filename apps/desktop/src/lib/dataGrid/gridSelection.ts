export type GridCellValue = string | number | boolean | null;

export interface CellPosition {
  rowIndex: number;
  colIndex: number;
}

export interface CellSelectionRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface SelectionData {
  columns: string[];
  rows: GridCellValue[][];
}

export interface CellSelectionMatrix extends SelectionData {
  rowIndexes: number[];
  columnIndexes: number[];
}

export interface SelectionSummary {
  cellCount: number;
  rowCount: number;
  numericCount: number;
  sum: number;
  nonNullCount: number;
  nullCount: number;
  distinctCount: number;
  avg: number | null;
  min: number | null;
  max: number | null;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

/** Formats selection summary numbers, normalizing `-0` and capping decimals at 6 digits. */
export function formatSelectionNumber(value: number): string {
  const normalized = normalizeZero(value);
  return Number.isInteger(normalized) ? String(normalized) : normalized.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** Builds a multi-line `key: value` text summary suitable for copying to the clipboard. */
export function formatSelectionSummaryText(
  summary: Partial<SelectionSummary> & { cellCount: number; rowCount: number },
  labels: {
    cells: string;
    rows: string;
    nonNull: string;
    nulls: string;
    distinct: string;
    numeric: string;
    sum: string;
    avg: string;
    min: string;
    max: string;
  },
): string {
  const lines = [
    `${labels.cells}: ${formatSelectionNumber(summary.cellCount)}`,
    `${labels.rows}: ${formatSelectionNumber(summary.rowCount)}`,
    `${labels.nonNull}: ${summary.nonNullCount != null ? formatSelectionNumber(summary.nonNullCount) : "-"}`,
    `${labels.nulls}: ${formatSelectionNumber(summary.nullCount ?? 0)}`,
    `${labels.distinct}: ${summary.distinctCount != null ? formatSelectionNumber(summary.distinctCount) : "-"}`,
  ];

  if ((summary.numericCount ?? 0) > 0) {
    lines.push(
      `${labels.numeric}: ${formatSelectionNumber(summary.numericCount!)}`,
      `${labels.sum}: ${summary.sum != null ? formatSelectionNumber(summary.sum) : "-"}`,
      `${labels.avg}: ${summary.avg != null ? formatSelectionNumber(summary.avg) : "-"}`,
      `${labels.min}: ${summary.min != null ? formatSelectionNumber(summary.min) : "-"}`,
      `${labels.max}: ${summary.max != null ? formatSelectionNumber(summary.max) : "-"}`,
    );
  }

  return lines.join("\n");
}

export function parseClipboardTable(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
  if (!normalized) return [[""]];
  return normalized.split("\n").map((row) => row.split("\t"));
}

export function normalizeSelectedColumnIndexes(columnIndexes: Iterable<number>): number[] {
  return [...new Set(columnIndexes)].filter((index) => index >= 0).sort((a, b) => a - b);
}

export function dedupeColumnIndexes(columnIndexes: Iterable<number>): number[] {
  // Deduplicate while preserving the first visible occurrence (insertion order)
  // instead of numeric order. Used by the copy/extractor path so drag-reordered
  // columns stay in the order the user sees them.
  return [...new Set(columnIndexes)].filter((index) => index >= 0);
}

export function normalizeSelectionRange(anchor: CellPosition, focus: CellPosition): CellSelectionRange {
  return {
    startRow: Math.min(anchor.rowIndex, focus.rowIndex),
    endRow: Math.max(anchor.rowIndex, focus.rowIndex),
    startCol: Math.min(anchor.colIndex, focus.colIndex),
    endCol: Math.max(anchor.colIndex, focus.colIndex),
  };
}

export function rowSelectionRange(rowIndex: number, columnCount: number, endRowIndex = rowIndex): CellSelectionRange | null {
  if (rowIndex < 0 || endRowIndex < 0 || columnCount <= 0) return null;
  return {
    startRow: Math.min(rowIndex, endRowIndex),
    endRow: Math.max(rowIndex, endRowIndex),
    startCol: 0,
    endCol: columnCount - 1,
  };
}

export function columnSelectionRange(rowCount: number, colIndex: number, endColIndex = colIndex): CellSelectionRange | null {
  if (rowCount <= 0 || colIndex < 0 || endColIndex < 0) return null;
  return {
    startRow: 0,
    endRow: rowCount - 1,
    startCol: Math.min(colIndex, endColIndex),
    endCol: Math.max(colIndex, endColIndex),
  };
}

export function allCellsSelectionRange(rowCount: number, columnCount: number): CellSelectionRange | null {
  if (rowCount <= 0 || columnCount <= 0) return null;
  return { startRow: 0, endRow: rowCount - 1, startCol: 0, endCol: columnCount - 1 };
}

export function isCellInSelection(rowIndex: number, colIndex: number, range: CellSelectionRange | null): boolean {
  if (!range) return false;
  return rowIndex >= range.startRow && rowIndex <= range.endRow && colIndex >= range.startCol && colIndex <= range.endCol;
}

export function extractSelection(columns: readonly string[], rows: readonly GridCellValue[][], range: CellSelectionRange | null): SelectionData {
  if (!range) return { columns: [], rows: [] };

  const selectedColumns = columns.slice(range.startCol, range.endCol + 1);
  const selectedRows = rows.slice(range.startRow, range.endRow + 1).map((row) => row.slice(range.startCol, range.endCol + 1));

  return { columns: selectedColumns, rows: selectedRows };
}

export function extractColumnsSelection(columns: readonly string[], rows: readonly GridCellValue[][], selectedColumnIndexes: Iterable<number>): SelectionData {
  const normalizedIndexes = normalizeSelectedColumnIndexes(selectedColumnIndexes).filter((index) => index < columns.length);
  if (normalizedIndexes.length === 0) return { columns: [], rows: [] };

  return {
    columns: normalizedIndexes.map((index) => columns[index]),
    rows: rows.map((row) => normalizedIndexes.map((index) => row[index] ?? null)),
  };
}

export function summarizeSelection(selection: SelectionData): SelectionSummary {
  let cellCount = 0;
  let nullCount = 0;
  let numericCount = 0;
  let sum = 0;
  let min: number | null = null;
  let max: number | null = null;
  // Track distinct non-null values by String(value), excluding null and undefined.
  const distinctValues = new Set<string>();

  for (const row of selection.rows) {
    for (const value of row) {
      cellCount += 1;
      if (value === null || value === undefined) {
        nullCount += 1;
        continue;
      }

      distinctValues.add(String(value));

      const numericValue = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
      if (Number.isFinite(numericValue)) {
        const normalized = normalizeZero(numericValue);
        numericCount += 1;
        sum += normalized;
        min = min === null ? normalized : Math.min(min, normalized);
        max = max === null ? normalized : Math.max(max, normalized);
      }
    }
  }

  const normalizedSum = normalizeZero(sum);

  return {
    cellCount,
    rowCount: selection.rows.length,
    numericCount,
    sum: normalizedSum,
    nonNullCount: cellCount - nullCount,
    nullCount,
    distinctCount: distinctValues.size,
    avg: numericCount > 0 ? normalizeZero(normalizedSum / numericCount) : null,
    min,
    max,
  };
}
