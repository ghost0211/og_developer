import type { QueryResult } from "@/types/database";

/**
 * PostgreSQL / openGauss "current activity / process list" helpers. Pure and
 * framework-free so they can be unit-tested in isolation; the generic panel
 * component wires them to the SQL bridge and the production-safety guard via
 * the driver registry.
 */

/**
 * One row per server-side backend. `now() - query_start` gives the age of the
 * currently running (or last) statement; we fall back to the transaction and
 * backend start so idle sessions still report a sensible age. Own session is
 * kept in the result set so the panel can dim it rather than hide it.
 */
export const PG_PROCESS_LIST_SQL = `SELECT pid,
       usename AS "user",
       datname AS db,
       coalesce(host(client_addr), client_hostname, 'local') AS client,
       application_name AS app,
       state,
       coalesce(nullif(wait_event_type, '') || ':' || wait_event, wait_event_type, '') AS wait,
       floor(extract(epoch FROM (now() - coalesce(query_start, xact_start, backend_start))))::bigint AS time,
       query
FROM pg_stat_activity
ORDER BY time DESC NULLS LAST`;

/** PostgreSQL 9.2-9.5 expose `waiting` instead of wait-event detail columns. */
export const PG_PROCESS_LIST_LEGACY_SQL = `SELECT pid,
       usename AS "user",
       datname AS db,
       coalesce(host(client_addr), client_hostname, 'local') AS client,
       application_name AS app,
       state,
       CASE WHEN waiting THEN 'Lock' ELSE '' END AS wait,
       floor(extract(epoch FROM (now() - coalesce(query_start, xact_start, backend_start))))::bigint AS time,
       query
FROM pg_stat_activity
ORDER BY time DESC NULLS LAST`;

/** openGauss exposes the legacy boolean `waiting` column rather than wait-event detail. */
export const OPENGAUSS_PROCESS_LIST_SQL = `SELECT pid,
       usename AS "user",
       datname AS db,
       coalesce(host(client_addr), client_hostname, 'local') AS client,
       application_name AS app,
       state,
       CASE WHEN waiting THEN 'Lock' ELSE '' END AS wait,
       CAST(floor(extract(epoch FROM (CURRENT_TIMESTAMP - coalesce(query_start, xact_start, backend_start)))) AS BIGINT) AS time,
       query
FROM pg_catalog.pg_stat_activity
ORDER BY time DESC NULLS LAST`;

/** Query for detecting active lock blocking chains */
export const PG_BLOCKING_LOCKS_SQL = `SELECT
       blocked_locks.pid AS blocked_pid,
       blocked_activity.usename AS blocked_user,
       blocked_activity.datname AS blocked_db,
       blocked_activity.query AS blocked_query,
       blocking_locks.pid AS blocking_pid,
       blocking_activity.usename AS blocking_user,
       blocking_activity.datname AS blocking_db,
       blocking_activity.query AS blocking_query,
       blocked_locks.locktype,
       coalesce(c.relname, CAST(blocked_locks.relation AS text), '-') AS relation,
       blocked_locks.mode AS requested_mode,
       blocking_locks.mode AS granted_mode,
       floor(extract(epoch FROM (now() - coalesce(blocked_activity.query_start, blocked_activity.xact_start, blocked_activity.backend_start))))::bigint AS wait_time
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
  AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
  AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
  AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
  AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
  AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
  AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
  AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
  AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
LEFT JOIN pg_catalog.pg_class c ON c.oid = blocked_locks.relation
WHERE NOT blocked_locks.granted
  AND blocking_locks.granted
ORDER BY wait_time DESC`;

export const OPENGAUSS_BLOCKING_LOCKS_SQL = PG_BLOCKING_LOCKS_SQL;

/** Query for detailed locks inspection */
export const PG_LOCKS_SQL = `SELECT
       l.pid,
       a.usename AS "user",
       a.datname AS db,
       l.locktype,
       coalesce(c.relname, CAST(l.relation AS text), '-') AS relation,
       l.mode,
       l.granted,
       floor(extract(epoch FROM (now() - coalesce(a.query_start, a.xact_start, a.backend_start))))::bigint AS time,
       a.query
FROM pg_catalog.pg_locks l
LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
LEFT JOIN pg_catalog.pg_class c ON c.oid = l.relation
WHERE l.pid <> pg_backend_pid()
ORDER BY l.granted ASC, time DESC NULLS LAST
LIMIT 300`;

export const OPENGAUSS_LOCKS_SQL = PG_LOCKS_SQL;

/** Scalar query that returns the viewer's own backend pid. */
export const PG_OWN_SESSION_SQL = "SELECT pg_backend_pid()";
export const OPENGAUSS_OWN_SESSION_SQL = "SELECT pg_backend_pid()";

export interface BlockingLockRow {
  blockedPid: number;
  blockedUser: string;
  blockedDb: string | null;
  blockedQuery: string | null;
  blockingPid: number;
  blockingUser: string;
  blockingDb: string | null;
  blockingQuery: string | null;
  lockType: string;
  relation: string;
  requestedMode: string;
  grantedMode: string;
  waitTime: number;
}

export interface LockDetailRow {
  pid: number;
  user: string;
  db: string | null;
  lockType: string;
  relation: string;
  mode: string;
  granted: boolean;
  time: number;
  query: string | null;
}

export interface PgProcessRow {
  id: number;
  user: string;
  db: string | null;
  client: string;
  app: string | null;
  state: string | null;
  wait: string | null;
  time: number;
  query: string | null;
}

function columnIndex(columns: string[], name: string): number {
  const target = name.toLowerCase();
  return columns.findIndex((column) => column.toLowerCase() === target);
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length === 0 ? null : text;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Map a `pg_stat_activity` result into typed rows. Column names are matched
 * case-insensitively and any missing column degrades to an empty value rather
 * than throwing, so forks that rename or drop a column still render.
 */
export function mapPgProcessRows(result: QueryResult | null | undefined): PgProcessRow[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return [];
  const columns = result.columns;
  const pidIdx = columnIndex(columns, "pid");
  const userIdx = columnIndex(columns, "user");
  const dbIdx = columnIndex(columns, "db");
  const clientIdx = columnIndex(columns, "client");
  const appIdx = columnIndex(columns, "app");
  const stateIdx = columnIndex(columns, "state");
  const waitIdx = columnIndex(columns, "wait");
  const timeIdx = columnIndex(columns, "time");
  const queryIdx = columnIndex(columns, "query");

  const cell = (row: (string | number | boolean | null)[], idx: number) => (idx >= 0 ? row[idx] : null);

  return result.rows.map((row) => ({
    id: asNumber(cell(row, pidIdx)),
    user: asString(cell(row, userIdx)),
    db: asNullableString(cell(row, dbIdx)),
    client: asString(cell(row, clientIdx)),
    app: asNullableString(cell(row, appIdx)),
    state: asNullableString(cell(row, stateIdx)),
    wait: asNullableString(cell(row, waitIdx)),
    time: asNumber(cell(row, timeIdx)),
    query: asNullableString(cell(row, queryIdx)),
  }));
}

export function mapPgBlockingLockRows(result: QueryResult | null | undefined): BlockingLockRow[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return [];
  const columns = result.columns;
  const bBlockedPid = columnIndex(columns, "blocked_pid");
  const bBlockedUser = columnIndex(columns, "blocked_user");
  const bBlockedDb = columnIndex(columns, "blocked_db");
  const bBlockedQuery = columnIndex(columns, "blocked_query");
  const bBlockingPid = columnIndex(columns, "blocking_pid");
  const bBlockingUser = columnIndex(columns, "blocking_user");
  const bBlockingDb = columnIndex(columns, "blocking_db");
  const bBlockingQuery = columnIndex(columns, "blocking_query");
  const bLockType = columnIndex(columns, "locktype");
  const bRelation = columnIndex(columns, "relation");
  const bReqMode = columnIndex(columns, "requested_mode");
  const bGrantMode = columnIndex(columns, "granted_mode");
  const bWaitTime = columnIndex(columns, "wait_time");

  const cell = (row: (string | number | boolean | null)[], idx: number) => (idx >= 0 ? row[idx] : null);

  return result.rows.map((row) => ({
    blockedPid: asNumber(cell(row, bBlockedPid)),
    blockedUser: asString(cell(row, bBlockedUser)),
    blockedDb: asNullableString(cell(row, bBlockedDb)),
    blockedQuery: asNullableString(cell(row, bBlockedQuery)),
    blockingPid: asNumber(cell(row, bBlockingPid)),
    blockingUser: asString(cell(row, bBlockingUser)),
    blockingDb: asNullableString(cell(row, bBlockingDb)),
    blockingQuery: asNullableString(cell(row, bBlockingQuery)),
    lockType: asString(cell(row, bLockType)),
    relation: asString(cell(row, bRelation)),
    requestedMode: asString(cell(row, bReqMode)),
    grantedMode: asString(cell(row, bGrantMode)),
    waitTime: asNumber(cell(row, bWaitTime)),
  }));
}

export function mapPgLockRows(result: QueryResult | null | undefined): LockDetailRow[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return [];
  const columns = result.columns;
  const pidIdx = columnIndex(columns, "pid");
  const userIdx = columnIndex(columns, "user");
  const dbIdx = columnIndex(columns, "db");
  const lockTypeIdx = columnIndex(columns, "locktype");
  const relationIdx = columnIndex(columns, "relation");
  const modeIdx = columnIndex(columns, "mode");
  const grantedIdx = columnIndex(columns, "granted");
  const timeIdx = columnIndex(columns, "time");
  const queryIdx = columnIndex(columns, "query");

  const cell = (row: (string | number | boolean | null)[], idx: number) => (idx >= 0 ? row[idx] : null);

  return result.rows.map((row) => {
    const rawGranted = cell(row, grantedIdx);
    const granted = rawGranted === true || rawGranted === 1 || String(rawGranted).toLowerCase() === "t" || String(rawGranted).toLowerCase() === "true";
    return {
      pid: asNumber(cell(row, pidIdx)),
      user: asString(cell(row, userIdx)),
      db: asNullableString(cell(row, dbIdx)),
      lockType: asString(cell(row, lockTypeIdx)),
      relation: asString(cell(row, relationIdx)),
      mode: asString(cell(row, modeIdx)),
      granted,
      time: asNumber(cell(row, timeIdx)),
      query: asNullableString(cell(row, queryIdx)),
    };
  });
}

/**
 * Build a `SELECT pg_terminate_backend(<pid>)` statement. `pid` is validated as a
 * finite positive integer (never interpolated as free text) so there is no
 * injection path.
 */
function validateBackendPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid backend pid: ${pid}`);
  }
}

export function buildPgKillSql(pid: number): string {
  validateBackendPid(pid);
  return `SELECT pg_terminate_backend(${pid})`;
}

export function buildPgCancelSql(pid: number): string {
  validateBackendPid(pid);
  return `SELECT pg_cancel_backend(${pid})`;
}

/** Return an error when PostgreSQL declines to terminate the target backend. */
export function pgKillResultError(results: QueryResult[]): string | null {
  return backendKillResultError(results, "pg_terminate_backend");
}

function backendKillResultError(results: QueryResult[], functionName: string): string | null {
  const result = results.find((item) => item.execution_error !== true);
  const value = result?.rows?.[0]?.[0];
  if (value === true || value === 1 || String(value).toLowerCase() === "t" || String(value).toLowerCase() === "true") return null;
  return `${functionName} did not terminate the backend`;
}

/** Detect the undefined-column failure produced by pre-9.6 pg_stat_activity. */
export function isPgProcessListCompatibilityError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "42703") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:wait_event_type|wait_event).*(?:does not exist|42703)|(?:does not exist|42703).*(?:wait_event_type|wait_event)/i.test(message);
}
