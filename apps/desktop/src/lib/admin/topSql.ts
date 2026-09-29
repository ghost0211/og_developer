import type { QueryResult } from "@/types/database";

/**
 * PostgreSQL / openGauss "Top SQL" (pg_stat_statements) helpers.
 *
 * Pure and framework-free so they can be unit-tested in isolation. The panel
 * component wires them to the SQL bridge (`api.executeQuery`) — no backend
 * plugin is involved, mirroring the process-list approach.
 *
 * Version differences handled here:
 *  - PostgreSQL 14+ renamed `total_time`/`mean_time` to
 *    `total_exec_time`/`mean_exec_time` (planning time got its own columns).
 *  - PostgreSQL 13 and earlier (and openGauss) still expose
 *    `total_time`/`mean_time`.
 * The available column list read from `information_schema` decides which one
 * to project; every output column is aliased to a stable name.
 */

/** Sort selector offered by the panel toolbar. */
export type TopSqlOrderBy = "total" | "mean" | "calls" | "rows" | "read";

/** Stable output aliases produced by {@link buildTopSqlQuery}. */
export interface TopSqlRow {
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rowsTotal: number;
  sharedBlksRead: number;
  sharedBlksHit: number;
}

/** Columns we try to project, in output order. */
export const TOP_SQL_OUTPUT_COLUMNS = ["query", "calls", "total_ms", "mean_ms", "rows_total", "shared_blks_read", "shared_blks_hit"] as const;

/**
 * Columns assumed when `information_schema` could not report the view columns
 * (for example a permissions gap). Defaults to the PostgreSQL 14+ names.
 */
const DEFAULT_COLUMNS = ["query", "calls", "total_exec_time", "mean_exec_time", "rows", "shared_blks_read", "shared_blks_hit"];

/** Candidate source columns per sort key, best match first. */
const ORDER_COLUMN_CANDIDATES: Record<TopSqlOrderBy, string[]> = {
  total: ["total_exec_time", "total_time"],
  mean: ["mean_exec_time", "mean_time"],
  calls: ["calls"],
  rows: ["rows"],
  read: ["shared_blks_read"],
};

/** Availability probe: is pg_stat_statements installed as an extension? */
export function buildTopSqlAvailabilitySql(): string {
  return `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')`;
}

/**
 * Column discovery scoped to `public` (the usual install schema for the
 * pg_stat_statements view). Pair with {@link buildTopSqlColumnsFallbackSql}
 * when the view lives elsewhere.
 */
export function buildTopSqlColumnsSql(): string {
  return `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pg_stat_statements'`;
}

/** Unscoped column discovery, used when the public-scoped probe is empty. */
export function buildTopSqlColumnsFallbackSql(): string {
  return `SELECT column_name FROM information_schema.columns WHERE table_name = 'pg_stat_statements'`;
}

/** Whether a column name exists in the reported column list (case-insensitive). */
export function hasTopSqlColumn(availableColumns: readonly string[], column: string): boolean {
  const needle = column.toLowerCase();
  return availableColumns.some((item) => item.toLowerCase() === needle);
}

/**
 * Resolve the real source column used for `ORDER BY`.
 * Returns null when none of the candidates exist in `availableColumns`.
 */
export function resolveTopSqlOrderColumn(availableColumns: readonly string[], orderBy: TopSqlOrderBy): string | null {
  const candidates = ORDER_COLUMN_CANDIDATES[orderBy] ?? [];
  for (const candidate of candidates) {
    if (hasTopSqlColumn(availableColumns, candidate)) return candidate;
  }
  return null;
}

/** Pick a usable sort column, falling back to the first available metric. */
function resolveEffectiveOrderColumn(availableColumns: readonly string[], orderBy: TopSqlOrderBy): string | null {
  const preferred = resolveTopSqlOrderColumn(availableColumns, orderBy);
  if (preferred) return preferred;
  const fallbackOrder: TopSqlOrderBy[] = ["total", "mean", "calls", "rows", "read"];
  for (const candidate of fallbackOrder) {
    const resolved = resolveTopSqlOrderColumn(availableColumns, candidate);
    if (resolved) return resolved;
  }
  return null;
}

/** Sanitize the TOP N limit to a bounded positive integer. */
export function normalizeTopSqlLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(1000, Math.max(1, Math.floor(limit)));
}

/**
 * Build the ranking query.
 *
 * @param availableColumns Columns reported by `information_schema`. An empty
 *   list falls back to the modern PostgreSQL 14+ column names so the panel can
 *   still attempt a query.
 * @param orderBy Sort selector chosen by the user.
 * @param limit TOP N (bounded to 1..1000).
 */
export function buildTopSqlQuery(availableColumns: readonly string[], orderBy: TopSqlOrderBy, limit: number): string {
  const columns = availableColumns.length > 0 ? availableColumns : DEFAULT_COLUMNS;

  const totalColumn = hasTopSqlColumn(columns, "total_exec_time") ? "total_exec_time" : hasTopSqlColumn(columns, "total_time") ? "total_time" : null;
  const meanColumn = hasTopSqlColumn(columns, "mean_exec_time") ? "mean_exec_time" : hasTopSqlColumn(columns, "mean_time") ? "mean_time" : null;

  // Time columns stay NULL when unknown (0 would read as "instant"); counters
  // and block counts fall back to 0 so clients can aggregate them safely.
  const projections = [
    `query`,
    hasTopSqlColumn(columns, "calls") ? `calls AS calls` : `0 AS calls`,
    totalColumn ? `${totalColumn} AS total_ms` : `NULL AS total_ms`,
    meanColumn ? `${meanColumn} AS mean_ms` : `NULL AS mean_ms`,
    hasTopSqlColumn(columns, "rows") ? `rows AS rows_total` : `0 AS rows_total`,
    hasTopSqlColumn(columns, "shared_blks_read") ? `shared_blks_read AS shared_blks_read` : `0 AS shared_blks_read`,
    hasTopSqlColumn(columns, "shared_blks_hit") ? `shared_blks_hit AS shared_blks_hit` : `0 AS shared_blks_hit`,
  ];

  const orderColumn = resolveEffectiveOrderColumn(columns, orderBy) ?? "calls";
  const safeLimit = normalizeTopSqlLimit(limit);

  return [`SELECT`, projections.map((line) => `  ${line}`).join(",\n"), `FROM pg_stat_statements`, `ORDER BY ${orderColumn} DESC NULLS LAST`, `LIMIT ${safeLimit}`].join("\n");
}

/** Index of a result column by name, or -1 when absent (case-insensitive). */
function columnIndex(result: QueryResult, name: string): number {
  const needle = name.toLowerCase();
  return result.columns.findIndex((column) => column.toLowerCase() === needle);
}

/** Read one cell as a finite number; non-numeric/missing values become 0. */
function readNumber(row: QueryResult["rows"][number], index: number): number {
  if (index < 0) return 0;
  const raw = row[index];
  if (raw === null || raw === undefined || raw === "") return 0;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Read one cell as trimmed text. */
function readText(row: QueryResult["rows"][number], index: number): string {
  if (index < 0) return "";
  const raw = row[index];
  return raw === null || raw === undefined ? "" : String(raw).trim();
}

/** Map a `QueryResult` from {@link buildTopSqlQuery} into structured rows. */
export function mapTopSqlRows(result: QueryResult | null | undefined): TopSqlRow[] {
  if (!result || !Array.isArray(result.rows)) return [];
  const indexes = {
    query: columnIndex(result, "query"),
    calls: columnIndex(result, "calls"),
    totalMs: columnIndex(result, "total_ms"),
    meanMs: columnIndex(result, "mean_ms"),
    rowsTotal: columnIndex(result, "rows_total"),
    sharedBlksRead: columnIndex(result, "shared_blks_read"),
    sharedBlksHit: columnIndex(result, "shared_blks_hit"),
  };
  return result.rows.map((row) => ({
    query: readText(row, indexes.query),
    calls: readNumber(row, indexes.calls),
    totalMs: readNumber(row, indexes.totalMs),
    meanMs: readNumber(row, indexes.meanMs),
    rowsTotal: readNumber(row, indexes.rowsTotal),
    sharedBlksRead: readNumber(row, indexes.sharedBlksRead),
    sharedBlksHit: readNumber(row, indexes.sharedBlksHit),
  }));
}

/** Read the boolean result of {@link buildTopSqlAvailabilitySql}. */
export function mapTopSqlAvailability(result: QueryResult | null | undefined): boolean {
  const raw = result?.rows?.[0]?.[0];
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "boolean") return raw;
  const text = String(raw).trim().toLowerCase();
  return text === "true" || text === "t" || text === "1";
}

/** Read the column-name list produced by the column discovery queries. */
export function mapTopSqlColumns(result: QueryResult | null | undefined): string[] {
  if (!result || !Array.isArray(result.rows)) return [];
  return result.rows.map((row) => (row[0] === null || row[0] === undefined ? "" : String(row[0]).trim())).filter((name) => name.length > 0);
}

/** Trim redundant trailing zeros from a fixed-point string ("1.20" -> "1.2"). */
function trimFixed(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/**
 * Format a millisecond duration for display.
 * `1230` -> "1.23 s", `456` -> "456 ms", `null` -> "-".
 */
export function formatTopSqlDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  const abs = Math.abs(ms);
  if (abs >= 1000) return `${trimFixed((ms / 1000).toFixed(2))} s`;
  if (abs >= 10) return `${trimFixed(ms.toFixed(0))} ms`;
  return `${trimFixed(ms.toFixed(2))} ms`;
}

/** Format a count with locale-independent thousands separators. */
export function formatTopSqlCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---------- openGauss 内置 dbe_perf.statement 数据源 ----------
// 精简发行版的 openGauss 不随附 pg_stat_statements 扩展控制文件（pg_available_extensions
// 里查不到），CREATE EXTENSION 会报 "could not open extension control file"。此时
// 可回退到内置静态性能视图 dbe_perf.statement（需 enable_stmt_track=on，访问需要
// MONADMIN 及以上权限）。该视图为实例级统计（无 db_name 列），时间列单位是微秒，
// 统一换算成毫秒以对齐 pg_stat_statements 的列语义。

/** Where the statement statistics for the Top SQL panel come from. */
export type TopSqlSource = "pg_stat_statements" | "dbe_perf" | "dbe_perf_denied" | "unavailable";

/**
 * Probe whether dbe_perf.statement is queryable. PostgreSQL checks relation ACLs
 * at parse/plan time, so a zero-row query still raises "permission denied" for
 * users without MONADMIN — which is exactly what we want to detect.
 */
export const DBE_PERF_STATEMENT_PROBE_SQL = "SELECT 1 FROM dbe_perf.statement WHERE FALSE";

export type DbePerfProbeResult = "ok" | "denied" | "missing" | "error";

/** Classify the error thrown by {@link DBE_PERF_STATEMENT_PROBE_SQL}. */
export function classifyDbePerfProbeError(message: string): Exclude<DbePerfProbeResult, "ok"> {
  const text = message.toLowerCase();
  if (text.includes("permission denied")) return "denied";
  if (text.includes("does not exist") || (text.includes("relation") && text.includes("not"))) return "missing";
  return "error";
}

/** ORDER BY aliases produced by {@link buildDbePerfTopSqlQuery}. */
const DBE_PERF_SORT_COLUMNS: Record<TopSqlOrderBy, string> = {
  total: "total_ms",
  mean: "mean_ms",
  calls: "calls",
  rows: "rows_total",
  read: "shared_blks_read",
};

/**
 * Build the dbe_perf.statement ranking query with the same output aliases as
 * {@link buildTopSqlQuery}, so results flow through the same mapping/display code.
 */
export function buildDbePerfTopSqlQuery(orderBy: TopSqlOrderBy, limit: number): string {
  const orderColumn = DBE_PERF_SORT_COLUMNS[orderBy] ?? "total_ms";
  const safeLimit = normalizeTopSqlLimit(limit);
  return [
    "SELECT",
    "  s.query AS query",
    "  , s.n_calls AS calls",
    "  , s.total_elapse_time / 1000.0 AS total_ms",
    "  , s.total_elapse_time / 1000.0 / NULLIF(s.n_calls, 0) AS mean_ms",
    "  , s.n_returned_rows AS rows_total",
    "  , s.n_blocks_fetched AS shared_blks_read",
    "  , s.n_blocks_hit AS shared_blks_hit",
    "FROM dbe_perf.statement s",
    `ORDER BY ${orderColumn} DESC NULLS LAST`,
    `LIMIT ${safeLimit}`,
  ].join("\n");
}

// ---------- 服务端 SQL 文本长度上限（截断检测） ----------
// 两种数据源都在服务端按字节上限截断语句文本，超出部分根本没有存储，任何
// 客户端都无法取回：
//  - dbe_perf.statement    → track_stmt_details_size（默认 4096，user 上下文，reload 生效）
//  - pg_stat_statements    → track_activity_query_size（默认 1024，postmaster，需重启）

/** GUC parameter that caps stored statement text for the given source. */
export function topSqlTextCapParameter(source: "pg_stat_statements" | "dbe_perf"): string {
  return source === "dbe_perf" ? "track_stmt_details_size" : "track_activity_query_size";
}

/** Read the current byte cap from pg_settings (world-readable). */
export function buildTopSqlTextCapSql(source: "pg_stat_statements" | "dbe_perf"): string {
  return `SELECT setting FROM pg_settings WHERE name = '${topSqlTextCapParameter(source)}'`;
}

/** Count statements whose stored text reached the byte cap (i.e. truncated). */
export function buildTopSqlTruncatedCountSql(source: "pg_stat_statements" | "dbe_perf", bytes: number): string {
  const table = source === "dbe_perf" ? "dbe_perf.statement" : "pg_stat_statements";
  const safeBytes = Number.isFinite(bytes) ? Math.max(1, Math.floor(bytes)) : 0;
  return `SELECT count(*) FROM ${table} WHERE octet_length(query) >= ${safeBytes}`;
}

/** Map a single-cell integer query result (cap setting / truncated count). */
export function mapTopSqlSingleInteger(result: QueryResult | null | undefined): number {
  const raw = result?.rows?.[0]?.[0];
  if (raw === null || raw === undefined) return 0;
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Suggested fix SQL for a source at its current cap (target: 4x, at least 16 KiB). */
export function buildTopSqlTextCapFixSql(source: "pg_stat_statements" | "dbe_perf", currentBytes: number): { alterSql: string; needsRestart: boolean } {
  const parameter = topSqlTextCapParameter(source);
  const target = Math.max(16384, currentBytes * 4);
  return {
    alterSql: `ALTER SYSTEM SET ${parameter} = ${target};`,
    // track_activity_query_size is a postmaster parameter; track_stmt_details_size reloads.
    needsRestart: source !== "dbe_perf",
  };
}
