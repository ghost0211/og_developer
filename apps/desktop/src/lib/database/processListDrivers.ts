import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { buildMysqlCancelSql, buildKillSql as buildMysqlKillSql, mapProcessRows as mapMysqlProcessRows, PROCESS_LIST_SQL as MYSQL_PROCESS_LIST_SQL, supportsProcessList as supportsMysqlProcessList } from "./mysqlProcessList";
import {
  buildKingbaseCancelSql,
  buildKingbaseKillSql,
  buildKingbasePgKillSql,
  buildPgCancelSql,
  buildPgKillSql,
  isKingbaseOwnSessionCatalogCompatibilityError,
  isKingbaseProcessListCatalogCompatibilityError,
  isKingbaseTerminateCatalogCompatibilityError,
  isPgProcessListCompatibilityError,
  kingbaseKillResultError,
  kingbasePgKillResultError,
  KINGBASE_OWN_SESSION_SQL,
  KINGBASE_PG_OWN_SESSION_SQL,
  KINGBASE_PG_PROCESS_LIST_SQL,
  KINGBASE_PROCESS_LIST_SQL,
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
 */

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

const MYSQL_COLUMNS: ProcessColumn[] = [
  { key: "id", labelKey: "processList.colId", mono: true, numeric: true },
  { key: "user", labelKey: "processList.colUser" },
  { key: "host", labelKey: "processList.colHost" },
  { key: "db", labelKey: "processList.colDb" },
  { key: "command", labelKey: "processList.colCommand" },
  { key: "time", labelKey: "processList.colTime", mono: true, numeric: true },
  { key: "state", labelKey: "processList.colState" },
  { key: "info", labelKey: "processList.colInfo", mono: true, wide: true },
];

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

const MYSQL_DRIVER: ProcessListDriver = {
  listSql: MYSQL_PROCESS_LIST_SQL,
  ownSessionSql: "SELECT CONNECTION_ID()",
  columns: MYSQL_COLUMNS,
  defaultSortKey: "time",
  maxRows: 5000,
  // Typed structs carry no index signature; they are plain string-keyed objects at runtime.
  mapRows: (result) => mapMysqlProcessRows(result) as unknown as ProcessRow[],
  buildKillSql: buildMysqlKillSql,
  buildCancelSql: buildMysqlCancelSql,
};

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

const KINGBASE_DRIVER: ProcessListDriver = {
  listSql: KINGBASE_PROCESS_LIST_SQL,
  fallbackListSql: KINGBASE_PG_PROCESS_LIST_SQL,
  shouldUseFallbackListSql: isKingbaseProcessListCatalogCompatibilityError,
  ownSessionSql: KINGBASE_OWN_SESSION_SQL,
  fallbackOwnSessionSql: KINGBASE_PG_OWN_SESSION_SQL,
  shouldUseFallbackOwnSessionSql: isKingbaseOwnSessionCatalogCompatibilityError,
  columns: POSTGRES_COLUMNS,
  defaultSortKey: "time",
  maxRows: 5000,
  mapRows: (result) => mapPgProcessRows(result) as unknown as ProcessRow[],
  buildKillSql: buildKingbaseKillSql,
  buildCancelSql: buildKingbaseCancelSql,
  buildFallbackKillSql: buildKingbasePgKillSql,
  shouldUseFallbackKillSql: isKingbaseTerminateCatalogCompatibilityError,
  killResultError: kingbaseKillResultError,
  fallbackKillResultError: kingbasePgKillResultError,
  blockingLocksSql: PG_BLOCKING_LOCKS_SQL,
  mapBlockingLocks: mapPgBlockingLockRows,
  locksSql: PG_LOCKS_SQL,
  mapLocks: mapPgLockRows,
};

/** Resolve the process-list driver for a connection, or null if unsupported. */
export function resolveProcessListDriver(dbType: DatabaseType | undefined): ProcessListDriver | null {
  if (supportsMysqlProcessList(dbType)) return MYSQL_DRIVER;
  if (dbType === "postgres") return POSTGRES_DRIVER;
  if (dbType === "opengauss") return OPENGAUSS_DRIVER;
  if (dbType === "kingbase") return KINGBASE_DRIVER;
  return null;
}

/** Whether any process-list viewer (MySQL or Postgres family) covers this engine. */
export function supportsProcessList(dbType: DatabaseType | undefined): boolean {
  return resolveProcessListDriver(dbType) !== null;
}

/**
 * JDBC profiles that only borrow MySQL SQL syntax (Kyuubi / HiveServer2) infer as
 * `mysql` but are Spark/Hive engines that cannot serve `SHOW FULL PROCESSLIST`.
 */
const MYSQL_LOOKALIKE_JDBC = /(?:kyuubi|hive2|org\.apache\.hive\.jdbc\.HiveDriver|hive-jdbc)/i;

/**
 * Resolve the process-list driver from the real connection profile. Uses the
 * effective engine (so JDBC connections that resolve to MySQL/Postgres work) and
 * excludes MySQL-lookalike JDBC engines that cannot serve the process list.
 */
export function resolveProcessListDriverForConnection(connection: ConnectionConfig | undefined): ProcessListDriver | null {
  if (!connection) return null;
  if (connection.db_type === "jdbc") {
    const profile = [connection.driver_profile, connection.connection_string, connection.jdbc_driver_class, ...(connection.jdbc_driver_paths ?? [])].filter(Boolean).join("\n");
    if (MYSQL_LOOKALIKE_JDBC.test(profile)) return null;
  }
  const dbType = effectiveDatabaseTypeForConnection(connection);
  if (dbType === "gaussdb" && /(?:^|-)opengauss(?:-jdbc)?$/i.test(connection.driver_profile ?? "")) return OPENGAUSS_DRIVER;
  return resolveProcessListDriver(dbType);
}

/** Connection-aware process-list gate (mirrors the server-dashboard gate). */
export function connectionSupportsProcessList(connection: ConnectionConfig | undefined): boolean {
  return resolveProcessListDriverForConnection(connection) !== null;
}
