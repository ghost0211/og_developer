import type { QueryResult } from "@/types/database";

/**
 * openGauss / PostgreSQL GUC runtime parameter helpers (`pg_catalog.pg_settings`).
 *
 * Pure and framework-free so SQL generation, row parsing, context-level
 * classification, and CLI/SQL command builders can be unit-tested directly.
 */

export interface OpenGaussGucParameter {
  name: string;
  setting: string;
  unit: string;
  category: string;
  shortDesc: string;
  context: string;
  vartype: string;
  source: string;
  bootVal: string | null;
  resetVal: string | null;
  minVal: string | null;
  maxVal: string | null;
  enumVals: string[];
  pendingRestart: boolean;
  modified: boolean;
}

export type GucContextLevel = "session" | "reload" | "restart" | "readonly";
export type GucPresetFilter = "all" | "memory_concurrency" | "compatibility" | "audit_perf" | "restart";

export const OPENGAUSS_GUC_PRESETS = {
  memory_concurrency: ["shared_buffers", "work_mem", "maintenance_work_mem", "max_connections", "max_process_memory", "cstore_buffers", "temp_buffers", "effective_cache_size"],
  compatibility: ["sql_compatibility", "behavior_compat_options", "search_path", "standard_conforming_strings", "statement_timeout", "idle_in_transaction_session_timeout", "lockwait_timeout"],
  audit_perf: ["enable_stmt_track", "track_stmt_details_size", "track_activity_query_size", "log_min_duration_statement", "enable_recyclebin", "enable_wdr_snapshot", "enable_pbe_optimization"],
} as const;

const GUC_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;
const SIMPLE_GUC_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*$/;

const NON_DEFAULT_RUNTIME_SOURCES = new Set(["session", "configuration file", "database", "user", "override", "command line", "database user", "environment variable", "client"]);

const BOOL_TRUE_VALUES = new Set(["on", "true", "t", "1", "yes", "y"]);
const BOOL_FALSE_VALUES = new Set(["off", "false", "f", "0", "no", "n"]);

/** Build the primary `pg_catalog.pg_settings` query. */
export function buildGucParametersQuery(includePendingRestart = true): string {
  const pendingRestartColumn = includePendingRestart ? "pending_restart" : "false AS pending_restart";
  return [
    "SELECT",
    "  name,",
    "  setting,",
    "  COALESCE(unit, '') AS unit,",
    "  category,",
    "  short_desc,",
    "  context,",
    "  vartype,",
    "  source,",
    "  boot_val,",
    "  reset_val,",
    "  min_val,",
    "  max_val,",
    "  enumvals::text AS enumvals,",
    `  ${pendingRestartColumn}`,
    "FROM pg_catalog.pg_settings",
    "ORDER BY name",
  ].join("\n");
}

/** Fallback query for older openGauss / PostgreSQL builds lacking `pending_restart`, `enumvals`, or `min_val`/`max_val`. */
export function buildGucParametersFallbackQuery(): string {
  return "SELECT name, setting, COALESCE(unit, '') AS unit, category, short_desc, context, vartype, source, boot_val, reset_val FROM pg_catalog.pg_settings ORDER BY name";
}

/** Detect column-missing errors so the panel can fall back cleanly on older servers. */
export function isMissingGucColumnError(message: string): boolean {
  const text = message.toLowerCase();
  return (text.includes("column") && (text.includes("does not exist") || text.includes("not exist") || text.includes("不存在"))) || text.includes("undefined column") || text.includes("no such column") || text.includes("42703");
}

function columnIndex(result: QueryResult, name: string): number {
  const needle = name.toLowerCase();
  return result.columns.findIndex((column) => column.toLowerCase() === needle);
}

function readTrimmedText(row: QueryResult["rows"][number], index: number): string {
  if (index < 0) return "";
  const raw = row[index];
  return raw === null || raw === undefined ? "" : String(raw).trim();
}

function readRawText(row: QueryResult["rows"][number], index: number): string {
  if (index < 0) return "";
  const raw = row[index];
  return raw === null || raw === undefined ? "" : String(raw);
}

function readNullableText(row: QueryResult["rows"][number], index: number): string | null {
  if (index < 0) return null;
  const raw = row[index];
  return raw === null || raw === undefined ? null : String(raw);
}

/** Parse either a JS string array or PostgreSQL `{a,"b c"}` `text[]` representation. */
export function parseGucEnumVals(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    return raw.filter((item) => item !== null && item !== undefined).map((item) => String(item));
  }
  const text = String(raw).trim();
  if (!text || text === "{}") return [];
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return text
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  const inner = text.slice(1, -1);
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;
  let wasQuoted = false;

  const pushElement = () => {
    if (wasQuoted) {
      values.push(current);
    } else {
      const trimmed = current.trim();
      if (trimmed.length > 0 && trimmed.toUpperCase() !== "NULL") {
        values.push(trimmed);
      }
    }
    current = "";
    wasQuoted = false;
  };

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inQuotes) {
      if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      wasQuoted = true;
    } else if (ch === ",") {
      pushElement();
    } else {
      current += ch;
    }
  }
  pushElement();
  return values;
}

function parsePendingRestart(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) && raw !== 0;
  return BOOL_TRUE_VALUES.has(String(raw).trim().toLowerCase());
}

/** Whether a parameter differs from its boot/default setting due to a non-default source. */
export function isGucParameterModified(param: Pick<OpenGaussGucParameter, "source" | "setting" | "bootVal">): boolean {
  const source = param.source.trim().toLowerCase();
  if (!source || source === "default") return false;
  if (param.bootVal === null || param.setting !== param.bootVal) return true;
  return NON_DEFAULT_RUNTIME_SOURCES.has(source) && param.setting !== param.bootVal;
}

/** Map `pg_settings.rows` into typed {@link OpenGaussGucParameter} items. */
export function parseGucParametersRows(result: QueryResult | null | undefined): OpenGaussGucParameter[] {
  if (!result || !Array.isArray(result.rows) || !Array.isArray(result.columns)) return [];
  const indexes = {
    name: columnIndex(result, "name"),
    setting: columnIndex(result, "setting"),
    unit: columnIndex(result, "unit"),
    category: columnIndex(result, "category"),
    shortDesc: columnIndex(result, "short_desc"),
    context: columnIndex(result, "context"),
    vartype: columnIndex(result, "vartype"),
    source: columnIndex(result, "source"),
    bootVal: columnIndex(result, "boot_val"),
    resetVal: columnIndex(result, "reset_val"),
    minVal: columnIndex(result, "min_val"),
    maxVal: columnIndex(result, "max_val"),
    enumVals: columnIndex(result, "enumvals"),
    pendingRestart: columnIndex(result, "pending_restart"),
  };

  return result.rows.map((row) => {
    const setting = readRawText(row, indexes.setting);
    const source = readTrimmedText(row, indexes.source);
    const bootVal = readNullableText(row, indexes.bootVal);
    return {
      name: readTrimmedText(row, indexes.name),
      setting,
      unit: readTrimmedText(row, indexes.unit),
      category: readTrimmedText(row, indexes.category),
      shortDesc: readTrimmedText(row, indexes.shortDesc),
      context: readTrimmedText(row, indexes.context),
      vartype: readTrimmedText(row, indexes.vartype),
      source,
      bootVal,
      resetVal: readNullableText(row, indexes.resetVal),
      minVal: readNullableText(row, indexes.minVal),
      maxVal: readNullableText(row, indexes.maxVal),
      enumVals: indexes.enumVals >= 0 ? parseGucEnumVals((row as unknown[])[indexes.enumVals]) : [],
      pendingRestart: indexes.pendingRestart >= 0 ? parsePendingRestart((row as unknown[])[indexes.pendingRestart]) : false,
      modified: isGucParameterModified({ source, setting, bootVal }),
    };
  });
}

/** Classify `pg_settings.context` into an actionable change-effect scope. */
export function gucContextLevel(context: string): GucContextLevel {
  const normalized = context.trim().toLowerCase();
  if (normalized === "user" || normalized === "superuser") return "session";
  if (normalized === "sighup") return "reload";
  if (normalized === "postmaster" || normalized === "backend" || normalized === "superuser-backend") return "restart";
  return "readonly";
}

/** Validate standard or extension-qualified GUC parameter names (`work_mem`, `pg_stat_statements.max`). */
export function isValidGucName(name: string): boolean {
  return GUC_NAME_PATTERN.test(name);
}

/** Normalize boolean GUC strings to `on` / `off`, or `null` when unrecognized. */
export function normalizeGucBoolValue(value: string): "on" | "off" | null {
  const normalized = value.trim().toLowerCase();
  if (BOOL_TRUE_VALUES.has(normalized)) return "on";
  if (BOOL_FALSE_VALUES.has(normalized)) return "off";
  return null;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatGucSqlIdentifier(name: string): string {
  if (SIMPLE_GUC_IDENTIFIER_PATTERN.test(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Format a GUC value literal according to `pg_settings.vartype`. */
export function formatGucSqlValue(value: string, vartype: string): string {
  const type = vartype.trim().toLowerCase();
  if (type === "bool") {
    return normalizeGucBoolValue(value) ?? quoteSqlString(value);
  }
  if (type === "integer") {
    const trimmed = value.trim();
    if (/^[+-]?\d+$/.test(trimmed)) return trimmed;
    return quoteSqlString(value);
  }
  if (type === "real") {
    const trimmed = value.trim();
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) && Number.isFinite(Number(trimmed))) {
      return trimmed;
    }
    return quoteSqlString(value);
  }
  return quoteSqlString(value);
}

/** Build a session-level `SET <name> = <val>;` SQL statement. */
export function buildGucSessionSetSql(name: string, value: string, vartype: string): string {
  return `SET ${formatGucSqlIdentifier(name)} = ${formatGucSqlValue(value, vartype)};`;
}

/** Build a persistent `ALTER SYSTEM SET <name> = <val>;` statement with optional `pg_reload_conf()`. */
export function buildGucAlterSystemSql(name: string, value: string, vartype: string, includeReload: boolean): string {
  const alterSql = `ALTER SYSTEM SET ${formatGucSqlIdentifier(name)} = ${formatGucSqlValue(value, vartype)};`;
  return includeReload ? `${alterSql}\nSELECT pg_reload_conf();` : alterSql;
}

function escapeShellDoubleQuoted(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/([\\"$`])/g, "\\$1");
}

/** Build an openGauss `gs_guc` CLI snippet for reloadable or restart-required parameters. */
export function buildGsGucCliCommand(name: string, value: string, reloadable: boolean): string {
  const action = reloadable ? "reload" : "set";
  const safeName = isValidGucName(name) ? name : escapeShellDoubleQuoted(name);
  const escaped = escapeShellDoubleQuoted(value);
  return `gs_guc ${action} -N all -I all -c "${safeName}=${escaped}"`;
}

/** Filter loaded GUC parameters by search query, preset pill, category, context level, and modified-only toggle. */
export function filterGucParameters(
  params: readonly OpenGaussGucParameter[],
  options: {
    search?: string;
    preset?: GucPresetFilter;
    category?: string;
    contextLevel?: GucContextLevel | "all";
    modifiedOnly?: boolean;
  },
): OpenGaussGucParameter[] {
  const searchNeedle = (options.search ?? "").trim().toLowerCase();
  const preset = options.preset ?? "all";
  const category = options.category ?? "all";
  const contextLevel = options.contextLevel ?? "all";
  const modifiedOnly = options.modifiedOnly ?? false;

  const presetNames = preset === "memory_concurrency" || preset === "compatibility" || preset === "audit_perf" ? new Set<string>(OPENGAUSS_GUC_PRESETS[preset]) : null;

  return params.filter((param) => {
    if (modifiedOnly && !param.modified) return false;
    if (category !== "all" && param.category !== category) return false;
    const level = gucContextLevel(param.context);
    if (contextLevel !== "all" && level !== contextLevel) return false;
    if (preset === "restart" && level !== "restart") return false;
    if (presetNames && !presetNames.has(param.name.toLowerCase())) return false;
    if (!searchNeedle) return true;
    return param.name.toLowerCase().includes(searchNeedle) || param.category.toLowerCase().includes(searchNeedle) || param.shortDesc.toLowerCase().includes(searchNeedle) || param.setting.toLowerCase().includes(searchNeedle);
  });
}
