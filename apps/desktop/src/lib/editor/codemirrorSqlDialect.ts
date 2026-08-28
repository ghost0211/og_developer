import type { SQLDialect } from "@codemirror/lang-sql";
import type { DatabaseType } from "@/types/database";

export type CodeMirrorSqlDialectName = "postgres";

type CodeMirrorSqlLanguageModule = Pick<typeof import("@codemirror/lang-sql"), "PostgreSQL" | "SQLDialect" | "StandardSQL">;

const DBX_COMMON_SQL_KEYWORDS = [
  "PIVOT",
  "UNPIVOT",
  "EXCLUDE",
  "REPLACE",
  "QUALIFY",
  "ASOF",
  "POSITIONAL",
  "ANTI",
  "SEMI",
  "SAMPLE",
  "TABLESAMPLE",
  "STRUCT",
  "MAP",
  "LIST",
  "ARRAY",
  "LAMBDA",
  "UNNEST",
  "LATERAL",
  "FILTER",
  "RECURSIVE",
  "SUMMARIZE",
  "PRAGMA",
  "READ_CSV",
  "READ_PARQUET",
  "READ_JSON",
  "DESCRIBE",
  "SHOW",
  "COPY",
  "EXPORT",
  "IMPORT",
].join(" ");

const POSTGRES_PLPGSQL_KEYWORDS = "PERFORM";
const POSTGRES_PLPGSQL_TYPES = "RECORD JSON JSONB";
const POSTGRES_PLPGSQL_BUILTIN = "SQLERRM TG_NAME TG_WHEN TG_LEVEL TG_OP TG_RELID TG_RELNAME TG_TABLE_NAME TG_TABLE_SCHEMA TG_NARGS TG_ARGV";
const POSTGRES_IDENTIFIER_LIKE_KEYWORDS = new Set("COMMENT COUNT DATA DAY HOUR ID KEY LEVEL MINUTE MONTH NAME OWNER PASSWORD POSITION ROLE SECOND TYPE USER VALUE YEAR".split(" "));

export function postgresKeywordSyntaxTerms(keywords: string): string {
  return keywords
    .split(/\s+/)
    .filter((keyword) => keyword && !POSTGRES_IDENTIFIER_LIKE_KEYWORDS.has(keyword.toUpperCase()))
    .join(" ");
}

function codeMirrorBaseDialect(langSql: CodeMirrorSqlLanguageModule, dialectName: CodeMirrorSqlDialectName, databaseType?: DatabaseType): SQLDialect {
  void dialectName;
  if (databaseType) {
    if (databaseType === "postgres" || databaseType === "opengauss") return langSql.PostgreSQL;
    return langSql.StandardSQL;
  }
  return langSql.PostgreSQL;
}

export function createDbxCodeMirrorSqlDialect(langSql: CodeMirrorSqlLanguageModule, dialectName: CodeMirrorSqlDialectName = "postgres", databaseType?: DatabaseType): SQLDialect {
  const baseDialect = codeMirrorBaseDialect(langSql, dialectName, databaseType);
  const isPostgres = baseDialect === langSql.PostgreSQL;
  const baseKeywords = isPostgres ? postgresKeywordSyntaxTerms(baseDialect.spec.keywords || "") : baseDialect.spec.keywords || "";
  const baseTypes = baseDialect.spec.types || "";

  return langSql.SQLDialect.define({
    ...baseDialect.spec,
    keywords: [baseKeywords, DBX_COMMON_SQL_KEYWORDS, isPostgres ? POSTGRES_PLPGSQL_KEYWORDS : ""].filter(Boolean).join(" "),
    types: [baseTypes, isPostgres ? POSTGRES_PLPGSQL_TYPES : ""].filter(Boolean).join(" ") || undefined,
    builtin: [baseDialect.spec.builtin || "", isPostgres ? POSTGRES_PLPGSQL_BUILTIN : ""].filter(Boolean).join(" ") || undefined,
    doubleDollarQuotedStrings: false,
  });
}
