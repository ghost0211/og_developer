import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import {
  buildDbePerfTopSqlQuery,
  buildTopSqlAvailabilitySql,
  buildTopSqlColumnsFallbackSql,
  buildTopSqlColumnsSql,
  buildTopSqlQuery,
  classifyDbePerfProbeError,
  formatTopSqlCount,
  formatTopSqlDuration,
  hasTopSqlColumn,
  mapTopSqlAvailability,
  mapTopSqlColumns,
  mapTopSqlRows,
  normalizeTopSqlLimit,
  resolveTopSqlOrderColumn,
} from "@/lib/admin/topSql";

function result(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

// PostgreSQL 14+ column set.
const PG14_COLUMNS = ["query", "calls", "total_exec_time", "mean_exec_time", "rows", "shared_blks_read", "shared_blks_hit"];
// PostgreSQL 13 / openGauss column set.
const LEGACY_COLUMNS = ["query", "calls", "total_time", "mean_time", "rows", "shared_blks_read", "shared_blks_hit"];

describe("topSql discovery SQL", () => {
  it("builds an extension availability probe", () => {
    expect(buildTopSqlAvailabilitySql()).toContain("pg_extension");
    expect(buildTopSqlAvailabilitySql()).toContain("pg_stat_statements");
  });

  it("builds public-scoped and unscoped column probes", () => {
    expect(buildTopSqlColumnsSql()).toContain("information_schema.columns");
    expect(buildTopSqlColumnsSql()).toContain("table_schema = 'public'");
    expect(buildTopSqlColumnsSql()).toContain("table_name = 'pg_stat_statements'");
    expect(buildTopSqlColumnsFallbackSql()).toContain("table_name = 'pg_stat_statements'");
    expect(buildTopSqlColumnsFallbackSql()).not.toContain("table_schema");
  });
});

describe("column detection", () => {
  it("matches columns case-insensitively", () => {
    expect(hasTopSqlColumn(["TOTAL_EXEC_TIME"], "total_exec_time")).toBe(true);
    expect(hasTopSqlColumn(["calls"], "rows")).toBe(false);
  });

  it("resolves the order column with version fallbacks", () => {
    expect(resolveTopSqlOrderColumn(PG14_COLUMNS, "total")).toBe("total_exec_time");
    expect(resolveTopSqlOrderColumn(LEGACY_COLUMNS, "total")).toBe("total_time");
    expect(resolveTopSqlOrderColumn(LEGACY_COLUMNS, "mean")).toBe("mean_time");
    expect(resolveTopSqlOrderColumn(PG14_COLUMNS, "calls")).toBe("calls");
    expect(resolveTopSqlOrderColumn(PG14_COLUMNS, "rows")).toBe("rows");
    expect(resolveTopSqlOrderColumn(PG14_COLUMNS, "read")).toBe("shared_blks_read");
    expect(resolveTopSqlOrderColumn(["query"], "total")).toBeNull();
  });

  it("clamps the TOP N limit", () => {
    expect(normalizeTopSqlLimit(100)).toBe(100);
    expect(normalizeTopSqlLimit(0)).toBe(1);
    expect(normalizeTopSqlLimit(5000)).toBe(1000);
    expect(normalizeTopSqlLimit(Number.NaN)).toBe(50);
    expect(normalizeTopSqlLimit(12.9)).toBe(12);
  });
});

describe("buildTopSqlQuery", () => {
  it("projects PostgreSQL 14+ execution-time columns", () => {
    const sql = buildTopSqlQuery(PG14_COLUMNS, "total", 50);
    expect(sql).toContain("query");
    expect(sql).toContain("calls AS calls");
    expect(sql).toContain("total_exec_time AS total_ms");
    expect(sql).toContain("mean_exec_time AS mean_ms");
    expect(sql).toContain("rows AS rows_total");
    expect(sql).toContain("shared_blks_read AS shared_blks_read");
    expect(sql).toContain("shared_blks_hit AS shared_blks_hit");
    expect(sql).toContain("FROM pg_stat_statements");
    expect(sql).toContain("ORDER BY total_exec_time DESC NULLS LAST");
    expect(sql).toContain("LIMIT 50");
  });

  it("falls back to legacy time columns (PG13- / openGauss)", () => {
    const sql = buildTopSqlQuery(LEGACY_COLUMNS, "mean", 100);
    expect(sql).toContain("total_time AS total_ms");
    expect(sql).toContain("mean_time AS mean_ms");
    expect(sql).not.toContain("total_exec_time");
    expect(sql).toContain("ORDER BY mean_time DESC NULLS LAST");
    expect(sql).toContain("LIMIT 100");
  });

  it("orders by count / rows / read keys", () => {
    expect(buildTopSqlQuery(PG14_COLUMNS, "calls", 10)).toContain("ORDER BY calls DESC");
    expect(buildTopSqlQuery(PG14_COLUMNS, "rows", 10)).toContain("ORDER BY rows DESC");
    expect(buildTopSqlQuery(PG14_COLUMNS, "read", 10)).toContain("ORDER BY shared_blks_read DESC");
  });

  it("uses NULL placeholders for missing time columns and 0 for counters", () => {
    const sql = buildTopSqlQuery(["query", "calls"], "total", 50);
    expect(sql).toContain("NULL AS total_ms");
    expect(sql).toContain("NULL AS mean_ms");
    expect(sql).toContain("0 AS rows_total");
    expect(sql).toContain("0 AS shared_blks_read");
    // The requested sort target is gone, so fall back to calls.
    expect(sql).toContain("ORDER BY calls DESC");
  });

  it("assumes modern columns when discovery returned nothing", () => {
    const sql = buildTopSqlQuery([], "total", 50);
    expect(sql).toContain("total_exec_time AS total_ms");
    expect(sql).toContain("ORDER BY total_exec_time DESC");
  });

  it("clamps an out-of-range limit", () => {
    expect(buildTopSqlQuery(PG14_COLUMNS, "total", 99999)).toContain("LIMIT 1000");
    expect(buildTopSqlQuery(PG14_COLUMNS, "total", -5)).toContain("LIMIT 1");
  });
});

describe("mapTopSqlRows", () => {
  it("converts numeric cells and trims the query text", () => {
    const rows = mapTopSqlRows(result(["query", "calls", "total_ms", "mean_ms", "rows_total", "shared_blks_read", "shared_blks_hit"], [["  SELECT 1  ", "12", "1230.5", "102.54", "7", null, "999"]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      query: "SELECT 1",
      calls: 12,
      totalMs: 1230.5,
      meanMs: 102.54,
      rowsTotal: 7,
      sharedBlksRead: 0,
      sharedBlksHit: 999,
    });
  });

  it("matches column aliases case-insensitively and tolerates missing columns", () => {
    const rows = mapTopSqlRows(result(["QUERY", "CALLS"], [["SELECT 2", 3]]));
    expect(rows[0].query).toBe("SELECT 2");
    expect(rows[0].calls).toBe(3);
    expect(rows[0].totalMs).toBe(0);
    expect(rows[0].sharedBlksHit).toBe(0);
  });

  it("returns an empty list for missing or malformed results", () => {
    expect(mapTopSqlRows(null)).toEqual([]);
    expect(mapTopSqlRows(undefined)).toEqual([]);
    expect(mapTopSqlRows(result([], []))).toEqual([]);
  });
});

describe("availability and column mapping", () => {
  it("reads the availability boolean across representations", () => {
    expect(mapTopSqlAvailability(result(["exists"], [[true]]))).toBe(true);
    expect(mapTopSqlAvailability(result(["exists"], [["t"]]))).toBe(true);
    expect(mapTopSqlAvailability(result(["exists"], [["1"]]))).toBe(true);
    expect(mapTopSqlAvailability(result(["exists"], [[false]]))).toBe(false);
    expect(mapTopSqlAvailability(result(["exists"], [["f"]]))).toBe(false);
    expect(mapTopSqlAvailability(null)).toBe(false);
  });

  it("reads and cleans the discovered column names", () => {
    expect(mapTopSqlColumns(result(["column_name"], [[" query "], ["calls"], [null]]))).toEqual(["query", "calls"]);
    expect(mapTopSqlColumns(null)).toEqual([]);
  });
});

describe("formatting helpers", () => {
  it("formats durations in ms and seconds", () => {
    expect(formatTopSqlDuration(1230)).toBe("1.23 s");
    expect(formatTopSqlDuration(456)).toBe("456 ms");
    expect(formatTopSqlDuration(1000)).toBe("1 s");
    expect(formatTopSqlDuration(12_345)).toBe("12.35 s");
    expect(formatTopSqlDuration(4.5)).toBe("4.5 ms");
    expect(formatTopSqlDuration(0)).toBe("0 ms");
    expect(formatTopSqlDuration(null)).toBe("-");
    expect(formatTopSqlDuration(Number.NaN)).toBe("-");
  });

  it("formats counts with thousands separators", () => {
    expect(formatTopSqlCount(1234567)).toBe("1,234,567");
    expect(formatTopSqlCount(999)).toBe("999");
    expect(formatTopSqlCount(null)).toBe("-");
  });
});

describe("dbe_perf.statement fallback", () => {
  it("builds the dbe_perf query with unified aliases and microsecond-to-millisecond conversion", () => {
    const sql = buildDbePerfTopSqlQuery("total", 50);
    expect(sql).toContain("FROM dbe_perf.statement");
    expect(sql).toContain("s.total_elapse_time / 1000.0 AS total_ms");
    expect(sql).toContain("NULLIF(s.n_calls, 0)");
    expect(sql).toContain("s.n_blocks_fetched AS shared_blks_read");
    expect(sql).toContain("ORDER BY total_ms DESC NULLS LAST");
    expect(sql).toContain("LIMIT 50");
  });

  it("maps every sort key to a unified output alias", () => {
    expect(buildDbePerfTopSqlQuery("mean", 10)).toContain("ORDER BY mean_ms DESC");
    expect(buildDbePerfTopSqlQuery("calls", 10)).toContain("ORDER BY calls DESC");
    expect(buildDbePerfTopSqlQuery("rows", 10)).toContain("ORDER BY rows_total DESC");
    expect(buildDbePerfTopSqlQuery("read", 10)).toContain("ORDER BY shared_blks_read DESC");
  });

  it("clamps the limit", () => {
    expect(buildDbePerfTopSqlQuery("total", 99999)).toContain("LIMIT 1000");
  });

  it("classifies probe errors", () => {
    expect(classifyDbePerfProbeError("ERROR: permission denied for schema dbe_perf")).toBe("denied");
    expect(classifyDbePerfProbeError('relation "statement" does not exist')).toBe("missing");
    expect(classifyDbePerfProbeError("connection refused")).toBe("error");
  });
});
