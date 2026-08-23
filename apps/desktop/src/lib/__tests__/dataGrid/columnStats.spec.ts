import { describe, expect, it } from "vitest";
import { computeDataGridColumnStats } from "@/lib/dataGrid/columnStats";

describe("computeDataGridColumnStats", () => {
  it("computes null, distinct, numeric and top-value metrics without spreading rows", () => {
    const stats = computeDataGridColumnStats({
      name: "amount",
      type: "numeric",
      columnIndex: 0,
      rows: [[1], [2], [2], [null], [3]],
    });

    expect(stats).toMatchObject({
      total: 5,
      nonNull: 4,
      nullCount: 1,
      distinctCount: 3,
      isNumeric: true,
      min: 1,
      max: 3,
      sum: 8,
      avg: 2,
    });
    expect(stats.topValues[0]).toEqual({ value: "2", count: 2, percent: 50 });
  });

  it("does not calculate numeric aggregates for text columns containing numeric-looking IDs", () => {
    const stats = computeDataGridColumnStats({
      name: "code",
      type: "varchar",
      columnIndex: 0,
      rows: [["001"], ["002"], ["002"]],
    });

    expect(stats.isNumeric).toBe(false);
    expect(stats.min).toBeUndefined();
    expect(stats.sum).toBeUndefined();
    expect(stats.topValues[0]).toMatchObject({ value: "002", count: 2, percent: 66.7 });
  });

  it("handles large row collections and percentages over non-NULL values", () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => [index % 2 === 0 ? 1 : null] as [number | null]);
    const stats = computeDataGridColumnStats({ name: "value", columnIndex: 0, rows });

    expect(stats.total).toBe(100_000);
    expect(stats.nonNull).toBe(50_000);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(1);
    expect(stats.sum).toBe(50_000);
    expect(stats.topValues[0]?.percent).toBe(100);
  });
});
