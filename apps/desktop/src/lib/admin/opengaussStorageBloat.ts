import type { QueryResult } from "@/types/database";

/**
 * openGauss / PostgreSQL storage, tablespace, dead-tuple bloat, and unused-index
 * advisor helpers. Pure and framework-free so queries, parsers, and maintenance
 * SQL generators can be unit-tested in isolation.
 */

export interface TablespaceInfo {
  name: string;
  owner: string;
  location: string;
  sizeBytes: number | null;
}

export interface RelationStorageRow {
  schema: string;
  name: string;
  relkind: string;
  tablespace: string;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  toastBytes: number;
  estimatedRows: number;
}

export type BloatSeverity = "critical" | "warning" | "healthy";

export interface TableBloatRow {
  schema: string;
  name: string;
  liveTuples: number;
  deadTuples: number;
  deadRatioPct: number;
  totalBytes: number;
  seqScan: number;
  idxScan: number;
  lastVacuum: string;
  lastAutovacuum: string;
  lastAnalyze: string;
  lastAutoanalyze: string;
  severity: BloatSeverity;
}

export interface UnusedIndexRow {
  schema: string;
  tableName: string;
  indexName: string;
  idxScan: number;
  idxTupRead: number;
  idxTupFetch: number;
  indexBytes: number;
  isUnique: boolean;
  indexDef: string;
}

export type MaintenanceSqlMode = "vacuum_analyze" | "analyze" | "vacuum_full" | "reindex";

/** Built-in openGauss / PostgreSQL system schemas excluded from user storage diagnostics. */
export const SYSTEM_SCHEMA_EXACT_NAMES = ["pg_catalog", "information_schema", "pg_toast", "blockchain", "coverage", "cstore", "db4ai", "pkg_service", "snapshot", "sqladvisor", "xmltype"] as const;

/** System schema prefixes excluded regardless of `standard_conforming_strings`. */
export const SYSTEM_SCHEMA_PREFIXES = ["dbe_", "pg_temp_", "pg_toast_"] as const;

const SYSTEM_SCHEMA_EXACT_SET = new Set<string>(SYSTEM_SCHEMA_EXACT_NAMES);

/** Client-side check matching {@link buildSystemSchemaExclusionSql}. */
export function isSystemSchemaName(schema: string): boolean {
  const normalized = schema.trim().toLowerCase();
  if (!normalized) return false;
  if (SYSTEM_SCHEMA_EXACT_SET.has(normalized)) return true;
  return SYSTEM_SCHEMA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Escape a SQL single-quoted string literal safely. */
export function escapeSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build a SQL predicate excluding PostgreSQL and openGauss system schemas.
 * Uses `ESCAPE '~'` on `LIKE` patterns so underscores are matched literally
 * regardless of server `standard_conforming_strings` settings.
 */
export function buildSystemSchemaExclusionSql(columnExpr = "n.nspname"): string {
  const quotedList = SYSTEM_SCHEMA_EXACT_NAMES.map((name) => escapeSqlLiteral(name)).join(", ");
  const prefixPredicates = SYSTEM_SCHEMA_PREFIXES.map((prefix) => {
    const escapedPattern = `${prefix.replace(/~/g, "~~").replace(/_/g, "~_")}%`;
    return `${columnExpr} NOT LIKE ${escapeSqlLiteral(escapedPattern)} ESCAPE '~'`;
  });
  return [`${columnExpr} NOT IN (${quotedList})`, ...prefixPredicates].join("\n    AND ");
}

/** Quote a PostgreSQL / openGauss SQL identifier safely. */
export function quotePgIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/** Format a schema-qualified identifier (`"schema"."name"` or `"name"`). */
export function quoteQualifiedPgIdent(schema: string, name: string): string {
  const trimmedSchema = schema.trim();
  const trimmedName = name.trim();
  return trimmedSchema ? `${quotePgIdent(trimmedSchema)}.${quotePgIdent(trimmedName)}` : quotePgIdent(trimmedName);
}

function normalizeQueryLimit(limit: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(1000, Math.max(1, Math.floor(limit)));
}

function buildOptionalSchemaFilter(columnExpr: string, schema?: string): string | null {
  const trimmed = schema?.trim();
  if (!trimmed) return null;
  return `${columnExpr} = ${escapeSqlLiteral(trimmed)}`;
}

/** List non-system user schemas sorted alphabetically. */
export function buildUserSchemasQuery(): string {
  return ["SELECT n.nspname AS nspname", "FROM pg_catalog.pg_namespace n", `WHERE ${buildSystemSchemaExclusionSql("n.nspname")}`, "ORDER BY n.nspname ASC"].join("\n");
}

/** List cluster tablespaces including filesystem size via `pg_tablespace_size`. */
export function buildTablespacesQuery(): string {
  return [
    "SELECT",
    "  t.spcname AS name,",
    "  COALESCE(pg_catalog.pg_get_userbyid(t.spcowner), '') AS owner,",
    "  COALESCE(pg_catalog.pg_tablespace_location(t.oid), '') AS location,",
    "  pg_catalog.pg_tablespace_size(t.oid)::bigint AS size_bytes",
    "FROM pg_catalog.pg_tablespace t",
    "ORDER BY t.spcname ASC",
  ].join("\n");
}

/**
 * Fallback tablespace query omitting `pg_catalog.pg_tablespace_size(oid)` for
 * restricted roles that cannot stat tablespace directories on disk.
 */
export function buildTablespacesFallbackQuery(): string {
  return ["SELECT", "  t.spcname AS name,", "  COALESCE(pg_catalog.pg_get_userbyid(t.spcowner), '') AS owner,", "  COALESCE(pg_catalog.pg_tablespace_location(t.oid), '') AS location,", "  NULL::bigint AS size_bytes", "FROM pg_catalog.pg_tablespace t", "ORDER BY t.spcname ASC"].join("\n");
}

/** Top relations (`relkind IN ('r','p','m')`) ordered by total relation size descending. */
export function buildRelationStorageTopQuery(limit = 100, schema?: string): string {
  const safeLimit = normalizeQueryLimit(limit, 100);
  const schemaFilter = buildOptionalSchemaFilter("n.nspname", schema);
  const conditions = [buildSystemSchemaExclusionSql("n.nspname"), "c.relkind IN ('r','p','m')"];
  if (schemaFilter) conditions.push(schemaFilter);

  return [
    "SELECT",
    "  n.nspname AS schema_name,",
    "  c.relname AS relname,",
    "  c.relkind::text AS relkind,",
    "  COALESCE(ts.spcname, 'pg_default') AS tablespace,",
    "  COALESCE(pg_catalog.pg_total_relation_size(c.oid), 0)::bigint AS total_bytes,",
    "  COALESCE(pg_catalog.pg_relation_size(c.oid), 0)::bigint AS table_bytes,",
    "  COALESCE(pg_catalog.pg_indexes_size(c.oid), 0)::bigint AS index_bytes,",
    "  COALESCE(",
    "    CASE",
    "      WHEN c.reltoastrelid IS NOT NULL AND c.reltoastrelid <> 0",
    "        THEN pg_catalog.pg_total_relation_size(c.reltoastrelid)",
    "      ELSE 0",
    "    END,",
    "    0",
    "  )::bigint AS toast_bytes,",
    "  GREATEST(COALESCE(c.reltuples, 0), 0)::bigint AS estimated_rows",
    "FROM pg_catalog.pg_class c",
    "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
    "LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = c.reltablespace",
    `WHERE ${conditions.join("\n  AND ")}`,
    "ORDER BY pg_catalog.pg_total_relation_size(c.oid) DESC NULLS LAST, n.nspname ASC, c.relname ASC",
    `LIMIT ${safeLimit}`,
  ].join("\n");
}

/** Query user table dead-tuple statistics and vacuum/analyze timestamps. */
export function buildTableBloatQuery(limit = 150, schema?: string): string {
  const safeLimit = normalizeQueryLimit(limit, 150);
  const schemaFilter = buildOptionalSchemaFilter("n.nspname", schema);
  const conditions = [buildSystemSchemaExclusionSql("n.nspname")];
  if (schemaFilter) conditions.push(schemaFilter);

  return [
    "SELECT",
    "  COALESCE(n.nspname, s.schemaname) AS schema_name,",
    "  COALESCE(c.relname, s.relname) AS relname,",
    "  COALESCE(s.n_live_tup, 0)::bigint AS n_live_tup,",
    "  COALESCE(s.n_dead_tup, 0)::bigint AS n_dead_tup,",
    "  ROUND((COALESCE(s.n_dead_tup, 0)::numeric * 100.0) / GREATEST(COALESCE(s.n_live_tup, 0) + COALESCE(s.n_dead_tup, 0), 1), 2) AS dead_ratio_pct,",
    "  COALESCE(pg_catalog.pg_total_relation_size(c.oid), 0)::bigint AS total_bytes,",
    "  COALESCE(s.seq_scan, 0)::bigint AS seq_scan,",
    "  COALESCE(s.idx_scan, 0)::bigint AS idx_scan,",
    "  COALESCE(to_char(s.last_vacuum, 'YYYY-MM-DD HH24:MI:SS'), '') AS last_vacuum,",
    "  COALESCE(to_char(s.last_autovacuum, 'YYYY-MM-DD HH24:MI:SS'), '') AS last_autovacuum,",
    "  COALESCE(to_char(s.last_analyze, 'YYYY-MM-DD HH24:MI:SS'), '') AS last_analyze,",
    "  COALESCE(to_char(s.last_autoanalyze, 'YYYY-MM-DD HH24:MI:SS'), '') AS last_autoanalyze",
    "FROM pg_catalog.pg_stat_user_tables s",
    "JOIN pg_catalog.pg_class c ON c.oid = s.relid",
    "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
    `WHERE ${conditions.join("\n  AND ")}`,
    "ORDER BY n_dead_tup DESC NULLS LAST, total_bytes DESC NULLS LAST, n.nspname ASC, c.relname ASC",
    `LIMIT ${safeLimit}`,
  ].join("\n");
}

/** Query secondary indexes ordered by lowest scan count and largest size first. */
export function buildUnusedIndexesQuery(limit = 150, schema?: string, includeUnique = false): string {
  const safeLimit = normalizeQueryLimit(limit, 150);
  const schemaFilter = buildOptionalSchemaFilter("n.nspname", schema);
  const conditions = [buildSystemSchemaExclusionSql("n.nspname"), "NOT x.indisprimary"];
  if (!includeUnique) conditions.push("NOT x.indisunique");
  if (schemaFilter) conditions.push(schemaFilter);

  return [
    "SELECT",
    "  n.nspname AS schema_name,",
    "  tc.relname AS table_name,",
    "  ic.relname AS index_name,",
    "  COALESCE(s.idx_scan, 0)::bigint AS idx_scan,",
    "  COALESCE(s.idx_tup_read, 0)::bigint AS idx_tup_read,",
    "  COALESCE(s.idx_tup_fetch, 0)::bigint AS idx_tup_fetch,",
    "  COALESCE(pg_catalog.pg_relation_size(ic.oid), 0)::bigint AS index_bytes,",
    "  COALESCE(x.indisunique, false) AS is_unique,",
    "  COALESCE(pg_catalog.pg_get_indexdef(ic.oid), '') AS index_def",
    "FROM pg_catalog.pg_stat_user_indexes s",
    "JOIN pg_catalog.pg_index x ON x.indexrelid = s.indexrelid",
    "JOIN pg_catalog.pg_class ic ON ic.oid = s.indexrelid",
    "JOIN pg_catalog.pg_class tc ON tc.oid = s.relid",
    "JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace",
    `WHERE ${conditions.join("\n  AND ")}`,
    "ORDER BY idx_scan ASC NULLS FIRST, index_bytes DESC NULLS LAST, n.nspname ASC, tc.relname ASC, ic.relname ASC",
    `LIMIT ${safeLimit}`,
  ].join("\n");
}

type ResultLike = Pick<QueryResult, "columns" | "rows">;
type ResultRow = QueryResult["rows"][number];

function resolveColumnIndex(columns: readonly string[], ...candidates: string[]): number {
  const lowerColumns = columns.map((column) =>
    String(column ?? "")
      .trim()
      .toLowerCase(),
  );
  for (const candidate of candidates) {
    const idx = lowerColumns.indexOf(candidate.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function readCellText(row: ResultRow, index: number): string {
  if (index < 0 || index >= row.length) return "";
  const raw = row[index];
  if (raw === null || raw === undefined) return "";
  return String(raw).trim();
}

function readCellNumber(row: ResultRow, index: number, fallback = 0): number {
  const parsed = readCellNullableNumber(row, index);
  return parsed === null ? fallback : parsed;
}

function readCellNullableNumber(row: ResultRow, index: number): number | null {
  if (index < 0 || index >= row.length) return null;
  const raw = row[index];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  const text = String(raw).trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCellBoolean(row: ResultRow, index: number): boolean {
  if (index < 0 || index >= row.length) return false;
  const raw = row[index];
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  const text = String(raw).trim().toLowerCase();
  return text === "true" || text === "t" || text === "1" || text === "yes" || text === "y";
}

function hasValidResultShape(result: ResultLike | null | undefined): result is ResultLike {
  return !!result && Array.isArray(result.columns) && Array.isArray(result.rows);
}

/** Parse schema names returned by {@link buildUserSchemasQuery}. */
export function parseUserSchemaRows(result: ResultLike | null | undefined): string[] {
  if (!hasValidResultShape(result)) return [];
  const idx = resolveColumnIndex(result.columns, "nspname", "schema_name", "schema");
  const targetIdx = idx >= 0 ? idx : 0;
  const seen = new Set<string>();
  const schemas: string[] = [];
  for (const row of result.rows) {
    if (!Array.isArray(row)) continue;
    const name = readCellText(row, targetIdx);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    schemas.push(name);
  }
  return schemas;
}

/** Parse tablespace metadata rows defensively (case-insensitive headers). */
export function parseTablespaceRows(result: ResultLike | null | undefined): TablespaceInfo[] {
  if (!hasValidResultShape(result)) return [];
  const nameIdx = resolveColumnIndex(result.columns, "name", "spcname", "tablespace");
  const ownerIdx = resolveColumnIndex(result.columns, "owner", "spcowner");
  const locationIdx = resolveColumnIndex(result.columns, "location", "spclocation");
  const sizeIdx = resolveColumnIndex(result.columns, "size_bytes", "sizebytes", "size");

  return result.rows
    .filter((row): row is ResultRow => Array.isArray(row))
    .map((row) => ({
      name: readCellText(row, nameIdx),
      owner: readCellText(row, ownerIdx),
      location: readCellText(row, locationIdx),
      sizeBytes: readCellNullableNumber(row, sizeIdx),
    }))
    .filter((item) => item.name.length > 0);
}

/** Parse top relation storage rows defensively (case-insensitive headers). */
export function parseRelationStorageRows(result: ResultLike | null | undefined): RelationStorageRow[] {
  if (!hasValidResultShape(result)) return [];
  const schemaIdx = resolveColumnIndex(result.columns, "schema_name", "schema", "schemaname", "nspname");
  const nameIdx = resolveColumnIndex(result.columns, "relname", "name", "table_name");
  const relkindIdx = resolveColumnIndex(result.columns, "relkind", "kind");
  const tablespaceIdx = resolveColumnIndex(result.columns, "tablespace", "spcname");
  const totalBytesIdx = resolveColumnIndex(result.columns, "total_bytes", "totalbytes");
  const tableBytesIdx = resolveColumnIndex(result.columns, "table_bytes", "tablebytes");
  const indexBytesIdx = resolveColumnIndex(result.columns, "index_bytes", "indexbytes");
  const toastBytesIdx = resolveColumnIndex(result.columns, "toast_bytes", "toastbytes");
  const estRowsIdx = resolveColumnIndex(result.columns, "estimated_rows", "estimatedrows", "reltuples");

  return result.rows
    .filter((row): row is ResultRow => Array.isArray(row))
    .map((row) => ({
      schema: readCellText(row, schemaIdx),
      name: readCellText(row, nameIdx),
      relkind: readCellText(row, relkindIdx),
      tablespace: readCellText(row, tablespaceIdx),
      totalBytes: Math.max(0, readCellNumber(row, totalBytesIdx)),
      tableBytes: Math.max(0, readCellNumber(row, tableBytesIdx)),
      indexBytes: Math.max(0, readCellNumber(row, indexBytesIdx)),
      toastBytes: Math.max(0, readCellNumber(row, toastBytesIdx)),
      estimatedRows: Math.max(0, readCellNumber(row, estRowsIdx)),
    }))
    .filter((item) => item.name.length > 0);
}

/** Classify dead-tuple bloat severity using tuple count and dead ratio thresholds. */
export function classifyBloatSeverity(deadTuples: number, deadRatioPct: number): BloatSeverity {
  const dead = Number.isFinite(deadTuples) ? Math.max(0, deadTuples) : 0;
  const ratio = Number.isFinite(deadRatioPct) ? Math.max(0, deadRatioPct) : 0;
  if (dead >= 100_000 || (dead >= 5_000 && ratio >= 20)) {
    return "critical";
  }
  if ((dead >= 1_000 && ratio >= 10) || dead >= 20_000) {
    return "warning";
  }
  return "healthy";
}

/** Parse dead-tuple bloat rows defensively and assign {@link classifyBloatSeverity}. */
export function parseTableBloatRows(result: ResultLike | null | undefined): TableBloatRow[] {
  if (!hasValidResultShape(result)) return [];
  const schemaIdx = resolveColumnIndex(result.columns, "schema_name", "schemaname", "schema", "nspname");
  const nameIdx = resolveColumnIndex(result.columns, "relname", "name", "table_name");
  const liveIdx = resolveColumnIndex(result.columns, "n_live_tup", "live_tuples", "livetuples");
  const deadIdx = resolveColumnIndex(result.columns, "n_dead_tup", "dead_tuples", "deadtuples");
  const ratioIdx = resolveColumnIndex(result.columns, "dead_ratio_pct", "deadratiopct");
  const totalBytesIdx = resolveColumnIndex(result.columns, "total_bytes", "totalbytes");
  const seqScanIdx = resolveColumnIndex(result.columns, "seq_scan", "seqscan");
  const idxScanIdx = resolveColumnIndex(result.columns, "idx_scan", "idxscan");
  const lastVacuumIdx = resolveColumnIndex(result.columns, "last_vacuum", "lastvacuum");
  const lastAutovacuumIdx = resolveColumnIndex(result.columns, "last_autovacuum", "lastautovacuum");
  const lastAnalyzeIdx = resolveColumnIndex(result.columns, "last_analyze", "lastanalyze");
  const lastAutoanalyzeIdx = resolveColumnIndex(result.columns, "last_autoanalyze", "lastautoanalyze");

  return result.rows
    .filter((row): row is ResultRow => Array.isArray(row))
    .map((row) => {
      const liveTuples = Math.max(0, readCellNumber(row, liveIdx));
      const deadTuples = Math.max(0, readCellNumber(row, deadIdx));
      const rawRatio = readCellNullableNumber(row, ratioIdx);
      const computedRatio = Number(((deadTuples * 100) / Math.max(liveTuples + deadTuples, 1)).toFixed(2));
      const deadRatioPct = Math.max(0, rawRatio !== null ? rawRatio : computedRatio);
      return {
        schema: readCellText(row, schemaIdx),
        name: readCellText(row, nameIdx),
        liveTuples,
        deadTuples,
        deadRatioPct,
        totalBytes: Math.max(0, readCellNumber(row, totalBytesIdx)),
        seqScan: Math.max(0, readCellNumber(row, seqScanIdx)),
        idxScan: Math.max(0, readCellNumber(row, idxScanIdx)),
        lastVacuum: readCellText(row, lastVacuumIdx),
        lastAutovacuum: readCellText(row, lastAutovacuumIdx),
        lastAnalyze: readCellText(row, lastAnalyzeIdx),
        lastAutoanalyze: readCellText(row, lastAutoanalyzeIdx),
        severity: classifyBloatSeverity(deadTuples, deadRatioPct),
      };
    })
    .filter((item) => item.name.length > 0);
}

/** Parse unused-index rows defensively (case-insensitive headers). */
export function parseUnusedIndexRows(result: ResultLike | null | undefined): UnusedIndexRow[] {
  if (!hasValidResultShape(result)) return [];
  const schemaIdx = resolveColumnIndex(result.columns, "schema_name", "schemaname", "schema", "nspname");
  const tableIdx = resolveColumnIndex(result.columns, "table_name", "tablename", "relname");
  const indexIdx = resolveColumnIndex(result.columns, "index_name", "indexname", "indexrelname");
  const idxScanIdx = resolveColumnIndex(result.columns, "idx_scan", "idxscan");
  const tupReadIdx = resolveColumnIndex(result.columns, "idx_tup_read", "idxtupread");
  const tupFetchIdx = resolveColumnIndex(result.columns, "idx_tup_fetch", "idxtupfetch");
  const indexBytesIdx = resolveColumnIndex(result.columns, "index_bytes", "indexbytes");
  const isUniqueIdx = resolveColumnIndex(result.columns, "is_unique", "indisunique", "isunique");
  const indexDefIdx = resolveColumnIndex(result.columns, "index_def", "indexdef");

  return result.rows
    .filter((row): row is ResultRow => Array.isArray(row))
    .map((row) => ({
      schema: readCellText(row, schemaIdx),
      tableName: readCellText(row, tableIdx),
      indexName: readCellText(row, indexIdx),
      idxScan: Math.max(0, readCellNumber(row, idxScanIdx)),
      idxTupRead: Math.max(0, readCellNumber(row, tupReadIdx)),
      idxTupFetch: Math.max(0, readCellNumber(row, tupFetchIdx)),
      indexBytes: Math.max(0, readCellNumber(row, indexBytesIdx)),
      isUnique: readCellBoolean(row, isUniqueIdx),
      indexDef: readCellText(row, indexDefIdx),
    }))
    .filter((item) => item.indexName.length > 0);
}

function trimTrailingDecimalZeros(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

const STORAGE_BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Format a byte count into `B` / `KB` / `MB` / `GB` / `TB`; null/invalid returns `-`. */
export function formatStorageBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes === 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), STORAGE_BYTE_UNITS.length - 1);
  if (exponent <= 0) return `${Math.round(bytes)} B`;
  const scaled = bytes / 1024 ** exponent;
  return `${trimTrailingDecimalZeros(scaled.toFixed(2))} ${STORAGE_BYTE_UNITS[exponent]}`;
}

/** Format an integer count with thousands separators; null/invalid returns `-`. */
export function formatStorageCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Generate a multi-line maintenance SQL script for selected tables.
 * `vacuum_full` and `reindex` include prominent `ACCESS EXCLUSIVE` lock warnings.
 */
export function buildVacuumSql(targets: Array<{ schema: string; table: string }>, mode: MaintenanceSqlMode): string {
  const uniqueTargets: Array<{ schema: string; table: string }> = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const schema = target.schema.trim();
    const table = target.table.trim();
    if (!table) continue;
    const key = `${schema}\0${table}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTargets.push({ schema, table });
  }
  if (uniqueTargets.length === 0) return "";

  const headerComments: string[] = [];
  let commandPrefix = "VACUUM ANALYZE";

  switch (mode) {
    case "vacuum_analyze":
      headerComments.push("-- Reclaim dead tuples (non-blocking MVCC space reuse) and refresh planner statistics.");
      headerComments.push("-- Acquires SHARE UPDATE EXCLUSIVE lock; concurrent SELECT/INSERT/UPDATE/DELETE remain allowed.");
      commandPrefix = "VACUUM ANALYZE";
      break;
    case "analyze":
      headerComments.push("-- Refresh table planner statistics without rewriting heap or index pages.");
      headerComments.push("-- Lightweight read-sampling pass; safe to run during normal workload.");
      commandPrefix = "ANALYZE";
      break;
    case "vacuum_full":
      headerComments.push("-- WARNING: VACUUM FULL acquires an ACCESS EXCLUSIVE lock on each table, blocking ALL reads and writes!");
      headerComments.push("-- It rewrites the entire table and indexes on disk and requires sufficient free disk space; run only in a maintenance window.");
      commandPrefix = "VACUUM FULL ANALYZE";
      break;
    case "reindex":
      headerComments.push("-- WARNING: REINDEX TABLE acquires an ACCESS EXCLUSIVE lock on the table/indexes, blocking concurrent writes (and reads during rebuild in openGauss).");
      headerComments.push("-- Use during a planned maintenance window when index bloat cannot be resolved online.");
      commandPrefix = "REINDEX TABLE";
      break;
  }

  const statements = uniqueTargets.map((target) => `${commandPrefix} ${quoteQualifiedPgIdent(target.schema, target.table)};`);
  return [...headerComments, ...statements].join("\n");
}

/** Build a `DROP INDEX` statement, defaulting to online `CONCURRENTLY`. */
export function buildDropIndexSql(schema: string, indexName: string, concurrently = true): string {
  const qualified = quoteQualifiedPgIdent(schema, indexName);
  return concurrently ? `DROP INDEX CONCURRENTLY IF EXISTS ${qualified};` : `DROP INDEX IF EXISTS ${qualified};`;
}
