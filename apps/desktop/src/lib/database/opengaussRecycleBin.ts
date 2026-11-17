import type { QueryResult } from "@/types/database";

/**
 * openGauss Recycle Bin (`pg_catalog.gs_recyclebin`) & Flashback (`TIMECAPSULE` / `PURGE`)
 * pure SQL builders and result parsers.
 */

export const OPENGAUSS_ENABLE_RECYCLEBIN_SQL = "SHOW enable_recyclebin";

export const OPENGAUSS_ENABLE_RECYCLEBIN_GUC_COMMAND = 'gs_guc reload -N all -I all -c "enable_recyclebin = on"';

export const OPENGAUSS_RECYCLEBIN_LIST_SQL = `SELECT
       r.rcyname,
       r.rcyoriginname,
       r.rcyoperation,
       r.rcytype,
       CAST(r.rcyrecycletime AS text) AS rcyrecycletime,
       CAST(r.rcyrecyclecsn AS text) AS rcyrecyclecsn,
       CAST(r.rcynamespace AS text) AS rcynamespace,
       COALESCE(n.nspname, '') AS schema_name,
       pg_catalog.pg_get_userbyid(r.rcyowner) AS owner_name,
       COALESCE(ts.spcname, '') AS tablespace_name,
       r.rcycanrestore,
       r.rcycanpurge
FROM pg_catalog.gs_recyclebin r
LEFT JOIN pg_catalog.pg_namespace n ON n.oid = r.rcynamespace
LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = r.rcytablespace
ORDER BY r.rcyrecycletime DESC, r.rcyname DESC`;

export const OPENGAUSS_RECYCLEBIN_FALLBACK_SQL = "SELECT rcyname, rcyoriginname, rcyoperation, rcytype, rcyrecycletime, rcynamespace, rcycanrestore, rcycanpurge FROM pg_catalog.gs_recyclebin ORDER BY rcyrecycletime DESC";

export const OPENGAUSS_NAMESPACE_MAP_SQL = "SELECT CAST(oid AS text) AS oid, nspname FROM pg_catalog.pg_namespace";

export type RecycleBinOperation = "DROP" | "TRUNCATE" | "UNKNOWN";

export type RecycleBinObjectKind = "TABLE" | "INDEX" | "TOAST" | "TOAST_INDEX" | "PARTITION" | "OTHER";

export interface RecycleBinItem {
  /** System-generated unique name in recycle bin, e.g. BIN$3EB644E9FD0$4975288==$0 */
  rcyname: string;
  /** Original user object name before drop/truncate, e.g. orders_2025 */
  originName: string;
  /** Normalized operation: "DROP" | "TRUNCATE" | "UNKNOWN" */
  operation: RecycleBinOperation;
  /** Raw rcyoperation value from catalog ('d', 't', etc.) */
  rawOperation: string;
  /** Numeric rcytype code from gs_recyclebin (0=table, 1=index, 2=toast, 3=toast index, 4=partition) */
  rcytype: number;
  /** Normalized object kind */
  objectKind: RecycleBinObjectKind;
  /** Human-readable type label */
  typeLabel: string;
  /** Timestamp when recycled */
  recycleTime: string;
  /** Recycle commit sequence number if available */
  recycleCsn: string | null;
  /** Schema OID from rcynamespace if available */
  namespaceOid: string | null;
  /** Resolved schema name (e.g. "public") */
  schema: string;
  /** Object owner username if available */
  owner: string | null;
  /** Tablespace name if available */
  tablespace: string | null;
  /** Raw rcycanrestore flag from gs_recyclebin */
  rcycanrestore: boolean;
  /** Raw rcycanpurge flag from gs_recyclebin */
  rcycanpurge: boolean;
  /** True only when rcytype === 0, rcycanrestore is true, and operation is DROP or TRUNCATE */
  canRestore: boolean;
  /** True only when rcycanpurge is true and object is a table (0) or index (1) */
  canPurge: boolean;
}

export interface ParseRecycleBinRowsOptions {
  /** Optional OID -> schema_name lookup map used when fallback query omits schema_name */
  namespaceMap?: ReadonlyMap<string, string> | Record<string, string>;
}

export interface TimecapsuleRestoreTarget {
  schema?: string | null;
  rcyname?: string | null;
  originName: string;
  operation: RecycleBinOperation | string;
  rcytype?: number;
  canRestore?: boolean;
  renameTo?: string | null;
}

export interface TimecapsuleRestoreOptions {
  renameTo?: string | null;
}

export interface PurgeRecycleBinTarget {
  schema?: string | null;
  rcyname?: string | null;
  originName?: string | null;
  rcytype: number;
  canPurge?: boolean;
}

function columnIndex(columns: string[], ...candidates: string[]): number {
  for (const candidate of candidates) {
    const target = candidate.toLowerCase();
    const idx = columns.findIndex((col) => col.toLowerCase() === target);
    if (idx >= 0) return idx;
  }
  return -1;
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

function parseCatalogBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (["on", "true", "t", "1", "yes", "y"].includes(normalized)) return true;
  if (["off", "false", "f", "0", "no", "n"].includes(normalized)) return false;
  return null;
}

export function normalizeRecycleBinOperation(value: unknown): RecycleBinOperation {
  const normalized = asString(value).trim().toLowerCase();
  if (normalized === "d" || normalized === "drop") return "DROP";
  if (normalized === "t" || normalized === "truncate") return "TRUNCATE";
  return "UNKNOWN";
}

export function classifyRecycleBinObjectType(rawType: unknown): {
  rcytype: number;
  objectKind: RecycleBinObjectKind;
  typeLabel: string;
} {
  const parsed = typeof rawType === "number" ? rawType : Number(asString(rawType).trim());
  const rcytype = Number.isInteger(parsed) ? parsed : -1;
  switch (rcytype) {
    case 0:
      return { rcytype: 0, objectKind: "TABLE", typeLabel: "TABLE" };
    case 1:
      return { rcytype: 1, objectKind: "INDEX", typeLabel: "INDEX" };
    case 2:
      return { rcytype: 2, objectKind: "TOAST", typeLabel: "TOAST" };
    case 3:
      return { rcytype: 3, objectKind: "TOAST_INDEX", typeLabel: "TOAST INDEX" };
    case 4:
      return { rcytype: 4, objectKind: "PARTITION", typeLabel: "PARTITION" };
    default:
      return {
        rcytype,
        objectKind: "OTHER",
        typeLabel: rcytype >= 0 ? `TYPE ${rcytype}` : "UNKNOWN",
      };
  }
}

/**
 * Parse `SHOW enable_recyclebin` result into `true` (`on`), `false` (`off`),
 * or `null` when unavailable/unrecognized.
 */
export function parseEnableRecycleBinResult(result: QueryResult | null | undefined): boolean | null {
  if (!result || result.execution_error === true || !Array.isArray(result.rows) || result.rows.length === 0) {
    return null;
  }
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const valueIdx = columnIndex(columns, "enable_recyclebin", "setting");
  const firstRow = result.rows[0];
  if (!Array.isArray(firstRow) || firstRow.length === 0) return null;
  const rawValue = valueIdx >= 0 ? firstRow[valueIdx] : firstRow[0];
  return parseCatalogBoolean(rawValue);
}

/**
 * Parse `SELECT oid, nspname FROM pg_catalog.pg_namespace` into an OID->schema lookup map.
 */
export function parseNamespaceOidMap(result: QueryResult | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!result || result.execution_error === true || !Array.isArray(result.columns) || !Array.isArray(result.rows)) {
    return map;
  }
  const oidIdx = columnIndex(result.columns, "oid", "rcynamespace");
  const nameIdx = columnIndex(result.columns, "nspname", "schema_name");
  if (oidIdx < 0 || nameIdx < 0) return map;
  for (const row of result.rows) {
    const oid = asString(row[oidIdx]).trim();
    const name = asString(row[nameIdx]).trim();
    if (oid && name) {
      map.set(oid, name);
    }
  }
  return map;
}

function lookupNamespace(namespaceOid: string | null, namespaceMap?: ReadonlyMap<string, string> | Record<string, string>): string {
  if (!namespaceOid) return "";
  if (namespaceMap) {
    if (namespaceMap instanceof Map) {
      const found = namespaceMap.get(namespaceOid);
      if (found) return found;
    } else if (typeof (namespaceMap as ReadonlyMap<string, string>).get === "function") {
      const found = (namespaceMap as ReadonlyMap<string, string>).get(namespaceOid);
      if (found) return found;
    } else {
      const record = namespaceMap as Record<string, string>;
      if (record[namespaceOid]) return record[namespaceOid];
    }
  }
  // Standard PostgreSQL / openGauss OID for `public` schema when fallback query omits pg_namespace join
  if (namespaceOid === "2200") return "public";
  return "";
}

/**
 * Parse rows returned from `pg_catalog.gs_recyclebin` (either the full joined query
 * or the minimal fallback query) into typed `RecycleBinItem` records.
 */
export function parseRecycleBinRows(result: QueryResult | null | undefined, options?: ParseRecycleBinRowsOptions): RecycleBinItem[] {
  if (!result || result.execution_error === true || !Array.isArray(result.columns) || !Array.isArray(result.rows)) {
    return [];
  }
  const columns = result.columns;
  const rcynameIdx = columnIndex(columns, "rcyname");
  const originNameIdx = columnIndex(columns, "rcyoriginname", "origin_name");
  const operationIdx = columnIndex(columns, "rcyoperation", "operation");
  const typeIdx = columnIndex(columns, "rcytype", "type");
  const recycleTimeIdx = columnIndex(columns, "rcyrecycletime", "recycle_time");
  const recycleCsnIdx = columnIndex(columns, "rcyrecyclecsn", "recycle_csn");
  const namespaceOidIdx = columnIndex(columns, "rcynamespace", "namespace_oid");
  const schemaNameIdx = columnIndex(columns, "schema_name", "nspname", "schema");
  const ownerNameIdx = columnIndex(columns, "owner_name", "rcyowner_name", "owner");
  const tablespaceIdx = columnIndex(columns, "tablespace_name", "spcname", "tablespace");
  const canRestoreIdx = columnIndex(columns, "rcycanrestore", "can_restore");
  const canPurgeIdx = columnIndex(columns, "rcycanpurge", "can_purge");

  const cell = (row: (string | number | boolean | null)[], idx: number) => (idx >= 0 ? row[idx] : null);

  return result.rows.map((row) => {
    const rcyname = asString(cell(row, rcynameIdx)).trim();
    const originName = asString(cell(row, originNameIdx)).trim();
    const rawOperation = asString(cell(row, operationIdx)).trim();
    const operation = normalizeRecycleBinOperation(rawOperation);
    const { rcytype, objectKind, typeLabel } = classifyRecycleBinObjectType(cell(row, typeIdx));
    const recycleTime = asString(cell(row, recycleTimeIdx)).trim();
    const recycleCsn = asNullableString(cell(row, recycleCsnIdx));
    const namespaceOid = asNullableString(cell(row, namespaceOidIdx));
    const directSchema = asString(cell(row, schemaNameIdx)).trim();
    const schema = directSchema || lookupNamespace(namespaceOid, options?.namespaceMap);
    const owner = asNullableString(cell(row, ownerNameIdx));
    const tablespace = asNullableString(cell(row, tablespaceIdx));
    const rcycanrestore = parseCatalogBoolean(cell(row, canRestoreIdx)) === true;
    const rcycanpurge = parseCatalogBoolean(cell(row, canPurgeIdx)) === true;

    const hasRestoreIdentifier = operation === "DROP" ? Boolean(rcyname || originName) : Boolean(originName);
    const canRestore = rcytype === 0 && rcycanrestore && (operation === "DROP" || operation === "TRUNCATE") && hasRestoreIdentifier;
    const canPurge = rcycanpurge && (rcytype === 0 || rcytype === 1) && Boolean(rcyname || originName);

    return {
      rcyname,
      originName,
      operation,
      rawOperation,
      rcytype,
      objectKind,
      typeLabel,
      recycleTime,
      recycleCsn,
      namespaceOid,
      schema,
      owner,
      tablespace,
      rcycanrestore,
      rcycanpurge,
      canRestore,
      canPurge,
    };
  });
}

/**
 * Double-quote an openGauss / PostgreSQL SQL identifier, escaping embedded double quotes.
 */
export function quoteOpengaussIdentifier(identifier: string): string {
  if (!identifier || identifier.trim().length === 0) {
    throw new Error("openGauss SQL identifier must not be empty");
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Format `"schema"."object"` when schema is non-empty, or `"object"` when schema is omitted.
 */
export function formatQualifiedOpengaussName(schema: string | null | undefined, objectName: string): string {
  const quotedObject = quoteOpengaussIdentifier(objectName);
  const trimmedSchema = typeof schema === "string" ? schema.trim() : "";
  if (!trimmedSchema) return quotedObject;
  return `${quoteOpengaussIdentifier(trimmedSchema)}.${quotedObject}`;
}

/**
 * Build official openGauss `TIMECAPSULE TABLE` statement:
 * - DROP: `TIMECAPSULE TABLE "schema"."BIN$..." TO BEFORE DROP`
 * - DROP with rename: `TIMECAPSULE TABLE "schema"."BIN$..." TO BEFORE DROP RENAME TO "new_name"`
 * - TRUNCATE: `TIMECAPSULE TABLE "schema"."origin_name" TO BEFORE TRUNCATE`
 */
export function buildTimecapsuleRestoreSql(target: TimecapsuleRestoreTarget, optionsOrRenameTo?: TimecapsuleRestoreOptions | string | null): string {
  if (target.rcytype !== undefined && target.rcytype !== 0) {
    throw new Error(`Only table entries (rcytype = 0) can be restored with TIMECAPSULE TABLE (got rcytype = ${target.rcytype})`);
  }
  if (target.canRestore === false) {
    throw new Error("Recycle bin entry is not restorable via TIMECAPSULE TABLE");
  }

  const operation = normalizeRecycleBinOperation(target.operation);
  const rawRenameTo = typeof optionsOrRenameTo === "string" ? optionsOrRenameTo : optionsOrRenameTo && typeof optionsOrRenameTo === "object" ? optionsOrRenameTo.renameTo : target.renameTo;
  const renameTo = typeof rawRenameTo === "string" ? rawRenameTo.trim() : "";

  if (operation === "DROP") {
    const sourceTable = (target.rcyname ?? "").trim() || target.originName.trim();
    if (!sourceTable) {
      throw new Error("Recycle bin table identifier is required for TIMECAPSULE TO BEFORE DROP");
    }
    const qualifiedSource = formatQualifiedOpengaussName(target.schema, sourceTable);
    if (renameTo) {
      return `TIMECAPSULE TABLE ${qualifiedSource} TO BEFORE DROP RENAME TO ${quoteOpengaussIdentifier(renameTo)}`;
    }
    return `TIMECAPSULE TABLE ${qualifiedSource} TO BEFORE DROP`;
  }

  if (operation === "TRUNCATE") {
    if (renameTo) {
      throw new Error("TIMECAPSULE TO BEFORE TRUNCATE does not support RENAME TO");
    }
    const originName = target.originName.trim();
    if (!originName) {
      throw new Error("Original table name is required for TIMECAPSULE TO BEFORE TRUNCATE");
    }
    const qualifiedOrigin = formatQualifiedOpengaussName(target.schema, originName);
    return `TIMECAPSULE TABLE ${qualifiedOrigin} TO BEFORE TRUNCATE`;
  }

  throw new Error(`Unsupported recycle bin operation for TIMECAPSULE: ${String(target.operation)}`);
}

/**
 * Build official openGauss single-object `PURGE` statement:
 * - Table (`rcytype = 0`): `PURGE TABLE "schema"."BIN$..."`
 * - Index (`rcytype = 1`): `PURGE INDEX "schema"."BIN$..."`
 */
export function buildPurgeRecycleBinItemSql(target: PurgeRecycleBinTarget): string {
  if (target.canPurge === false) {
    throw new Error("Recycle bin entry is not marked as purgeable");
  }
  const objectName = (target.rcyname ?? "").trim() || (target.originName ?? "").trim();
  if (!objectName) {
    throw new Error("Recycle bin object name is required for PURGE");
  }
  const qualifiedTarget = formatQualifiedOpengaussName(target.schema, objectName);
  if (target.rcytype === 0) {
    return `PURGE TABLE ${qualifiedTarget}`;
  }
  if (target.rcytype === 1) {
    return `PURGE INDEX ${qualifiedTarget}`;
  }
  throw new Error(`Unsupported recycle bin object type for individual PURGE (rcytype = ${target.rcytype})`);
}

/**
 * Build official openGauss statement to purge all objects in the current user's / database's recycle bin.
 */
export function buildPurgeAllRecycleBinSql(): string {
  return "PURGE RECYCLEBIN";
}

function extractErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["detail", "message", "reason"]) {
      if (typeof record[key] === "string") return record[key];
    }
    if ("backendError" in record) return extractErrorText(record.backendError);
    if ("error" in record) return extractErrorText(record.error);
  }
  return String(error ?? "");
}

/**
 * Returns true if `gs_recyclebin` itself does not exist on the target server.
 */
export function isRecycleBinCatalogUnavailableError(error: unknown): boolean {
  const message = extractErrorText(error);
  return /gs_recyclebin[\s\S]*(?:does not exist|不存在|42P01)|(?:does not exist|不存在|42P01)[\s\S]*gs_recyclebin/i.test(message);
}

/**
 * Returns true when the primary joined query fails due to a missing column/function/catalog join
 * while `gs_recyclebin` itself may still be queryable via `OPENGAUSS_RECYCLEBIN_FALLBACK_SQL`.
 */
export function isRecycleBinFallbackCandidateError(error: unknown): boolean {
  if (isRecycleBinCatalogUnavailableError(error)) return false;
  const message = extractErrorText(error);
  return /(?:column|function|relation|table|42703|42883|42P01|does not exist|不存在)/i.test(message);
}

/**
 * Returns true when `TIMECAPSULE ... TO BEFORE DROP` fails because a table with the original name already exists,
 * allowing the UI to guide the user directly into `RENAME TO` recovery.
 */
export function isRelationAlreadyExistsError(error: unknown): boolean {
  const message = extractErrorText(error);
  return /(?:already exists|已经存在|已存在|42P07)/i.test(message);
}
