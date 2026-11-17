import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteSqlParameterPreset,
  inferSqlParameterKind,
  loadSqlParameterHistory,
  loadSqlParameterPresets,
  MAX_SQL_PARAMETER_HISTORY,
  MAX_SQL_PARAMETER_PRESETS,
  rememberSqlParameterValue,
  rememberSqlParameterValues,
  removeSqlParameterHistoryEntry,
  saveSqlParameterPreset,
} from "@/lib/sql/sqlParameterHistory";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

describe("sqlParameterHistory", () => {
  it("stores recent values by parameter name", () => {
    rememberSqlParameterValue("start_date", { kind: "string", value: "2026-01-01" });
    rememberSqlParameterValue("start_date", { kind: "string", value: "2026-01-02" });

    expect(loadSqlParameterHistory("start_date")).toEqual([
      { kind: "string", value: "2026-01-02" },
      { kind: "string", value: "2026-01-01" },
    ]);
  });

  it("deduplicates by type and value and moves the latest value to the front", () => {
    rememberSqlParameterValue("min_id", { kind: "number", value: "1" });
    rememberSqlParameterValue("min_id", { kind: "number", value: "2" });
    rememberSqlParameterValue("min_id", { kind: "number", value: "1" });

    expect(loadSqlParameterHistory("min_id")).toEqual([
      { kind: "number", value: "1" },
      { kind: "number", value: "2" },
    ]);
  });

  it("matches parameter names case-insensitively and limits history size", () => {
    for (let i = 0; i < MAX_SQL_PARAMETER_HISTORY + 2; i += 1) {
      rememberSqlParameterValue("UserId", { kind: "number", value: String(i) });
    }

    const history = loadSqlParameterHistory("userId");
    expect(history).toHaveLength(MAX_SQL_PARAMETER_HISTORY);
    expect(history[0]).toEqual({ kind: "number", value: String(MAX_SQL_PARAMETER_HISTORY + 1) });
    expect(history.at(-1)).toEqual({ kind: "number", value: "2" });
  });

  it("removes individual mistyped history entries without affecting other entries", () => {
    rememberSqlParameterValues({
      tenant_id: { kind: "number", value: "1001" },
    });
    rememberSqlParameterValue("tenant_id", { kind: "number", value: "10001" });
    rememberSqlParameterValue("tenant_id", { kind: "string", value: "10001" });
    rememberSqlParameterValue("tenant_id", { kind: "null", value: "" });

    const afterRemoveMistyped = removeSqlParameterHistoryEntry("TENANT_ID", { kind: "number", value: "10001" });
    expect(afterRemoveMistyped).toEqual([
      { kind: "null", value: "NULL" },
      { kind: "string", value: "10001" },
      { kind: "number", value: "1001" },
    ]);

    removeSqlParameterHistoryEntry("tenant_id", { kind: "null", value: "NULL" });
    removeSqlParameterHistoryEntry("tenant_id", { kind: "string", value: "10001" });
    expect(removeSqlParameterHistoryEntry("tenant_id", { kind: "number", value: "1001" })).toEqual([]);
    expect(loadSqlParameterHistory("tenant_id")).toEqual([]);
  });
});

describe("sqlParameterPresets", () => {
  it("saves, updates case-insensitively by name, sorts by parameter overlap then recency, and deletes presets", () => {
    saveSqlParameterPreset("Prod Tenant", {
      tenant_id: { kind: "number", value: "100" },
    });
    saveSqlParameterPreset("Monthly Report", {
      tenant_id: { kind: "number", value: "200" },
      start_date: { kind: "string", value: "2026-01-01" },
      end_date: { kind: "string", value: "2026-01-31" },
    });
    saveSqlParameterPreset("Unrelated Query", {
      order_no: { kind: "string", value: "SO-1" },
    });

    const initialAll = loadSqlParameterPresets();
    expect(initialAll.map((preset) => preset.name)).toEqual(["Unrelated Query", "Monthly Report", "Prod Tenant"]);

    const ranked = loadSqlParameterPresets(["TENANT_ID", "start_date"]);
    expect(ranked.map((preset) => ({ name: preset.name, matchedCount: preset.matchedCount }))).toEqual([
      { name: "Monthly Report", matchedCount: 2 },
      { name: "Prod Tenant", matchedCount: 1 },
      { name: "Unrelated Query", matchedCount: 0 },
    ]);

    const prodId = initialAll.find((preset) => preset.name === "Prod Tenant")!.id;
    saveSqlParameterPreset("  prod tenant  ", {
      tenant_id: { kind: "number", value: "999" },
      start_date: { kind: "string", value: "2026-06-01" },
    });

    const updatedRanked = loadSqlParameterPresets(["tenant_id", "start_date"]);
    expect(updatedRanked).toHaveLength(3);
    expect(updatedRanked[0]).toMatchObject({
      id: prodId,
      name: "prod tenant",
      matchedCount: 2,
      values: {
        tenant_id: { kind: "number", value: "999" },
        start_date: { kind: "string", value: "2026-06-01" },
      },
    });

    const afterDelete = deleteSqlParameterPreset(prodId);
    expect(afterDelete.map((preset) => preset.id)).not.toContain(prodId);
    expect(loadSqlParameterPresets()).toHaveLength(2);
  });

  it("caps stored presets at MAX_SQL_PARAMETER_PRESETS", () => {
    for (let i = 0; i < MAX_SQL_PARAMETER_PRESETS + 5; i += 1) {
      saveSqlParameterPreset(`Preset ${i}`, {
        $1: { kind: "number", value: String(i) },
      });
    }

    const presets = loadSqlParameterPresets(["$1"]);
    expect(presets).toHaveLength(MAX_SQL_PARAMETER_PRESETS);
    expect(presets[0].name).toBe(`Preset ${MAX_SQL_PARAMETER_PRESETS + 4}`);
    expect(presets[0].matchedCount).toBe(1);
  });
});

describe("inferSqlParameterKind", () => {
  it("infers null, boolean, number, raw SQL expressions, and preserves zero-padded strings/dates", () => {
    expect(inferSqlParameterKind("NULL")).toBe("null");
    expect(inferSqlParameterKind(" null ")).toBe("null");
    expect(inferSqlParameterKind("true")).toBe("boolean");
    expect(inferSqlParameterKind("FALSE")).toBe("boolean");
    expect(inferSqlParameterKind("0")).toBe("number");
    expect(inferSqlParameterKind("-42.5")).toBe("number");
    expect(inferSqlParameterKind("1842394823948239482")).toBe("number");
    expect(inferSqlParameterKind("00123")).toBe("string");
    expect(inferSqlParameterKind("2026-01-01")).toBe("string");
    expect(inferSqlParameterKind("current_timestamp")).toBe("raw");
    expect(inferSqlParameterKind("now()")).toBe("raw");
    expect(inferSqlParameterKind("")).toBe("string");
  });
});
