import type { DatabaseType } from "@/types/database";

export interface SqlSemanticProjectionAliasVisibility {
  where: boolean;
  groupBy: boolean;
  having: boolean;
  orderBy: boolean;
}

export interface SqlSemanticDialectAdapter {
  id: string;
  identifierQuotes: Array<{ open: string; close: string }>;
  supportsAsForTableAlias: boolean;
  projectionAliasVisibility: SqlSemanticProjectionAliasVisibility;
  normalizeIdentifier(identifier: string, quoted?: boolean): string;
  quoteIdentifier(identifier: string): string;
  qualifierRole(parts: string[], context: "table" | "column" | "routine"): "catalog" | "schema" | "table" | "package" | "unknown";
}

function quoteWith(identifier: string, quote: string): string {
  return `${quote}${identifier.replaceAll(quote, quote + quote)}${quote}`;
}

function defaultNormalize(identifier: string): string {
  return identifier;
}

function lowerUnquoted(identifier: string, quoted?: boolean): string {
  return quoted ? identifier : identifier.toLowerCase();
}

const defaultProjectionAliasVisibility: SqlSemanticProjectionAliasVisibility = {
  where: false,
  groupBy: false,
  having: false,
  orderBy: true,
};

function roleForGenericQualifier(parts: string[], context: "table" | "column" | "routine"): "catalog" | "schema" | "table" | "package" | "unknown" {
  if (parts.length <= 0) return "unknown";
  if (context === "column") return parts.length >= 2 ? "table" : "table";
  if (context === "routine") return parts.length >= 2 ? "package" : "schema";
  if (parts.length >= 2) return "schema";
  return "schema";
}

export const SQL_SEMANTIC_DIALECTS: Record<string, SqlSemanticDialectAdapter> = {
  generic: {
    id: "generic",
    identifierQuotes: [{ open: '"', close: '"' }],
    supportsAsForTableAlias: true,
    projectionAliasVisibility: defaultProjectionAliasVisibility,
    normalizeIdentifier: defaultNormalize,
    quoteIdentifier: (identifier) => quoteWith(identifier, '"'),
    qualifierRole: roleForGenericQualifier,
  },
  postgres: {
    id: "postgres",
    identifierQuotes: [{ open: '"', close: '"' }],
    supportsAsForTableAlias: true,
    projectionAliasVisibility: defaultProjectionAliasVisibility,
    normalizeIdentifier: lowerUnquoted,
    quoteIdentifier: (identifier) => quoteWith(identifier, '"'),
    qualifierRole: roleForGenericQualifier,
  },
};

export function sqlReferenceAnalysisDialectFor(options: { databaseType?: DatabaseType; identifierQuote?: string; fallbackDialect: string }): string {
  return options.fallbackDialect;
}

export function sqlSemanticDialectFor(options: { databaseType?: DatabaseType; dialect?: "postgres" }): SqlSemanticDialectAdapter {
  if (options.dialect && SQL_SEMANTIC_DIALECTS[options.dialect]) return SQL_SEMANTIC_DIALECTS[options.dialect];
  switch (options.databaseType) {
    case "postgres":
    case "opengauss":
      return SQL_SEMANTIC_DIALECTS.postgres;
    default:
      return SQL_SEMANTIC_DIALECTS.generic;
  }
}
