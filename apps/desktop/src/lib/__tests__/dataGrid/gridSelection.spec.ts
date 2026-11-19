import { describe, expect, it } from "vitest";
import { dedupeColumnIndexes, formatSelectionNumber, formatSelectionSummaryText, summarizeSelection, type GridCellValue } from "@/lib/dataGrid/gridSelection";

const SUMMARY_LABELS = {
  cells: "Cells",
  rows: "Rows",
  nonNull: "Non-null",
  nulls: "NULL",
  distinct: "Distinct",
  numeric: "Numeric",
  sum: "SUM",
  avg: "AVG",
  min: "MIN",
  max: "MAX",
};

describe("gridSelection", () => {
  it("summarizes empty selections", () => {
    expect(summarizeSelection({ columns: [], rows: [] })).toEqual({
      cellCount: 0,
      rowCount: 0,
      numericCount: 0,
      sum: 0,
      nonNullCount: 0,
      nullCount: 0,
      distinctCount: 0,
      avg: null,
      min: null,
      max: null,
    });
  });

  it("summarizes numeric selections", () => {
    expect(
      summarizeSelection({
        columns: ["a", "b"],
        rows: [
          [1, 2],
          [3, 4],
        ],
      }),
    ).toEqual({
      cellCount: 4,
      rowCount: 2,
      numericCount: 4,
      sum: 10,
      nonNullCount: 4,
      nullCount: 0,
      distinctCount: 4,
      avg: 2.5,
      min: 1,
      max: 4,
    });
  });

  it("summarizes numeric strings and ignores non-numeric values", () => {
    expect(
      summarizeSelection({
        columns: ["id", "value", "flag"],
        rows: [
          ["100", 2.5, true],
          [null, "not a number", 3],
        ],
      }),
    ).toEqual({
      cellCount: 6,
      rowCount: 2,
      numericCount: 3,
      sum: 105.5,
      nonNullCount: 5,
      nullCount: 1,
      distinctCount: 5,
      avg: 105.5 / 3,
      min: 2.5,
      max: 100,
    });
  });

  it("returns null numeric stats when no finite numeric values are selected", () => {
    const summary = summarizeSelection({
      columns: ["a", "b"],
      rows: [
        [null, undefined as unknown as GridCellValue],
        ["", "   "],
        [false, Number.NaN],
        [Number.POSITIVE_INFINITY, "text"],
      ],
    });

    expect(summary).toEqual({
      cellCount: 8,
      rowCount: 4,
      numericCount: 0,
      sum: 0,
      nonNullCount: 6,
      nullCount: 2,
      distinctCount: 6,
      avg: null,
      min: null,
      max: null,
    });
  });

  it("tracks distinct non-null values by String(value) and excludes nulls", () => {
    const summary = summarizeSelection({
      columns: ["a", "b", "c"],
      rows: [
        [100, "100", null],
        [true, "true", undefined as unknown as GridCellValue],
        ["", "", null],
      ],
    });

    expect(summary).toEqual({
      cellCount: 9,
      rowCount: 3,
      numericCount: 2,
      sum: 200,
      nonNullCount: 6,
      nullCount: 3,
      distinctCount: 3,
      avg: 100,
      min: 100,
      max: 100,
    });
  });

  it("normalizes -0 to 0 across sum, avg, min, and max", () => {
    const summary = summarizeSelection({
      columns: ["n"],
      rows: [[-0], [-0]],
    });

    expect(summary).toEqual({
      cellCount: 2,
      rowCount: 2,
      numericCount: 2,
      sum: 0,
      nonNullCount: 2,
      nullCount: 0,
      distinctCount: 1,
      avg: 0,
      min: 0,
      max: 0,
    });
    expect(Object.is(summary.sum, -0)).toBe(false);
    expect(Object.is(summary.avg, -0)).toBe(false);
    expect(Object.is(summary.min, -0)).toBe(false);
    expect(Object.is(summary.max, -0)).toBe(false);
  });

  it("formats selection numbers cleanly and caps decimal precision", () => {
    expect(formatSelectionNumber(-0)).toBe("0");
    expect(formatSelectionNumber(0)).toBe("0");
    expect(formatSelectionNumber(1000)).toBe("1000");
    expect(formatSelectionNumber(-42)).toBe("-42");
    expect(formatSelectionNumber(12.3456789)).toBe((12.3456789).toLocaleString(undefined, { maximumFractionDigits: 6 }));
  });

  it("formats full numeric selection summary text for clipboard copying", () => {
    const summary = summarizeSelection({
      columns: ["amount"],
      rows: [[10], [20], [null], [30]],
    });

    expect(formatSelectionSummaryText(summary, SUMMARY_LABELS)).toBe(["Cells: 4", "Rows: 4", "Non-null: 3", "NULL: 1", "Distinct: 3", "Numeric: 3", "SUM: 60", "AVG: 20", "MIN: 10", "MAX: 30"].join("\n"));
  });

  it("omits numeric section in formatted text when numericCount is 0", () => {
    const summary = summarizeSelection({
      columns: ["name"],
      rows: [["alice"], ["bob"], [null]],
    });

    expect(formatSelectionSummaryText(summary, SUMMARY_LABELS)).toBe(["Cells: 3", "Rows: 3", "Non-null: 2", "NULL: 1", "Distinct: 2"].join("\n"));
  });

  it("formats partial summaries and zero-valued numeric summaries safely", () => {
    expect(formatSelectionSummaryText({ cellCount: 4, rowCount: 2 }, SUMMARY_LABELS)).toBe(["Cells: 4", "Rows: 2", "Non-null: -", "NULL: 0", "Distinct: -"].join("\n"));

    expect(formatSelectionSummaryText({ cellCount: 2, rowCount: 1, nonNullCount: 2, nullCount: 0, distinctCount: 1, numericCount: 2, sum: 0, avg: 0, min: 0, max: 0 }, SUMMARY_LABELS)).toBe(
      ["Cells: 2", "Rows: 1", "Non-null: 2", "NULL: 0", "Distinct: 1", "Numeric: 2", "SUM: 0", "AVG: 0", "MIN: 0", "MAX: 0"].join("\n"),
    );
  });

  it("dedupeColumnIndexes preserves the first visible occurrence instead of sorting", () => {
    // After drag-reordering, visible order is [2, 0, 1]; extraction must keep it,
    // not revert to numeric [0, 1, 2].
    expect(dedupeColumnIndexes([2, 0, 1])).toEqual([2, 0, 1]);
  });

  it("dedupeColumnIndexes dedups keeping the first occurrence and drops negatives", () => {
    expect(dedupeColumnIndexes([2, 0, 2, -1, 1, 0])).toEqual([2, 0, 1]);
  });
});
