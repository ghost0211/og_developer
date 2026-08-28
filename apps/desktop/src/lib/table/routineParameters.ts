import * as api from "@/lib/backend/api";
import type { DatabaseType, QueryResult } from "@/types/database";
import type { RoutineParameter, RoutineParameterMode, RoutineReturnInfo } from "@/lib/table/routineExecutionSql";

export interface LoadRoutineParametersOptions {
  connectionId: string;
  database: string;
  databaseType?: DatabaseType;
  schema?: string;
  routineName: string;
  /** Narrows pg_proc by prokind; omit to match both procedures and functions. */
  routineKind?: "procedure" | "function";
  /** identity arguments（pg_get_function_identity_arguments），用于同名重载的精确匹配 */
  signature?: string;
}

export async function loadRoutineParameters(options: LoadRoutineParametersOptions): Promise<RoutineParameter[]> {
  const sql = routineParametersQuery(options);
  if (!sql) {
    console.warn("[routine-params] unsupported database type, no SQL generated", options.databaseType, options.routineName);
    return [];
  }
  try {
    const result = await api.executeQuery(options.connectionId, options.database, sql, options.schema, undefined, {
      maxRows: 200,
      pageSize: 200,
    });
    const parameters = routineParametersFromResult(result, options.databaseType);
    console.debug("[routine-params]", options.routineName, "schema=", options.schema, "rows=", result.rows?.length ?? 0, "parsed=", parameters.length);
    return parameters;
  } catch (error) {
    console.warn("[routine-params] query failed for", options.routineName, "schema=", options.schema, error);
    throw error;
  }
}

/**
 * 探测函数的返回形态（pg_get_function_result + proretset）。
 * 标量返回的函数在执行窗口里用变量接收 + RAISE NOTICE 回显；
 * SETOF/TABLE/record 或探测失败时保持 SELECT * FROM 结果集形式。
 */
export async function loadRoutineReturnInfo(options: LoadRoutineParametersOptions): Promise<RoutineReturnInfo | null> {
  if (options.databaseType !== "postgres" && options.databaseType !== "opengauss") return null;
  if (options.routineKind === "procedure") return null;
  const effectiveSchema = options.schema || "public";
  const schema = quoteSqlLiteral(effectiveSchema);
  const parts = options.routineName
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  const packageMember = options.databaseType === "opengauss" && parts.length === 2 ? { packageName: parts[0], memberName: parts[1] } : null;
  const packageJoin = packageMember ? "JOIN pg_catalog.gs_package pkg ON pkg.oid = p.propackageid\n" : "";
  const nameFilter = packageMember ? `pkg.pkgname = ${quoteSqlLiteral(packageMember.packageName)}\n  AND p.proname = ${quoteSqlLiteral(packageMember.memberName)}` : `p.proname = ${quoteSqlLiteral(options.routineName)}`;
  const signatureFilter = options.signature?.trim() ? `\n  AND pg_get_function_identity_arguments(p.oid) = ${quoteSqlLiteral(options.signature)}` : "";
  const standalonePackageFilter = !packageMember && options.databaseType === "opengauss" ? "\n  AND (p.propackageid = 0 OR p.propackageid IS NULL)" : "";
  const sql = `SELECT pg_get_function_result(p.oid) AS return_type, p.proretset AS is_setof
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
${packageJoin}WHERE p.prokind = 'f'
  AND n.nspname = ${schema}
  AND ${nameFilter}${signatureFilter}${standalonePackageFilter}
LIMIT 1;`;
  try {
    const result = await api.executeQuery(options.connectionId, options.database, sql, options.schema, undefined, {
      maxRows: 5,
      pageSize: 5,
    });
    const row = result.rows?.[0];
    if (!row) return null;
    const rawSetof = row[1];
    const isSetof = typeof rawSetof === "boolean" ? rawSetof : ["t", "true", "1", "yes"].includes(String(rawSetof ?? "").toLowerCase());
    console.debug("[routine-params] return info", options.routineName, "=", row[0], "setof=", isSetof);
    return { returnType: String(row[0] ?? ""), isSetof };
  } catch (error) {
    console.warn("[routine-params] return info query failed for", options.routineName, error);
    return null;
  }
}

export function supportsRoutineParameterMetadata(databaseType?: DatabaseType): boolean {
  return databaseType === "postgres" || databaseType === "opengauss";
}

export function routineParametersQuery(options: Pick<LoadRoutineParametersOptions, "database" | "databaseType" | "schema" | "routineName" | "routineKind" | "signature">): string | null {
  if (!supportsRoutineParameterMetadata(options.databaseType)) return null;
  const effectiveSchema = options.schema || (options.databaseType === "postgres" || options.databaseType === "opengauss" ? "public" : "");
  const schema = quoteSqlLiteral(effectiveSchema);
  const name = quoteSqlLiteral(options.routineName);
  if (options.databaseType === "postgres" || options.databaseType === "opengauss") {
    const prokindFilter = options.routineKind === "procedure" ? "p.prokind = 'p'" : options.routineKind === "function" ? "p.prokind = 'f'" : "p.prokind IN ('p', 'f')";
    // openGauss 包成员以 `包名.成员名` 传递（侧栏树带 parentName）；
    // 同名成员存在于多个包，必须联表 gs_package 按包名限定。
    const parts = options.routineName
      .split(".")
      .map((part) => part.trim())
      .filter(Boolean);
    const packageMember = options.databaseType === "opengauss" && parts.length === 2 ? { packageName: parts[0], memberName: parts[1] } : null;
    const packageJoin = packageMember ? "JOIN pg_catalog.gs_package pkg ON pkg.oid = p.propackageid\n" : "";
    const nameFilter = packageMember ? `pkg.pkgname = ${quoteSqlLiteral(packageMember.packageName)}\n  AND p.proname = ${quoteSqlLiteral(packageMember.memberName)}` : `p.proname = ${name}`;
    // 同名重载（包内与独立例程都可能）按 identity arguments 精确匹配。
    const signatureFilter = options.signature?.trim() ? `\n  AND pg_get_function_identity_arguments(p.oid) = ${quoteSqlLiteral(options.signature)}` : "";
    // 独立例程不要混入同名包成员（openGauss 才有 propackageid）。
    const standalonePackageFilter = !packageMember && options.databaseType === "opengauss" ? "\n  AND (p.propackageid = 0 OR p.propackageid IS NULL)" : "";
    // openGauss 不支持 `CROSS JOIN LATERAL (SELECT ...)`（6.0-lite 实测语法错误），
    // 参数展开改用 generate_series 等值 JOIN；has_default 以“第几个 IN 类参数”
    // （input_ordinal）超过 pronargs - pronargdefaults 判定，窗口函数就地计算。
    return `
SELECT
  NULLIF(p.proargnames[gs.ordinal], '') AS name,
  CASE
    WHEN p.proallargtypes IS NULL THEN p.proargtypes[gs.ordinal - 1]
    ELSE p.proallargtypes[gs.ordinal]
  END::regtype::text AS data_type,
  CASE COALESCE(p.proargmodes[gs.ordinal], 'i')
    WHEN 'i' THEN 'IN'
    WHEN 'o' THEN 'OUT'
    WHEN 'b' THEN 'INOUT'
    WHEN 'v' THEN 'IN'
    WHEN 't' THEN 'OUT'
    ELSE 'IN'
  END AS mode,
  gs.ordinal AS ordinal,
  CASE
    WHEN COALESCE(p.proargmodes[gs.ordinal], 'i') IN ('i', 'b', 'v')
      AND p.pronargdefaults > 0
      AND COUNT(*) FILTER (WHERE COALESCE(p.proargmodes[gs.ordinal], 'i') IN ('i', 'b', 'v')) OVER (ORDER BY gs.ordinal) > p.pronargs - p.pronargdefaults
    THEN TRUE
    ELSE FALSE
  END AS has_default
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
${packageJoin}JOIN generate_series(1, 100) AS gs(ordinal)
  ON gs.ordinal <= COALESCE(array_length(p.proallargtypes, 1), p.pronargs)
WHERE ${prokindFilter}
  AND n.nspname = ${schema}
  AND ${nameFilter}${signatureFilter}${standalonePackageFilter}
ORDER BY gs.ordinal;`.trim();
  }
  return null;
}

export function routineParametersFromResult(result: QueryResult, databaseType?: DatabaseType): RoutineParameter[] {
  void databaseType;
  return result.rows
    .map((row, index) => {
      return {
        name: String(row[0] || `arg${index + 1}`),
        dataType: String(row[1] || ""),
        mode: normalizeParameterMode(row[2]),
        ordinal: Number(row[3] || index + 1),
        hasDefault: normalizeBoolean(row[4]),
      };
    })
    .filter((parameter) => parameter.mode !== "RETURN");
}

function normalizeParameterMode(value: unknown): RoutineParameterMode {
  const mode = String(value || "IN")
    .toUpperCase()
    .replace(/\s+/g, "");
  if (mode === "IN") return "IN";
  if (mode === "OUT") return "OUT";
  if (mode === "INOUT" || mode === "IN/OUT") return "INOUT";
  if (mode === "RETURN") return "RETURN";
  return "UNKNOWN";
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value || "").toLowerCase();
  return text === "true" || text === "yes" || text === "y" || text === "1";
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
