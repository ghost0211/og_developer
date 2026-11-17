import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import {
  buildBlockingLockForest,
  buildPgCancelSql,
  buildPgKillSql,
  isPgProcessListCompatibilityError,
  mapPgBlockingLockRows,
  mapPgLockRows,
  mapPgProcessRows,
  OPENGAUSS_BLOCKING_LOCKS_SQL,
  OPENGAUSS_OWN_SESSION_SQL,
  OPENGAUSS_PROCESS_LIST_SQL,
  parseBlockingLocksResult,
  PG_BLOCKING_LOCKS_SQL,
  pgKillResultError,
  PG_PROCESS_LIST_LEGACY_SQL,
  PG_PROCESS_LIST_SQL,
  type BlockingLockRow,
} from "@/lib/database/postgresProcessList";
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

  it("maps extended blocking_state, blocking_xact_time, and blocked_state columns when present", () => {
    expect(PG_BLOCKING_LOCKS_SQL).toContain("blocking_state");
    expect(PG_BLOCKING_LOCKS_SQL).toContain("blocking_xact_time");
    expect(PG_BLOCKING_LOCKS_SQL).toContain("blocked_state");
    expect(OPENGAUSS_BLOCKING_LOCKS_SQL).toBe(PG_BLOCKING_LOCKS_SQL);

    const res = result(
      ["blocked_pid", "blocked_user", "blocked_db", "blocked_state", "blocked_query", "blocking_pid", "blocking_user", "blocking_db", "blocking_state", "blocking_xact_time", "blocking_query", "locktype", "relation", "requested_mode", "granted_mode", "wait_time"],
      [[102, "app_waiter", "shop", "active", "UPDATE orders SET status='paid'", 101, "app_root", "shop", "idle in transaction", 180, "UPDATE orders SET status='pending'", "tuple", "orders", "ExclusiveLock", "ExclusiveLock", 42]],
    );
    const rows = parseBlockingLocksResult(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      blockedPid: 102,
      blockedUser: "app_waiter",
      blockedDb: "shop",
      blockedState: "active",
      blockedQuery: "UPDATE orders SET status='paid'",
      blockingPid: 101,
      blockingUser: "app_root",
      blockingDb: "shop",
      blockingState: "idle in transaction",
      blockingXactTime: 180,
      blockingQuery: "UPDATE orders SET status='pending'",
      lockType: "tuple",
      relation: "orders",
      requestedMode: "ExclusiveLock",
      grantedMode: "ExclusiveLock",
      waitTime: 42,
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

describe("buildBlockingLockForest", () => {
  it("returns an empty forest when there are no blocking rows", () => {
    expect(buildBlockingLockForest([])).toEqual({
      roots: [],
      rootBlockerCount: 0,
      blockedSessionCount: 0,
      idleInTransactionRootCount: 0,
      hasIdleInTransactionRoot: false,
      hasDeadlock: false,
      maxWaitTime: 0,
    });
  });

  it("builds a multi-level lock waiting chain (101 -> 102 -> 103) with accurate downstream counts and wait times", () => {
    const rows: BlockingLockRow[] = [
      {
        blockingPid: 101,
        blockingUser: "erp_batch",
        blockingDb: "erp",
        blockingState: "active",
        blockingXactTime: 95,
        blockingQuery: "ALTER TABLE invoices ADD COLUMN flag boolean",
        blockedPid: 102,
        blockedUser: "erp_api",
        blockedDb: "erp",
        blockedState: "active",
        blockedQuery: "UPDATE invoices SET paid = true WHERE id = 9",
        lockType: "relation",
        relation: "invoices",
        grantedMode: "AccessExclusiveLock",
        requestedMode: "RowExclusiveLock",
        waitTime: 40,
      },
      {
        blockingPid: 102,
        blockingUser: "erp_api",
        blockingDb: "erp",
        blockingState: "active",
        blockingXactTime: 41,
        blockingQuery: "UPDATE invoices SET paid = true WHERE id = 9",
        blockedPid: 103,
        blockedUser: "erp_report",
        blockedDb: "erp",
        blockedState: "active",
        blockedQuery: "SELECT * FROM customer_ledger WHERE id = 9 FOR UPDATE",
        lockType: "tuple",
        relation: "customer_ledger",
        grantedMode: "ExclusiveLock",
        requestedMode: "ShareLock",
        waitTime: 65,
      },
    ];

    const forest = buildBlockingLockForest(rows);
    expect(forest.rootBlockerCount).toBe(1);
    expect(forest.blockedSessionCount).toBe(2);
    expect(forest.hasDeadlock).toBe(false);
    expect(forest.hasIdleInTransactionRoot).toBe(false);
    expect(forest.maxWaitTime).toBe(65);

    const root = forest.roots[0];
    expect(root.pid).toBe(101);
    expect(root.isRootBlocker).toBe(true);
    expect(root.isDeadlockCycle).toBe(false);
    expect(root.holdOrWaitSeconds).toBe(95);
    expect(root.incomingLock).toBeUndefined();
    expect(root.directBlockedCount).toBe(1);
    expect(root.totalDownstreamCount).toBe(2);
    expect(root.maxDownstreamWaitTime).toBe(65);

    const mid = root.children[0];
    expect(mid.pid).toBe(102);
    expect(mid.isRootBlocker).toBe(false);
    expect(mid.holdOrWaitSeconds).toBe(40);
    expect(mid.incomingLock).toEqual({
      lockType: "relation",
      relation: "invoices",
      grantedMode: "AccessExclusiveLock",
      requestedMode: "RowExclusiveLock",
      waitTime: 40,
    });
    expect(mid.directBlockedCount).toBe(1);
    expect(mid.totalDownstreamCount).toBe(1);
    expect(mid.maxDownstreamWaitTime).toBe(65);

    const leaf = mid.children[0];
    expect(leaf.pid).toBe(103);
    expect(leaf.isRootBlocker).toBe(false);
    expect(leaf.holdOrWaitSeconds).toBe(65);
    expect(leaf.directBlockedCount).toBe(0);
    expect(leaf.totalDownstreamCount).toBe(0);
    expect(leaf.maxDownstreamWaitTime).toBe(0);
    expect(leaf.children).toEqual([]);
  });

  it("detects idle in transaction on root blockers from blockingState and from fallback sessions list", () => {
    const directRows: BlockingLockRow[] = [
      {
        blockingPid: 301,
        blockingUser: "dev_user",
        blockingDb: "app",
        blockingState: "idle in transaction (aborted)",
        blockingXactTime: 320,
        blockingQuery: "UPDATE accounts SET balance = balance - 100 WHERE id = 1",
        blockedPid: 302,
        blockedUser: "api_worker",
        blockedDb: "app",
        blockedState: "active",
        blockedQuery: "UPDATE accounts SET balance = balance + 50 WHERE id = 1",
        lockType: "transactionid",
        relation: "-",
        grantedMode: "ExclusiveLock",
        requestedMode: "ShareLock",
        waitTime: 75,
      },
    ];

    const directForest = buildBlockingLockForest(directRows);
    expect(directForest.hasIdleInTransactionRoot).toBe(true);
    expect(directForest.idleInTransactionRootCount).toBe(1);
    expect(directForest.roots[0].isIdleInTransaction).toBe(true);
    expect(directForest.roots[0].holdOrWaitSeconds).toBe(320);

    const legacyRowsWithoutState: BlockingLockRow[] = [
      {
        blockingPid: 401,
        blockingUser: "legacy_blocker",
        blockingDb: "app",
        blockingQuery: "BEGIN",
        blockedPid: 402,
        blockedUser: "legacy_waiter",
        blockedDb: "app",
        blockedQuery: "DELETE FROM sessions WHERE id = 7",
        lockType: "relation",
        relation: "sessions",
        grantedMode: "RowExclusiveLock",
        requestedMode: "AccessExclusiveLock",
        waitTime: 22,
      },
    ];

    const fallbackForest = buildBlockingLockForest(legacyRowsWithoutState, [
      { id: 401, user: "legacy_blocker", db: "app", state: "idle in transaction", time: 510, query: "UPDATE sessions SET active = false" },
      { id: 402, user: "legacy_waiter", db: "app", state: "active", time: 22 },
    ]);
    expect(fallbackForest.hasIdleInTransactionRoot).toBe(true);
    expect(fallbackForest.idleInTransactionRootCount).toBe(1);
    expect(fallbackForest.roots[0].isIdleInTransaction).toBe(true);
    expect(fallbackForest.roots[0].state).toBe("idle in transaction");
    expect(fallbackForest.roots[0].holdOrWaitSeconds).toBe(510);
  });

  it("deduplicates multiple lock rows between the same (blockingPid, blockedPid) pair", () => {
    const duplicateEdgeRows: BlockingLockRow[] = [
      {
        blockingPid: 501,
        blockingUser: "u1",
        blockingDb: "shop",
        blockingState: "idle in transaction",
        blockingXactTime: 90,
        blockingQuery: "UPDATE orders SET total = 10",
        blockedPid: 502,
        blockedUser: "u2",
        blockedDb: "shop",
        blockedState: "active",
        blockedQuery: "UPDATE orders SET total = 20",
        lockType: "transactionid",
        relation: "-",
        grantedMode: "ExclusiveLock",
        requestedMode: "ShareLock",
        waitTime: 18,
      },
      {
        blockingPid: 501,
        blockingUser: "u1",
        blockingDb: "shop",
        blockingState: "idle in transaction",
        blockingXactTime: 90,
        blockingQuery: "UPDATE orders SET total = 10",
        blockedPid: 502,
        blockedUser: "u2",
        blockedDb: "shop",
        blockedState: "active",
        blockedQuery: "UPDATE orders SET total = 20",
        lockType: "tuple",
        relation: "orders",
        grantedMode: "ExclusiveLock",
        requestedMode: "ExclusiveLock",
        waitTime: 44,
      },
      {
        blockingPid: 501,
        blockingUser: "u1",
        blockingDb: "shop",
        blockingState: "idle in transaction",
        blockingXactTime: 90,
        blockingQuery: "UPDATE orders SET total = 10",
        blockedPid: 502,
        blockedUser: "u2",
        blockedDb: "shop",
        blockedState: "active",
        blockedQuery: "UPDATE orders SET total = 20",
        lockType: "relation",
        relation: "order_items",
        grantedMode: "RowExclusiveLock",
        requestedMode: "AccessExclusiveLock",
        waitTime: 31,
      },
    ];

    const forest = buildBlockingLockForest(duplicateEdgeRows);
    expect(forest.rootBlockerCount).toBe(1);
    expect(forest.blockedSessionCount).toBe(1);
    expect(forest.roots[0].children).toHaveLength(1);
    expect(forest.roots[0].directBlockedCount).toBe(1);
    expect(forest.roots[0].totalDownstreamCount).toBe(1);

    const child = forest.roots[0].children[0];
    expect(child.pid).toBe(502);
    expect(child.incomingLock).toEqual({
      lockType: "transactionid, tuple, relation",
      relation: "orders, order_items",
      grantedMode: "ExclusiveLock, RowExclusiveLock",
      requestedMode: "ShareLock, ExclusiveLock, AccessExclusiveLock",
      waitTime: 44,
    });
  });

  it("terminates deadlock cycles (201 -> 202 -> 201) deterministically at lowest PID with isDeadlockCycle: true", () => {
    const cycleRows: BlockingLockRow[] = [
      {
        blockingPid: 202,
        blockingUser: "tx_b",
        blockingDb: "bank",
        blockingState: "active",
        blockingXactTime: 19,
        blockingQuery: "UPDATE accounts SET balance = balance - 10 WHERE id = 1",
        blockedPid: 201,
        blockedUser: "tx_a",
        blockedDb: "bank",
        blockedState: "active",
        blockedQuery: "UPDATE accounts SET balance = balance - 10 WHERE id = 2",
        lockType: "transactionid",
        relation: "accounts",
        grantedMode: "ExclusiveLock",
        requestedMode: "ShareLock",
        waitTime: 14,
      },
      {
        blockingPid: 201,
        blockingUser: "tx_a",
        blockingDb: "bank",
        blockingState: "active",
        blockingXactTime: 23,
        blockingQuery: "UPDATE accounts SET balance = balance - 10 WHERE id = 2",
        blockedPid: 202,
        blockedUser: "tx_b",
        blockedDb: "bank",
        blockedState: "active",
        blockedQuery: "UPDATE accounts SET balance = balance - 10 WHERE id = 1",
        lockType: "transactionid",
        relation: "accounts",
        grantedMode: "ExclusiveLock",
        requestedMode: "ShareLock",
        waitTime: 17,
      },
    ];

    const forest = buildBlockingLockForest(cycleRows);
    expect(forest.hasDeadlock).toBe(true);
    expect(forest.rootBlockerCount).toBe(1);
    expect(forest.blockedSessionCount).toBe(2);

    const cycleRoot = forest.roots[0];
    expect(cycleRoot.pid).toBe(201);
    expect(cycleRoot.isRootBlocker).toBe(true);
    expect(cycleRoot.isDeadlockCycle).toBe(true);
    expect(cycleRoot.directBlockedCount).toBe(1);
    expect(cycleRoot.totalDownstreamCount).toBe(1);
    expect(cycleRoot.maxDownstreamWaitTime).toBe(17);

    const cyclePartner = cycleRoot.children[0];
    expect(cyclePartner.pid).toBe(202);
    expect(cyclePartner.isDeadlockCycle).toBe(true);
    expect(cyclePartner.children).toEqual([]);
  });
});
