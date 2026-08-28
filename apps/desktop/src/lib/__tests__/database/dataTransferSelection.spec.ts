import { describe, expect, it } from "vitest";
import { isSameTransferDatabase, normalizeTransferCatalog, type TransferDatabaseSelection } from "@/lib/database/dataTransferSelection";

function selection(overrides: Partial<TransferDatabaseSelection> = {}): TransferDatabaseSelection {
  return {
    connectionId: "connection-1",
    catalog: "",
    database: "sales",
    ...overrides,
  };
}

describe("data transfer database selection", () => {
  it("trims the catalog", () => {
    expect(normalizeTransferCatalog("")).toBe("");
    expect(normalizeTransferCatalog("  ")).toBe("");
    expect(normalizeTransferCatalog(" analytics ")).toBe("analytics");
  });

  it("treats matching selections as the same transfer database", () => {
    expect(isSameTransferDatabase(selection(), selection())).toBe(true);
    expect(isSameTransferDatabase(selection(), selection({ catalog: " " }))).toBe(true);
  });

  it("keeps different catalogs distinct", () => {
    expect(isSameTransferDatabase(selection({ catalog: "a" }), selection({ catalog: "b" }))).toBe(false);
  });

  it("compares connection and database fields without concatenation collisions", () => {
    expect(isSameTransferDatabase(selection({ connectionId: "ab", database: "c" }), selection({ connectionId: "a", database: "bc" }))).toBe(false);
  });
});
