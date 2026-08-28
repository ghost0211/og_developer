import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import {
  buildPgCancelSql,
  buildPgKillSql,
  isPgProcessListCompatibilityError,
  mapPgBlockingLockRows,
  mapPgLockRows,
  mapPgProcessRows,
  OPENGAUSS_BLOCKING_LOCKS_SQL,
  OPENGAUSS_LOCKS_SQL,
  OPENGAUSS_OWN_SESSION_SQL,
  OPENGAUSS_PROCESS_LIST_SQL,
  pgKillResultError,
  PG_BLOCKING_LOCKS_SQL,
  PG_LOCKS_SQL,
  PG_OWN_SESSION_SQL,
  PG_PROCESS_LIST_LEGACY_SQL,
  PG_PROCESS_LIST_SQL,
  type BlockingLockRow,
  type LockDetailRow,
} from "./postgresProcessList";

/**
 * Engine-agnostic process-list model. Each supported engine contributes a driver
 * describing how to list sessions, identify the caller's own session, render the
 * columns, and kill a session. The panel component stays entirely generic.
 *
 * The generic bits (coordinator, interval clamping, execution-error extraction)
 * also live here so the panel can wire them to any driver.
 */

/** Bounds for the auto-refresh interval, in seconds. */
export const MIN_REFRESH_SECONDS = 1;
export const MAX_REFRESH_SECONDS = 3600;
export const DEFAULT_REFRESH_SECONDS = 5;

export interface ProcessListLoadCoordinator {
  tryStart(): boolean;
  finish(): void;
}

/**
 * Keep manual and timer-driven refreshes on the same single-flight guard. Slow
 * servers must not accumulate process-list queries faster than they complete.
 */
export function createProcessListLoadCoordinator(): ProcessListLoadCoordinator {
  let inFlight = false;
  return {
    tryStart() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    finish() {
      inFlight = false;
    },
  };
}

export function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_REFRESH_SECONDS;
  const floored = Math.floor(seconds);
  if (floored < MIN_REFRESH_SECONDS) return MIN_REFRESH_SECONDS;
  if (floored > MAX_REFRESH_SECONDS) return MAX_REFRESH_SECONDS;
  return floored;
}

/** Return the server-provided message for the first failed batch statement. */
export function processListExecutionError(results: QueryResult[]): string | null {
  const failed = results.find((result) => result.execution_error === true);
  if (!failed) return null;
  const message = failed.rows?.[0]?.[0];
  return message === null || message === undefined || String(message).length === 0 ? "Query execution failed" : String(message);
}

/** A displayable session row. `id` is the value passed to the driver's kill SQL. */
export type ProcessRow = { id: number } & Record<string, string | number | null>;

export interface ProcessColumn {
  /** Key into the mapped row. */
  key: string;
  /** i18n key for the header label. */
  labelKey: string;
  /** Render the cell in a monospace font. */
  mono?: boolean;
  /** Sort numerically and default to descending on first click. */
  numeric?: boolean;
  /** Long free text (SQL statement) — truncate with a hover title. */
  wide?: boolean;
}

export interface ProcessListDriver {
  /** SQL that lists current sessions, one row each. */
  listSql: string;
  /** Compatibility query used when the primary list SQL references newer columns. */
  fallbackListSql?: string;
  /** Restrict fallback attempts to known version-compatibility failures. */
  shouldUseFallbackListSql?(error: unknown): boolean;
  /** Scalar SQL returning the caller's own session id (nullable path tolerated). */
  ownSessionSql: string;
  /** Compatibility query used when the primary own-session function is unavailable. */
  fallbackOwnSessionSql?: string;
  /** Restrict own-session fallback attempts to known compatibility failures. */
  shouldUseFallbackOwnSessionSql?(error: unknown): boolean;
  /** Columns to render, in display order. */
  columns: ProcessColumn[];
  /** Column key used for the initial sort. */
  defaultSortKey: string;
  /** Upper bound on rows fetched per refresh. */
  maxRows: number;
  /** Map a raw list result into typed rows. */
  mapRows(result: QueryResult | null | undefined): ProcessRow[];
  /** Build the validated statement that kills the given session id. */
  buildKillSql(id: number): string;
  /** Build the statement that cancels the running query without killing the connection. */
  buildCancelSql?(id: number): string;
  /** SQL that queries active blocking locks chains. */
  blockingLocksSql?: string;
  /** Map raw blocking locks query result into typed rows. */
  mapBlockingLocks?(result: QueryResult | null | undefined): BlockingLockRow[];
  /** SQL that queries resource locks. */
  locksSql?: string;
  /** Map raw locks query result into typed rows. */
  mapLocks?(result: QueryResult | null | undefined): LockDetailRow[];
  /** Build the compatibility statement used when the primary kill function is unavailable. */
  buildFallbackKillSql?(id: number): string;
  /** Restrict kill fallback attempts to known compatibility failures. */
  shouldUseFallbackKillSql?(error: unknown): boolean;
  /** Validate any engine-specific success value returned by the kill statement. */
  killResultError?(results: QueryResult[]): string | null;
  /** Validate the success value returned by the compatibility kill statement. */
  fallbackKillResultError?(results: QueryResult[]): string | null;
}

const POSTGRES_COLUMNS: ProcessColumn[] = [
  { key: "id", labelKey: "processList.colPid", mono: true, numeric: true },
  { key: "user", labelKey: "processList.colUser" },
  { key: "db", labelKey: "processList.colDb" },
  { key: "client", labelKey: "processList.colClient" },
  { key: "app", labelKey: "processList.colApp" },
  { key: "state", labelKey: "processList.colState" },
  { key: "wait", labelKey: "processList.colWait" },
  { key: "time", labelKey: "processList.colTime", mono: true, numeric: true },
  { key: "query", labelKey: "processList.colQuery", mono: true, wide: true },
];

const POSTGRES_DRIVER: ProcessListDriver = {
  listSql: PG_PROCESS_LIST_SQL,
  fallbackListSql: PG_PROCESS_LIST_LEGACY_SQL,
  shouldUseFallbackListSql: isPgProcessListCompatibilityError,
  ownSessionSql: PG_OWN_SESSION_SQL,
  columns: POSTGRES_COLUMNS,
  defaultSortKey: "time",
  maxRows: 5000,
  mapRows: (result) => mapPgProcessRows(result) as unknown as ProcessRow[],
  buildKillSql: buildPgKillSql,
  buildCancelSql: buildPgCancelSql,
  killResultError: pgKillResultError,
  blockingLocksSql: PG_BLOCKING_LOCKS_SQL,
  mapBlockingLocks: mapPgBlockingLockRows,
  locksSql: PG_LOCKS_SQL,
  mapLocks: mapPgLockRows,
};

const OPENGAUSS_DRIVER: ProcessListDriver = {
  listSql: OPENGAUSS_PROCESS_LIST_SQL,
  ownSessionSql: OPENGAUSS_OWN_SESSION_SQL,
  columns: POSTGRES_COLUMNS,
  defaultSortKey: "time",
  maxRows: 5000,
  mapRows: (result) => mapPgProcessRows(result) as unknown as ProcessRow[],
  buildKillSql: buildPgKillSql,
  buildCancelSql: buildPgCancelSql,
  killResultError: pgKillResultError,
  blockingLocksSql: OPENGAUSS_BLOCKING_LOCKS_SQL,
  mapBlockingLocks: mapPgBlockingLockRows,
  locksSql: OPENGAUSS_LOCKS_SQL,
  mapLocks: mapPgLockRows,
};

/** Resolve the process-list driver for a connection, or null if unsupported. */
export function resolveProcessListDriver(dbType: DatabaseType | undefined): ProcessListDriver | null {
  if (dbType === "postgres") return POSTGRES_DRIVER;
  if (dbType === "opengauss") return OPENGAUSS_DRIVER;
  return null;
}

/** Whether any process-list viewer covers this engine. */
export function supportsProcessList(dbType: DatabaseType | undefined): boolean {
  return resolveProcessListDriver(dbType) !== null;
}

/**
 * Resolve the process-list driver from the real connection profile, using the
 * effective engine so JDBC connections that resolve to Postgres/openGauss work.
 */
export function resolveProcessListDriverForConnection(connection: ConnectionConfig | undefined): ProcessListDriver | null {
  if (!connection) return null;
  const dbType = effectiveDatabaseTypeForConnection(connection);
  if (dbType === "opengauss") return OPENGAUSS_DRIVER;
  if (dbType === "postgres") return POSTGRES_DRIVER;
  return null;
}

/** Connection-aware process-list gate (mirrors the server-dashboard gate). */
export function connectionSupportsProcessList(connection: ConnectionConfig | undefined): boolean {
  return resolveProcessListDriverForConnection(connection) !== null;
}
