import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import { buildPgCancelSql, buildPgKillSql, isPgProcessListCompatibilityError, mapPgBlockingLockRows, mapPgLockRows, mapPgProcessRows, OPENGAUSS_OWN_SESSION_SQL, OPENGAUSS_PROCESS_LIST_SQL, pgKillResultError, PG_PROCESS_LIST_LEGACY_SQL, PG_PROCESS_LIST_SQL } from "@/lib/database/postgresProcessList";
import { connectionSupportsProcessList, resolveProcessListDriver, resolveProcessListDriverForConnection, supportsProcessList } from "@/lib/database/processListDrivers";
import type { ConnectionConfig } from "@/types/database";

function result(columns: string[], rows: (string | number | boolean | null)[][]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

describe("mapPgProcessRows", () => {
  it("maps a pg_stat_activity result into typed rows", () => {
    const rows = mapPgProcessRows(result(["pid", "user", "db", "client", "app", "state", "wait", "time", "query"], [[4211, "app", "shop", "10.0.0.4", "psql", "active", "Client:ClientRead", 12, "SELECT * FROM orders"]]));
    expect(rows).toEqual([
      {
        id: 4211,
        user: "app",
        db: "shop",
        client: "10.0.0.4",
        app: "psql",
        state: "active",
        wait: "Client:ClientRead",
        time: 12,
        query: "SELECT * FROM orders",
      },
    ]);
  });

  it("tolerates NULL columns and case-variant names", () => {
    const rows = mapPgProcessRows(result(["PID", "USER", "DB", "CLIENT", "APP", "STATE", "WAIT", "TIME", "QUERY"], [["4200", "postgres", null, "local", null, "idle", null, "340", null]]));
    expect(rows[0]).toMatchObject({ id: 4200, user: "postgres", db: null, app: null, state: "idle", wait: null, time: 340, query: null });
  });

  it("returns an empty array for empty or malformed input", () => {
    expect(mapPgProcessRows(null)).toEqual([]);
    expect(mapPgProcessRows(undefined)).toEqual([]);
    expect(mapPgProcessRows(result([], []))).toEqual([]);
  });
});

describe("buildPgKillSql", () => {
  it("builds pg_terminate_backend for a valid pid", () => {
    expect(buildPgKillSql(4211)).toBe("SELECT pg_terminate_backend(4211)");
  });

  it("builds pg_cancel_backend for cancel query", () => {
    expect(buildPgCancelSql(4211)).toBe("SELECT pg_cancel_backend(4211)");
  });

  it("rejects non-integer, zero, or negative pids", () => {
    expect(() => buildPgKillSql(1.5)).toThrow();
    expect(() => buildPgKillSql(0)).toThrow();
    expect(() => buildPgKillSql(-1)).toThrow();
    expect(() => buildPgKillSql(Number.NaN)).toThrow();
  });
});

describe("mapPgBlockingLockRows and mapPgLockRows", () => {
  it("maps blocking lock query results into structured chain rows", () => {
    const res = result(
      ["blocked_pid", "blocked_user", "blocked_db", "blocked_query", "blocking_pid", "blocking_user", "blocking_db", "blocking_query", "locktype", "relation", "requested_mode", "granted_mode", "wait_time"],
      [[101, "u_blocked", "db1", "UPDATE t SET v=1", 102, "u_blocking", "db1", "UPDATE t SET v=2", "relation", "orders", "ExclusiveLock", "ExclusiveLock", 45]],
    );
    const rows = mapPgBlockingLockRows(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      blockedPid: 101,
      blockedUser: "u_blocked",
      blockedDb: "db1",
      blockedQuery: "UPDATE t SET v=1",
      blockingPid: 102,
      blockingUser: "u_blocking",
      blockingDb: "db1",
      blockingQuery: "UPDATE t SET v=2",
      lockType: "relation",
      relation: "orders",
      requestedMode: "ExclusiveLock",
      grantedMode: "ExclusiveLock",
      waitTime: 45,
    });
  });

  it("maps detailed resource lock query results", () => {
    const res = result(["pid", "user", "db", "locktype", "relation", "mode", "granted", "time", "query"], [[102, "u_blocking", "db1", "relation", "orders", "RowExclusiveLock", true, 60, "SELECT 1"]]);
    const rows = mapPgLockRows(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      pid: 102,
      user: "u_blocking",
      db: "db1",
      lockType: "relation",
      relation: "orders",
      mode: "RowExclusiveLock",
      granted: true,
      time: 60,
      query: "SELECT 1",
    });
  });
});

describe("PostgreSQL-family process SQL", () => {
  it("uses openGauss's pg catalog and boolean waiting column", () => {
    const driver = resolveProcessListDriver("opengauss");
    expect(driver?.listSql).toBe(OPENGAUSS_PROCESS_LIST_SQL);
    expect(driver?.ownSessionSql).toBe(OPENGAUSS_OWN_SESSION_SQL);
    expect(OPENGAUSS_PROCESS_LIST_SQL).toContain("FROM pg_catalog.pg_stat_activity");
    expect(OPENGAUSS_PROCESS_LIST_SQL).toContain("CASE WHEN waiting");
    expect(OPENGAUSS_PROCESS_LIST_SQL).not.toContain("wait_event_type");
    expect(driver?.buildKillSql(7)).toBe("SELECT pg_terminate_backend(7)");
  });
});

describe("Postgres compatibility", () => {
  it("provides a pre-9.6 query and only falls back for missing wait-event columns", () => {
    expect(PG_PROCESS_LIST_SQL).toContain("wait_event_type");
    expect(PG_PROCESS_LIST_LEGACY_SQL).toContain("CASE WHEN waiting THEN 'Lock'");
    expect(PG_PROCESS_LIST_LEGACY_SQL).not.toContain("wait_event_type");
    expect(isPgProcessListCompatibilityError(new Error('column "wait_event_type" does not exist'))).toBe(true);
    expect(isPgProcessListCompatibilityError({ code: "42703" })).toBe(true);
    expect(isPgProcessListCompatibilityError(new Error("permission denied for view pg_stat_activity"))).toBe(false);
  });

  it("requires pg_terminate_backend to confirm termination", () => {
    expect(pgKillResultError([result(["pg_terminate_backend"], [[true]])])).toBeNull();
    expect(pgKillResultError([result(["pg_terminate_backend"], [["t"]])])).toBeNull();
    expect(pgKillResultError([result(["pg_terminate_backend"], [[false]])])).toContain("did not terminate");
    expect(pgKillResultError([result(["pg_terminate_backend"], [])])).toContain("did not terminate");
  });
});

describe("resolveProcessListDriver", () => {
  it("routes Postgres engines to the pg driver", () => {
    const postgres = resolveProcessListDriver("postgres");
    expect(postgres?.buildKillSql(7)).toBe("SELECT pg_terminate_backend(7)");
    expect(postgres?.fallbackListSql).toBe(PG_PROCESS_LIST_LEGACY_SQL);
    expect(postgres?.shouldUseFallbackListSql?.(new Error('column "wait_event" does not exist'))).toBe(true);
    expect(postgres?.killResultError?.([result(["pg_terminate_backend"], [[false]])])).toContain("did not terminate");
    expect(resolveProcessListDriver("jdbc")).toBeNull();
  });

  it("unifies process-list support across the supported engines", () => {
    expect(supportsProcessList("postgres")).toBe(true);
    expect(supportsProcessList("opengauss")).toBe(true);
    expect(supportsProcessList("jdbc")).toBe(false);
    expect(supportsProcessList(undefined)).toBe(false);
  });
});

function conn(partial: Partial<ConnectionConfig>): ConnectionConfig {
  return { db_type: "postgres", ...partial } as ConnectionConfig;
}

describe("connectionSupportsProcessList", () => {
  it("gates on the real connection profile", () => {
    expect(connectionSupportsProcessList(conn({ db_type: "postgres" }))).toBe(true);
    expect(connectionSupportsProcessList(conn({ db_type: "opengauss" }))).toBe(true);
    expect(connectionSupportsProcessList(conn({ db_type: "opengauss", driver_profile: "opengauss-jdbc" }))).toBe(true);
    expect(connectionSupportsProcessList(undefined)).toBe(false);
  });

  it("resolves JDBC connections by their effective engine", () => {
    expect(connectionSupportsProcessList(conn({ db_type: "jdbc", connection_string: "jdbc:postgresql://db:5432/app" }))).toBe(true);
    expect(connectionSupportsProcessList(conn({ db_type: "jdbc", connection_string: "jdbc:opengauss://db:5432/app" }))).toBe(true);
    expect(connectionSupportsProcessList(conn({ db_type: "jdbc", connection_string: "jdbc:unknown://db:1/app" }))).toBe(false);
  });
});

describe("resolveProcessListDriverForConnection", () => {
  it("returns the pg driver for a JDBC Postgres connection", () => {
    expect(resolveProcessListDriverForConnection(conn({ db_type: "jdbc", connection_string: "jdbc:postgresql://db/app" }))?.buildKillSql(9)).toBe("SELECT pg_terminate_backend(9)");
    expect(resolveProcessListDriverForConnection(conn({ db_type: "jdbc", connection_string: "jdbc:unknown://db/app" }))).toBeNull();
  });
});
