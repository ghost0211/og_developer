import * as api from "@/lib/backend/api";
import type { SqlCompletionColumn } from "@/lib/sql/sqlCompletion";
import type { DatabaseType, QueryResult } from "@/types/database";

export interface LoadTableFunctionCompletionColumnsOptions {
  connectionId: string;
  database: string;
  databaseType?: DatabaseType;
  schema?: string;
  functionName: string;
  /** Visible relation name: the alias when present, otherwise the function name. */
  table: string;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function routineScopeFilter(schema: string, functionName: string): string {
  return `p.prokind = 'f'
  AND n.nspname = ${quoteSqlLiteral(schema)}
  AND p.proname = ${quoteSqlLiteral(functionName)}`;
}

/** RETURNS TABLE/OUT/INOUT columns are stored as output arguments in pg_proc. */
export function postgresTableFunctionOutputColumnsQuery(schema: string, functionName: string): string {
  return `SELECT
  p.proargnames[gs.ordinal] AS name,
  CASE
    WHEN p.proallargtypes IS NULL THEN p.proargtypes[gs.ordinal - 1]
    ELSE p.proallargtypes[gs.ordinal]
  END::regtype::text AS data_type,
  gs.ordinal AS ordinal
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN generate_series(1, 100) AS gs(ordinal)
  ON gs.ordinal <= COALESCE(array_length(p.proallargtypes, 1), p.pronargs)
WHERE ${routineScopeFilter(schema, functionName)}
  AND COALESCE(p.proargmodes[gs.ordinal], 'i') IN ('t', 'o', 'b')
  AND NULLIF(p.proargnames[gs.ordinal], '') IS NOT NULL
ORDER BY p.oid, gs.ordinal;`;
}

/** SETOF composite_type functions expose the composite type's attributes instead. */
export function postgresTableFunctionCompositeColumnsQuery(schema: string, functionName: string): string {
  return `SELECT
  a.attname AS name,
  a.atttypid::regtype::text AS data_type,
  a.attnum AS ordinal
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_class relation ON relation.reltype = p.prorettype
JOIN pg_attribute a ON a.attrelid = relation.oid
WHERE ${routineScopeFilter(schema, functionName)}
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY p.oid, a.attnum;`;
}

export function tableFunctionCompletionColumnsFromResult(result: QueryResult, table: string, schema?: string): SqlCompletionColumn[] {
  const columns: SqlCompletionColumn[] = [];
  const seen = new Set<string>();
  for (const row of result.rows) {
    const name = String(row[0] ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    columns.push({
      name,
      table,
      schema,
      dataType: String(row[1] ?? ""),
    });
  }
  return columns;
}

export async function loadTableFunctionCompletionColumns(options: LoadTableFunctionCompletionColumnsOptions): Promise<SqlCompletionColumn[]> {
  if (options.databaseType !== "postgres" && options.databaseType !== "opengauss") return [];
  const schema = options.schema?.trim() || "public";
  const queryOptions = { maxRows: 1000, pageSize: 1000 };
  const outputResult = await api.executeQuery(options.connectionId, options.database, postgresTableFunctionOutputColumnsQuery(schema, options.functionName), schema, undefined, queryOptions);
  const outputColumns = tableFunctionCompletionColumnsFromResult(outputResult, options.table, schema);
  if (outputColumns.length > 0) return outputColumns;

  const compositeResult = await api.executeQuery(options.connectionId, options.database, postgresTableFunctionCompositeColumnsQuery(schema, options.functionName), schema, undefined, queryOptions);
  return tableFunctionCompletionColumnsFromResult(compositeResult, options.table, schema);
}
