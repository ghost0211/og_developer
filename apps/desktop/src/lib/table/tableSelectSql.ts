import type { DatabaseType } from "@/types/database.ts";
import { isSchemaAware, usesDatabaseObjectTreeMode } from "@/lib/database/databaseCapabilities.ts";
import * as api from "@/lib/backend/api.ts";
import { isExplicitlyQuotedSqlIdentifier, quoteGaussDbJdbcIdentifier } from "@/lib/sql/sqlIdentifier.ts";

export interface BuildTableSelectSqlOptions {
  databaseType?: DatabaseType;
  identifierQuote?: string;
  schema?: string;
  tableName: string;
  tableType?: string;
  primaryKeys?: string[];
  columns?: string[];
  fallbackOrderColumns?: string[];
  orderBy?: string;
  limit?: number;
  offset?: number;
  whereInput?: string;
  includeRowId?: boolean;
  catalog?: string;
  database?: string;
}

export function quoteTableIdentifier(databaseType: DatabaseType | undefined, name: string): string {
  if (databaseType === "opengauss" && isExplicitlyQuotedSqlIdentifier(name)) return name;
  // JDBC connections use the driver-reported identifier quote string
  // (DatabaseMetaData.getIdentifierQuoteString()) — pass through unquoted.
  if (databaseType === "jdbc") return name;
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteTableDataIdentifier(databaseType: DatabaseType | undefined, name: string, identifierQuote?: string): string {
  if ((databaseType === "opengauss" || databaseType === "postgres") && identifierQuote != null) return quoteGaussDbJdbcIdentifier(name, identifierQuote);
  return quoteTableIdentifier(databaseType, name);
}

export function qualifiedTableName(options: Pick<BuildTableSelectSqlOptions, "databaseType" | "identifierQuote" | "schema" | "tableName" | "catalog" | "database">): string {
  const { databaseType, identifierQuote, schema, tableName } = options;
  if ((databaseType === "opengauss" || databaseType === "postgres") && identifierQuote != null) {
    const quotedTable = quoteTableDataIdentifier(databaseType, tableName, identifierQuote);
    const trimmedSchema = schema?.trim();
    if (trimmedSchema) {
      return `${quoteTableDataIdentifier(databaseType, trimmedSchema, identifierQuote)}.${quotedTable}`;
    }
    return quotedTable;
  }
  if (isSchemaAware(databaseType) && !usesDatabaseObjectTreeMode(databaseType) && schema) {
    return `${quoteTableIdentifier(databaseType, schema)}.${quoteTableIdentifier(databaseType, tableName)}`;
  }
  return quoteTableIdentifier(databaseType, tableName);
}

export function normalizeWhereInput(whereInput?: string): string {
  const withoutSemicolon = whereInput?.trim().replace(/;+$/, "").trim() ?? "";
  return withoutSemicolon.replace(/^where\b/i, "").trim();
}

export async function buildTableSelectSql(options: BuildTableSelectSqlOptions): Promise<string> {
  return api.buildTableSelectSql(options);
}
