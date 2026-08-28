import { describe, expect, it } from "vitest";
import { transferObjectFamily, transferObjectKindsForDatabase, isSameTransferFamily, crossFamilyTransferableKinds, TransferObjectFamily } from "@/lib/database/transferObjectKinds";

describe("transferObjectKinds", () => {
  it("groups databases into transfer families", () => {
    expect(transferObjectFamily("postgres")).toBe(TransferObjectFamily.Postgres);
    expect(transferObjectFamily("opengauss")).toBe(TransferObjectFamily.Postgres);
    expect(transferObjectFamily("jdbc")).toBeUndefined();
  });

  it("returns per-family object kinds", () => {
    expect(transferObjectKindsForDatabase("postgres")).toContain("SEQUENCE");
    expect(transferObjectKindsForDatabase("opengauss")).toContain("SEQUENCE");
    expect(transferObjectKindsForDatabase("jdbc")).toEqual([]);
  });

  it("detects same-family transfers", () => {
    expect(isSameTransferFamily("postgres", "opengauss")).toBe(true);
    expect(isSameTransferFamily("postgres", "postgres")).toBe(true);
    expect(isSameTransferFamily("opengauss", "opengauss")).toBe(true);
    expect(isSameTransferFamily("postgres", "jdbc")).toBe(false);
  });

  it("limits cross-family transferable kinds", () => {
    expect(crossFamilyTransferableKinds("postgres", "jdbc")).toEqual([]);
    const same = crossFamilyTransferableKinds("postgres", "opengauss");
    expect(same).toContain("TABLE");
    expect(same).toContain("SEQUENCE");
  });
});
