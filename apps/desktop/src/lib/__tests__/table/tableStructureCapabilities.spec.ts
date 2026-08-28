import { describe, expect, it } from "vitest";
import { getTableStructureCapabilities, hasLocalTableColumnOrderChange, isPhysicalTableColumnOrderChange, sanitizeStructureIndexesForCapabilities, supportsLocalTableColumnReorder } from "@/lib/table/tableStructureCapabilities";

describe("tableStructureCapabilities", () => {
  it("marks openGauss and PostgreSQL with native ALTER COLUMN support as direct", () => {
    expect(getTableStructureCapabilities("opengauss", "opengauss").alterStrategy).toBe("direct");
    expect(getTableStructureCapabilities("postgres", "postgres").alterStrategy).toBe("direct");
  });

  it("enables PostgreSQL index INCLUDE only for known supported versions", () => {
    expect(getTableStructureCapabilities("postgres", "postgres", "PostgreSQL 10.15 (Transwarp) on x86_64-pc-linux-gnu").indexInclude).toBe(false);
    expect(getTableStructureCapabilities("postgres", "postgres", "9.6.24").indexInclude).toBe(false);
    expect(getTableStructureCapabilities("postgres", "postgres", "11.0").indexInclude).toBe(true);
    expect(getTableStructureCapabilities("postgres", "postgres", "PostgreSQL 16.14").indexInclude).toBe(true);
    expect(getTableStructureCapabilities("postgres", "postgres", undefined).indexInclude).toBe(true);
    expect(getTableStructureCapabilities("postgres", "postgres", "unknown").indexInclude).toBe(true);
  });

  it("removes unsupported included columns before SQL generation", () => {
    const index = {
      id: "new:index",
      name: "example_idx",
      columns: ["key_column"],
      isUnique: false,
      isPrimary: false,
      filter: "",
      indexType: "BTREE",
      includedColumns: ["included_column"],
      comment: "",
      markedForDrop: false,
    };

    const indexes = [index];
    const postgres10Indexes = sanitizeStructureIndexesForCapabilities(indexes, getTableStructureCapabilities("postgres", "postgres", "10.15"));
    expect(postgres10Indexes).not.toBe(indexes);
    expect(postgres10Indexes[0].includedColumns).toEqual([]);
    expect(index.includedColumns).toEqual(["included_column"]);

    const postgres11Indexes = sanitizeStructureIndexesForCapabilities(indexes, getTableStructureCapabilities("postgres", "postgres", "11.0"));
    expect(postgres11Indexes).toBe(indexes);
  });

  it("uses local-only column reordering for openGauss and Postgres", () => {
    expect(supportsLocalTableColumnReorder("opengauss", "opengauss")).toBe(true);
    expect(supportsLocalTableColumnReorder("postgres", "postgres")).toBe(true);
  });

  it("does not treat local-only reordering as a database structure change", () => {
    expect(isPhysicalTableColumnOrderChange("opengauss", "opengauss", 0, 2)).toBe(false);
    expect(isPhysicalTableColumnOrderChange("postgres", "postgres", 0, 2)).toBe(false);
  });

  it("detects local order changes including newly added columns", () => {
    const first = { original: {}, originalPosition: 0 };
    const second = { original: {}, originalPosition: 1 };
    const added = {};

    expect(hasLocalTableColumnOrderChange([first, second, added])).toBe(false);
    expect(hasLocalTableColumnOrderChange([first, added, second])).toBe(true);
    expect(hasLocalTableColumnOrderChange([second, first, added])).toBe(true);
  });

  it("ignores dropped columns when comparing local order", () => {
    const first = { original: {}, originalPosition: 0 };
    const dropped = { original: {}, originalPosition: 1, markedForDrop: true };
    const third = { original: {}, originalPosition: 2 };

    expect(hasLocalTableColumnOrderChange([first, dropped, third])).toBe(false);
  });
});
