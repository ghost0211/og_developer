import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import {
  computePgTps,
  computeRate,
  connectionSupportsServerDashboard,
  formatBytes,
  formatBytesPerSec,
  formatUptime,
  isOpenGaussReplayRecordError,
  isPgStatusCompatibilityError,
  OPENGAUSS_STATUS_FALLBACK_SQL,
  OPENGAUSS_STATUS_SQL,
  OPENGAUSS_VARIABLES_SQL,
  parsePgStatusRow,
  pgCacheHitRatio,
  PG_STATUS_LEGACY_SQL,
  PG_STATUS_SQL,
  resolveServerDashboardDriver,
  statusNumber,
  type StatusSample,
} from "@/lib/database/postgresServerStatus";

function statusResult(columns: string[], row: (string | number)[]): QueryResult {
  return { columns, rows: [row], affected_rows: 0, execution_time_ms: 0 };
}

function sample(at: number, status: Record<string, string>): StatusSample {
  return { at, status };
}

describe("parsePgStatusRow", () => {
  it("parses the single aggregate row into a map", () => {
    const map = parsePgStatusRow(statusResult(["xact_commit", "xact_rollback"], ["1200", "3"]));
    expect(map).toEqual({ xact_commit: "1200", xact_rollback: "3" });
  });

  it("returns empty map for malformed input", () => {
    expect(parsePgStatusRow(null)).toEqual({});
    expect(parsePgStatusRow({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 })).toEqual({});
  });
});

describe("statusNumber", () => {
  it("reads numeric values and defaults to 0", () => {
    expect(statusNumber({ connections: "12" }, "connections")).toBe(12);
    expect(statusNumber({}, "missing")).toBe(0);
    expect(statusNumber({ x: "abc" }, "x")).toBe(0);
  });
});

describe("computeRate", () => {
  it("computes per-second delta", () => {
    const prev = sample(1000, { tup_inserted: "1000" });
    const curr = sample(3000, { tup_inserted: "5000" });
    expect(computeRate(prev, curr, "tup_inserted")).toBe(2000); // 4000 rows / 2s
  });

  it("returns 0 on counter reset (decrease)", () => {
    const prev = sample(1000, { xact_commit: "9000" });
    const curr = sample(2000, { xact_commit: "10" });
    expect(computeRate(prev, curr, "xact_commit")).toBe(0);
  });

  it("returns 0 for non-positive time delta", () => {
    const prev = sample(2000, { xact_commit: "10" });
    const curr = sample(2000, { xact_commit: "20" });
    expect(computeRate(prev, curr, "xact_commit")).toBe(0);
  });
});

describe("computePgTps", () => {
  it("sums commit and rollback rates", () => {
    const prev = sample(0, { xact_commit: "0", xact_rollback: "0" });
    const curr = sample(1000, { xact_commit: "90", xact_rollback: "10" });
    expect(computePgTps(prev, curr)).toBe(100);
  });
});

describe("pgCacheHitRatio", () => {
  it("computes hit ratio as a percentage", () => {
    expect(pgCacheHitRatio({ blks_hit: "997", blks_read: "3" })).toBeCloseTo(99.7, 1);
  });

  it("returns null when no data has accumulated", () => {
    expect(pgCacheHitRatio({})).toBeNull();
    expect(pgCacheHitRatio({ blks_hit: "0", blks_read: "0" })).toBeNull();
  });
});

describe("formatters", () => {
  it("formats bytes and bytes/sec", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 2)).toBe("2.0 MB");
    expect(formatBytesPerSec(1024)).toBe("1.0 KB/s");
  });

  it("formats uptime compactly", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(3661)).toBe("1h 1m");
    expect(formatUptime(90061)).toBe("1d 1h 1m");
  });
});

describe("PG_STATUS_SQL", () => {
  it("does not use FILTER (PG9.4+ only) — this dashboard targets PG9.2+", () => {
    expect(PG_STATUS_SQL).not.toContain("FILTER");
    expect(PG_STATUS_SQL).toContain("sum(CASE WHEN state IS NOT NULL THEN 1 ELSE 0 END)");
    expect(PG_STATUS_SQL).not.toContain("count(*) AS connections");
    expect(PG_STATUS_SQL).toContain("sum(CASE WHEN state = 'active' THEN 1 ELSE 0 END)");
    expect(PG_STATUS_SQL).toContain("sum(CASE WHEN state = 'idle' THEN 1 ELSE 0 END)");
  });

  it("is recovery-aware for the WAL metric, never calling pg_current_wal_lsn() unconditionally", () => {
    expect(PG_STATUS_SQL).toContain("CASE WHEN pg_is_in_recovery()");
    expect(PG_STATUS_SQL).toContain("pg_last_wal_replay_lsn()");
    expect(PG_STATUS_SQL).toContain("pg_current_wal_lsn()");
  });
});

describe("PG_STATUS_LEGACY_SQL", () => {
  it("swaps only the PG10+ WAL functions for their pre-10 equivalents", () => {
    expect(PG_STATUS_LEGACY_SQL).not.toContain("pg_current_wal_lsn");
    expect(PG_STATUS_LEGACY_SQL).not.toContain("pg_last_wal_replay_lsn");
    expect(PG_STATUS_LEGACY_SQL).not.toContain("pg_wal_lsn_diff");
    expect(PG_STATUS_LEGACY_SQL).toContain("pg_current_xlog_location");
    expect(PG_STATUS_LEGACY_SQL).toContain("pg_last_xlog_replay_location");
    expect(PG_STATUS_LEGACY_SQL).toContain("pg_xlog_location_diff");
    const revertedToPrimary = PG_STATUS_LEGACY_SQL.replace(/\bpg_current_xlog_location\b/g, "pg_current_wal_lsn")
      .replace(/\bpg_last_xlog_replay_location\b/g, "pg_last_wal_replay_lsn")
      .replace(/\bpg_xlog_location_diff\b/g, "pg_wal_lsn_diff");
    expect(revertedToPrimary).toBe(PG_STATUS_SQL);
  });
});

describe("PostgreSQL-family status drivers", () => {
  it("uses openGauss's pg catalog with xlog location functions", () => {
    const driver = resolveServerDashboardDriver("opengauss");
    expect(driver?.statusSql).toBe(OPENGAUSS_STATUS_SQL);
    expect(driver?.variablesSql).toBe(OPENGAUSS_VARIABLES_SQL);
    expect(OPENGAUSS_STATUS_SQL).toContain("FROM pg_catalog.pg_stat_database");
    expect(OPENGAUSS_STATUS_SQL).toContain("FROM pg_catalog.pg_stat_activity");
    expect(OPENGAUSS_STATUS_SQL).toContain("pg_current_xlog_location()");
    expect(OPENGAUSS_STATUS_SQL).toContain("(pg_last_xlog_replay_location()).lsn");
    expect(OPENGAUSS_STATUS_SQL).not.toContain("pg_xlog_location_diff(pg_last_xlog_replay_location()");
    expect(OPENGAUSS_STATUS_SQL).not.toContain("pg_current_wal_lsn()");
    expect(driver?.fallbackStatusSql).toBe(OPENGAUSS_STATUS_FALLBACK_SQL);
    expect(driver?.shouldUseFallbackStatusSql?.(new Error('could not identify column "lsn" in record data type'))).toBe(true);
    expect(OPENGAUSS_STATUS_FALLBACK_SQL).toContain("CAST(pg_last_xlog_replay_location() AS text)");
    expect(OPENGAUSS_STATUS_FALLBACK_SQL).toContain("pg_current_xlog_location()");
    expect(OPENGAUSS_STATUS_FALLBACK_SQL).not.toContain(".lsn");
  });

  it("wires each engine-specific status fallback", () => {
    expect(resolveServerDashboardDriver("postgres")?.fallbackStatusSql).toBe(PG_STATUS_LEGACY_SQL);
    expect(resolveServerDashboardDriver("opengauss")?.fallbackStatusSql).toBe(OPENGAUSS_STATUS_FALLBACK_SQL);
    expect(resolveServerDashboardDriver("jdbc")).toBeNull();
  });
});

describe("isPgStatusCompatibilityError", () => {
  it("detects the WAL-function-not-found message on servers without a code field", () => {
    expect(isPgStatusCompatibilityError(new Error("function pg_current_wal_lsn() does not exist"))).toBe(true);
    expect(isPgStatusCompatibilityError(new Error("function pg_last_wal_replay_lsn() does not exist"))).toBe(true);
    expect(isPgStatusCompatibilityError(new Error("function pg_wal_lsn_diff(pg_lsn, unknown) does not exist"))).toBe(true);
  });

  it("detects the WAL-function-not-found SQLSTATE combined with a matching message", () => {
    expect(isPgStatusCompatibilityError(Object.assign(new Error("function pg_current_wal_lsn() does not exist"), { code: "42883" }))).toBe(true);
  });

  it("does not misclassify unrelated errors", () => {
    expect(isPgStatusCompatibilityError(new Error("connection refused"))).toBe(false);
    expect(isPgStatusCompatibilityError({ code: "42703" })).toBe(false);
  });

  it("does not treat every SQLSTATE 42883 as the WAL compatibility issue — only the two specific functions", () => {
    expect(isPgStatusCompatibilityError({ code: "42883" })).toBe(false);
    expect(isPgStatusCompatibilityError(Object.assign(new Error("function pg_postmaster_start_time() does not exist"), { code: "42883" }))).toBe(false);
    expect(isPgStatusCompatibilityError(new Error("function some_other_fn() does not exist"))).toBe(false);
  });
});

describe("isOpenGaussReplayRecordError", () => {
  it("detects the .lsn-on-non-composite failure some openGauss builds raise", () => {
    expect(isOpenGaussReplayRecordError(new Error('could not identify column "lsn" in record data type'))).toBe(true);
    expect(isOpenGaussReplayRecordError(new Error("column notation .lsn applied to type text, which is not a composite type"))).toBe(true);
    expect(isOpenGaussReplayRecordError(Object.assign(new Error("column notation .lsn applied to type text"), { code: "42809" }))).toBe(true);
  });

  it("does not misclassify unrelated errors", () => {
    expect(isOpenGaussReplayRecordError(new Error("connection refused"))).toBe(false);
    expect(isOpenGaussReplayRecordError(new Error("function pg_current_wal_lsn() does not exist"))).toBe(false);
  });
});

describe("connectionSupportsServerDashboard", () => {
  it("gates on the connection's effective db type", () => {
    expect(connectionSupportsServerDashboard({ id: "pg", name: "Postgres", db_type: "postgres" } as any)).toBe(true);
    expect(connectionSupportsServerDashboard({ id: "og", name: "openGauss", db_type: "opengauss" } as any)).toBe(true);
    expect(connectionSupportsServerDashboard(undefined)).toBe(false);
  });
});
