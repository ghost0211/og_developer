import { readSqlBracedParameterAt, type SqlParameterOptions } from "@/lib/sql/sqlParameters";
import type { DatabaseType } from "@/types/database";

export const MAX_SQL_SYNTAX_LINT_CHARS = 200_000;

export type SqlSyntaxDiagnosticCode =
  | "fullwidth-semicolon"
  | "fullwidth-comma"
  | "fullwidth-lparen"
  | "fullwidth-rparen"
  | "unclosed-single-quote"
  | "unclosed-double-quote"
  | "unclosed-backtick"
  | "unclosed-dollar-quote"
  | "unclosed-block-comment"
  | "unmatched-block-comment-end"
  | "unclosed-lparen"
  | "unmatched-rparen"
  | "keyword-typo";

export interface SqlSyntaxQuickFix {
  from: number;
  to: number;
  replacement: string;
  replaceAllChanges?: Array<{ from: number; to: number; insert: string }>;
  replaceAllCount?: number;
}

export interface SqlSyntaxDiagnostic {
  code: SqlSyntaxDiagnosticCode;
  from: number;
  to: number;
  severity: "error" | "warning";
  token: string;
  suggestion?: string;
  quickFix?: SqlSyntaxQuickFix;
}

export interface SqlSyntaxLintOptions {
  databaseType?: DatabaseType;
  parameterOptions?: SqlParameterOptions;
  /** Current caret offset when actively editing; suppresses prefix-in-progress keyword warnings at the caret. */
  activeCursorPos?: number | null;
}

export interface SqlSyntaxDiagnosticMessages {
  fullwidthSemicolon: string;
  fullwidthComma: string;
  fullwidthLeftParen: string;
  fullwidthRightParen: string;
  unclosedSingleQuote: string;
  unclosedDoubleQuote: string;
  unclosedBacktick: string;
  unclosedDollarQuote: (tag: string) => string;
  unclosedBlockComment: string;
  unmatchedBlockCommentEnd: string;
  unclosedLeftParen: string;
  unmatchedRightParen: string;
  keywordTypo: (token: string, suggestion: string) => string;
}

const DEFAULT_ZH_MESSAGES: SqlSyntaxDiagnosticMessages = {
  fullwidthSemicolon: '检测到中文全角分号 "；"（执行时将自动按 ";" 兼容处理），建议使用英文半角 ";"',
  fullwidthComma: '检测到中文全角逗号 "，"（执行时将自动按 "," 兼容处理），建议使用英文半角 ","',
  fullwidthLeftParen: '检测到中文全角左括号 "（"，请使用英文半角 "("',
  fullwidthRightParen: '检测到中文全角右括号 "）"，请使用英文半角 ")"',
  unclosedSingleQuote: '未闭合的字符串单引号 "\'"',
  unclosedDoubleQuote: '未闭合的双引号标识符 """',
  unclosedBacktick: '未闭合的反引号标识符 "`"',
  unclosedDollarQuote: (tag) => `未闭合的美元引号 "${tag}"`,
  unclosedBlockComment: '未闭合的块注释 "/*"',
  unmatchedBlockCommentEnd: '多余的块注释结束符 "*/"，缺少对应的 "/*"',
  unclosedLeftParen: '未闭合的左括号 "("，缺少对应的 ")"',
  unmatchedRightParen: '多余的右括号 ")"，缺少对应的 "("',
  keywordTypo: (token, suggestion) => `疑似关键词拼写错误 "${token}"，是否想输入 "${suggestion}"？`,
};

export function formatSqlSyntaxDiagnosticMessage(diagnostic: SqlSyntaxDiagnostic, messages: SqlSyntaxDiagnosticMessages = DEFAULT_ZH_MESSAGES): string {
  switch (diagnostic.code) {
    case "fullwidth-semicolon":
      return messages.fullwidthSemicolon;
    case "fullwidth-comma":
      return messages.fullwidthComma;
    case "fullwidth-lparen":
      return messages.fullwidthLeftParen;
    case "fullwidth-rparen":
      return messages.fullwidthRightParen;
    case "unclosed-single-quote":
      return messages.unclosedSingleQuote;
    case "unclosed-double-quote":
      return messages.unclosedDoubleQuote;
    case "unclosed-backtick":
      return messages.unclosedBacktick;
    case "unclosed-dollar-quote":
      return messages.unclosedDollarQuote(diagnostic.token);
    case "unclosed-block-comment":
      return messages.unclosedBlockComment;
    case "unmatched-block-comment-end":
      return messages.unmatchedBlockCommentEnd;
    case "unclosed-lparen":
      return messages.unclosedLeftParen;
    case "unmatched-rparen":
      return messages.unmatchedRightParen;
    case "keyword-typo":
      return messages.keywordTypo(diagnostic.token, diagnostic.suggestion ?? "");
  }
}

/**
 * Known valid SQL / PL/SQL / openGauss / PostgreSQL / MySQL / Oracle keywords.
 * Any word in this set is NEVER reported as a keyword typo (Guard 1).
 */
const ALL_KNOWN_SQL_WORDS = new Set(
  [
    // DML & Query
    "SELECT",
    "FROM",
    "WHERE",
    "INSERT",
    "INTO",
    "VALUES",
    "VALUE",
    "UPDATE",
    "SET",
    "DELETE",
    "MERGE",
    "UPSERT",
    "REPLACE",
    "RETURNING",
    "WITH",
    "RECURSIVE",
    "AS",
    "DISTINCT",
    "ALL",
    "GROUP",
    "BY",
    "HAVING",
    "ORDER",
    "ASC",
    "DESC",
    "NULLS",
    "FIRST",
    "LAST",
    "LIMIT",
    "OFFSET",
    "FETCH",
    "NEXT",
    "ROW",
    "ROWS",
    "ONLY",
    "PERCENT",
    "TIES",
    "TOP",
    "FOR",
    "SHARE",
    "NOWAIT",
    "SKIP",
    "LOCKED",
    "OF",
    "WAIT",
    "UNION",
    "INTERSECT",
    "EXCEPT",
    "MINUS",
    "JOIN",
    "INNER",
    "LEFT",
    "RIGHT",
    "FULL",
    "OUTER",
    "CROSS",
    "NATURAL",
    "STRAIGHT_JOIN",
    "SEMI",
    "ANTI",
    "ASOF",
    "ON",
    "USING",
    "LATERAL",
    "TABLESAMPLE",
    "SAMPLE",
    "BERNOULLI",
    "SYSTEM",
    "REPEATABLE",
    "WINDOW",
    "OVER",
    "PARTITION",
    "RANGE",
    "GROUPS",
    "UNBOUNDED",
    "PRECEDING",
    "FOLLOWING",
    "CURRENT",
    "EXCLUDE",
    "FILTER",
    "WITHIN",
    "GROUPING",
    "SETS",
    "ROLLUP",
    "CUBE",
    "PIVOT",
    "UNPIVOT",
    "QUALIFY",
    "CONNECT",
    "START",
    "PRIOR",
    "NOCYCLE",
    "SIBLINGS",
    // Operators & Expressions
    "AND",
    "OR",
    "NOT",
    "XOR",
    "IS",
    "ISNULL",
    "NOTNULL",
    "NULL",
    "TRUE",
    "FALSE",
    "UNKNOWN",
    "IN",
    "EXISTS",
    "BETWEEN",
    "SYMMETRIC",
    "ASYMMETRIC",
    "LIKE",
    "ILIKE",
    "RLIKE",
    "REGEXP",
    "SIMILAR",
    "TO",
    "ESCAPE",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "ANY",
    "SOME",
    "CAST",
    "TRY_CAST",
    "EXTRACT",
    "OVERLAY",
    "PLACING",
    "POSITION",
    "SUBSTRING",
    "TRIM",
    "BOTH",
    "LEADING",
    "TRAILING",
    "COLLATE",
    "AT",
    "TIME",
    "ZONE",
    "INTERVAL",
    "DATE",
    "TIMESTAMP",
    "ARRAY",
    "ROWNUM",
    "ROWID",
    "LEVEL",
    "SYSDATE",
    "SYSTIMESTAMP",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "CURRENT_TIMESTAMP",
    "LOCALTIME",
    "LOCALTIMESTAMP",
    "CURRENT_USER",
    "SESSION_USER",
    "SYSTEM_USER",
    "USER",
    "DEFAULT",
    "EXCLUDED",
    "DUAL",
    // DDL & Objects
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "RENAME",
    "COMMENT",
    "TABLE",
    "TABLES",
    "VIEW",
    "VIEWS",
    "MATERIALIZED",
    "INCREMENTAL",
    "INDEX",
    "INDEXES",
    "KEY",
    "KEYS",
    "SEQUENCE",
    "SEQUENCES",
    "SCHEMA",
    "SCHEMAS",
    "DATABASE",
    "DATABASES",
    "FUNCTION",
    "FUNCTIONS",
    "PROCEDURE",
    "PROCEDURES",
    "ROUTINE",
    "ROUTINES",
    "PACKAGE",
    "BODY",
    "TRIGGER",
    "TRIGGERS",
    "TYPE",
    "TYPES",
    "DOMAIN",
    "SYNONYM",
    "DIRECTORY",
    "EVENT",
    "JOB",
    "ROLE",
    "ROLES",
    "GROUP",
    "TABLESPACE",
    "EXTENSION",
    "RULE",
    "POLICY",
    "PUBLICATION",
    "SUBSCRIPTION",
    "SERVER",
    "WRAPPER",
    "DATA",
    "SOURCE",
    "MODEL",
    "RESOURCE",
    "POOL",
    "OPERATOR",
    "AGGREGATE",
    "COLLATION",
    "CONVERSION",
    "LANGUAGE",
    "CAST",
    "GLOBAL",
    "LOCAL",
    "TEMP",
    "TEMPORARY",
    "UNLOGGED",
    "EXTERNAL",
    "FOREIGN",
    "PUBLIC",
    "CONCURRENTLY",
    "IF",
    "FORCE",
    "NOFORCE",
    "EDITIONABLE",
    "NONEDITIONABLE",
    "CASCADE",
    "RESTRICT",
    "ADD",
    "MODIFY",
    "CHANGE",
    "COLUMN",
    "COLUMNS",
    "CONSTRAINT",
    "CONSTRAINTS",
    "PRIMARY",
    "UNIQUE",
    "CHECK",
    "REFERENCES",
    "MATCH",
    "PARTIAL",
    "SIMPLE",
    "ACTION",
    "NO",
    "DEFERRABLE",
    "INITIALLY",
    "DEFERRED",
    "IMMEDIATE",
    "ENABLE",
    "DISABLE",
    "VALIDATE",
    "NOVALIDATE",
    "RELY",
    "NORELY",
    "ENFORCED",
    "GENERATED",
    "ALWAYS",
    "IDENTITY",
    "STORED",
    "VIRTUAL",
    "AUTO_INCREMENT",
    "AUTOINCREMENT",
    "UNSIGNED",
    "ZEROFILL",
    "INCLUDING",
    "EXCLUDING",
    "INHERITS",
    "INHERIT",
    "LIKE",
    "WITH",
    "WITHOUT",
    "OIDS",
    "ORIENTATION",
    "COMPRESSION",
    "DISTRIBUTE",
    "HASH",
    "LIST",
    "REPLICATION",
    "ROUNDROBIN",
    "MODULO",
    "SLICE",
    "SUBPARTITION",
    "PARTITIONS",
    "LESS",
    "THAN",
    "MAXVALUE",
    "MINVALUE",
    "NOMAXVALUE",
    "NOMINVALUE",
    "INCREMENT",
    "CACHE",
    "NOCACHE",
    "CYCLE",
    "NOORDER",
    "OWNED",
    "OWNER",
    "REPLICA",
    "ATTACH",
    "DETACH",
    "EXCHANGE",
    "SPLIT",
    "MOVE",
    "SHRINK",
    "MOVEMENT",
    "DELTAROW",
    "CONFLICT",
    "DUPLICATE",
    "NOTHING",
    "OVERRIDING",
    " match",
    "MATCHED",
    // openGauss Flashback / Recyclebin / Maintenance / Admin
    "TIMECAPSULE",
    "FLASHBACK",
    "PURGE",
    "RECYCLEBIN",
    "SCN",
    "CSN",
    "EXPLAIN",
    "ANALYZE",
    "ANALYSE",
    "PERFORMANCE",
    "VERBOSE",
    "COSTS",
    "BUFFERS",
    "TIMING",
    "SUMMARY",
    "FORMAT",
    "SETTINGS",
    "WAL",
    "VACUUM",
    "FREEZE",
    "REINDEX",
    "CLUSTER",
    "REFRESH",
    "COPY",
    "STDIN",
    "STDOUT",
    "CSV",
    "HEADER",
    "DELIMITER",
    "QUOTE",
    "ENCODING",
    "CHECKPOINT",
    "DISCARD",
    "LOAD",
    "LISTEN",
    "NOTIFY",
    "UNLISTEN",
    "LOCK",
    "ACCESS",
    "EXCLUSIVE",
    "MODE",
    "GRANT",
    "REVOKE",
    "PRIVILEGES",
    "OPTION",
    "ADMIN",
    "IDENTIFIED",
    "PASSWORD",
    "PROFILE",
    "ACCOUNT",
    "UNLOCK",
    "EXPIRE",
    "AUTHORIZATION",
    "SECURITY",
    "LABEL",
    "INVOKER",
    "DEFINER",
    "BEGIN",
    "COMMIT",
    "END",
    "WORK",
    "TRANSACTION",
    "ROLLBACK",
    "ABORT",
    "SAVEPOINT",
    "RELEASE",
    "PREPARE",
    "EXECUTE",
    "DEALLOCATE",
    "ISOLATION",
    "READ",
    "WRITE",
    "COMMITTED",
    "UNCOMMITTED",
    "SERIALIZABLE",
    "SHOW",
    "RESET",
    "SESSION",
    "LOCAL",
    "CHARACTERISTICS",
    "CONSTRAINTS",
    "USE",
    "DESC",
    "DESCRIBE",
    "PRAGMA",
    "SUMMARIZE",
    "SUMMARISE",
    "EXPORT",
    "IMPORT",
    "CLEAN",
    "BARRIER",
    "REASSIGN",
    // PL/pgSQL & Oracle PL/SQL
    "DECLARE",
    "DO",
    "CALL",
    "EXEC",
    "PERFORM",
    "OPEN",
    "CLOSE",
    "CURSOR",
    "REFCURSOR",
    "SYS_REFCURSOR",
    "SCROLL",
    "NOSCROLL",
    "LOOP",
    "WHILE",
    "FOR",
    "FOREACH",
    "FORALL",
    "REVERSE",
    "EXIT",
    "CONTINUE",
    "GOTO",
    "RETURN",
    "RETURNS",
    "SETOF",
    "ELSIF",
    "ELSEIF",
    "EXCEPTION",
    "EXCEPTIONS",
    "OTHERS",
    "RAISE",
    "NOTICE",
    "WARNING",
    "INFO",
    "DEBUG",
    "LOG",
    "ASSERT",
    "DIAGNOSTICS",
    "STACKED",
    "GET",
    "STRICT",
    "INTO",
    "BULK",
    "COLLECT",
    "SAVE",
    "CONSTANT",
    "INOUT",
    "OUT",
    "VARIADIC",
    "NOCOPY",
    "DETERMINISTIC",
    "IMMUTABLE",
    "STABLE",
    "VOLATILE",
    "LEAKPROOF",
    "PARALLEL",
    "SAFE",
    "UNSAFE",
    "RESTRICTED",
    "COST",
    "FENCED",
    "SHIPPABLE",
    "PIPELINED",
    "AUTHID",
    "ACCESSIBLE",
    "SUBTYPE",
    "RECORD",
    "OBJECT",
    "VARRAY",
    "MEMBER",
    "STATIC",
    "CONSTRUCTOR",
    "MAP",
    "FINAL",
    "INSTANTIABLE",
    "OVERRIDING",
    "BEFORE",
    "AFTER",
    "INSTEAD",
    "EACH",
    "STATEMENT",
    "REFERENCING",
    "OLD",
    "NEW",
    "AUTONOMOUS_TRANSACTION",
    "EXCEPTION_INIT",
    "SERIALLY_REUSABLE",
    "INSTANTIATION",
    // Common Data Types
    "INT",
    "INT2",
    "INT4",
    "INT8",
    "INTEGER",
    "SMALLINT",
    "BIGINT",
    "TINYINT",
    "MEDIUMINT",
    "SERIAL",
    "SMALLSERIAL",
    "BIGSERIAL",
    "NUMERIC",
    "DECIMAL",
    "DEC",
    "NUMBER",
    "FLOAT",
    "FLOAT4",
    "FLOAT8",
    "REAL",
    "DOUBLE",
    "PRECISION",
    "BINARY_FLOAT",
    "BINARY_DOUBLE",
    "BINARY_INTEGER",
    "PLS_INTEGER",
    "MONEY",
    "BOOLEAN",
    "BOOL",
    "CHAR",
    "CHARACTER",
    "NCHAR",
    "VARCHAR",
    "VARCHAR2",
    "NVARCHAR",
    "NVARCHAR2",
    "VARYING",
    "TEXT",
    "TINYTEXT",
    "MEDIUMTEXT",
    "LONGTEXT",
    "CLOB",
    "NCLOB",
    "BLOB",
    "TINYBLOB",
    "MEDIUMBLOB",
    "LONGBLOB",
    "BYTEA",
    "BINARY",
    "VARBINARY",
    "RAW",
    "LONG",
    "BIT",
    "VARBIT",
    "DATETIME",
    "SMALLDATETIME",
    "TIMETZ",
    "TIMESTAMPTZ",
    "YEAR",
    "MONTH",
    "DAY",
    "HOUR",
    "MINUTE",
    "SECOND",
    "JSON",
    "JSONB",
    "XML",
    "XMLTYPE",
    "UUID",
    "VOID",
    "UUID",
    "INET",
    "CIDR",
    "MACADDR",
    "VECTOR",
  ].map((word) => word.trim().toUpperCase()),
);

const STATEMENT_START_KEYWORDS = [
  "SELECT",
  "WITH",
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "REPLACE",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "COMMENT",
  "GRANT",
  "REVOKE",
  "EXPLAIN",
  "ANALYZE",
  "VACUUM",
  "REINDEX",
  "CLUSTER",
  "REFRESH",
  "BEGIN",
  "START",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "SET",
  "RESET",
  "SHOW",
  "CALL",
  "EXEC",
  "EXECUTE",
  "PREPARE",
  "DEALLOCATE",
  "DECLARE",
  "DO",
  "COPY",
  "LOCK",
  "FETCH",
  "MOVE",
  "CLOSE",
  "OPEN",
  "VALUES",
  "TIMECAPSULE",
  "PURGE",
  "DESCRIBE",
] as const;

const PLSQL_STATEMENT_START_KEYWORDS = [...STATEMENT_START_KEYWORDS, "PERFORM", "RETURN", "RAISE", "IF", "CASE", "LOOP", "WHILE", "FOR", "FOREACH", "FORALL", "EXIT", "CONTINUE", "GOTO", "NULL", "PRAGMA", "EXCEPTION", "ASSERT"] as const;

const DDL_CREATE_KEYWORDS = [
  "OR",
  "REPLACE",
  "GLOBAL",
  "LOCAL",
  "TEMP",
  "TEMPORARY",
  "UNLOGGED",
  "UNIQUE",
  "CONCURRENTLY",
  "MATERIALIZED",
  "INCREMENTAL",
  "PUBLIC",
  "FORCE",
  "NOFORCE",
  "EDITIONABLE",
  "NONEDITIONABLE",
  "EXTERNAL",
  "FOREIGN",
  "TABLE",
  "VIEW",
  "INDEX",
  "SEQUENCE",
  "SCHEMA",
  "DATABASE",
  "FUNCTION",
  "PROCEDURE",
  "PACKAGE",
  "TRIGGER",
  "TYPE",
  "SYNONYM",
  "ROLE",
  "USER",
  "GROUP",
  "TABLESPACE",
  "EXTENSION",
  "RULE",
  "DOMAIN",
  "DIRECTORY",
  "EVENT",
  "JOB",
  "PUBLICATION",
  "SUBSCRIPTION",
  "MODEL",
  "SERVER",
  "POLICY",
  "OPERATOR",
  "AGGREGATE",
  "COLLATION",
  "CONVERSION",
  "LANGUAGE",
  "RESOURCE",
] as const;

const DDL_OBJECT_KEYWORDS = [
  "TABLE",
  "VIEW",
  "INDEX",
  "SEQUENCE",
  "SCHEMA",
  "DATABASE",
  "FUNCTION",
  "PROCEDURE",
  "PACKAGE",
  "TRIGGER",
  "TYPE",
  "SYNONYM",
  "ROLE",
  "USER",
  "GROUP",
  "TABLESPACE",
  "EXTENSION",
  "RULE",
  "DOMAIN",
  "DIRECTORY",
  "EVENT",
  "JOB",
  "PUBLICATION",
  "SUBSCRIPTION",
  "MODEL",
  "SERVER",
  "POLICY",
  "MATERIALIZED",
  "FOREIGN",
  "PUBLIC",
  "CONCURRENTLY",
  "SYSTEM",
  "SESSION",
  "DEFAULT",
  "LARGE",
  "OWNED",
  "RESOURCE",
] as const;

const ALTER_TABLE_ACTION_KEYWORDS = ["ADD", "DROP", "ALTER", "MODIFY", "CHANGE", "RENAME", "SET", "RESET", "OWNER", "ENABLE", "DISABLE", "VALIDATE", "CLUSTER", "INHERIT", "ATTACH", "DETACH", "PARTITION", "TRUNCATE", "EXCHANGE", "MERGE", "SPLIT", "MOVE", "REPLICA", "FORCE"] as const;

const TABLE_COLUMN_CONSTRAINT_KEYWORDS = ["NOT", "NULL", "DEFAULT", "PRIMARY", "UNIQUE", "REFERENCES", "CHECK", "CONSTRAINT", "GENERATED", "ALWAYS", "IDENTITY", "COLLATE", "COMMENT", "AUTO_INCREMENT", "AUTOINCREMENT", "DEFERRABLE", "INITIALLY", "DEFERRED", "IMMEDIATE", "ENABLE", "DISABLE"] as const;

const POST_SELECT_PROJECTION_KEYWORDS = ["FROM", "INTO", "WHERE", "GROUP", "HAVING", "WINDOW", "ORDER", "LIMIT", "OFFSET", "FETCH", "FOR", "UNION", "INTERSECT", "EXCEPT", "MINUS"] as const;

const POST_TABLE_SOURCE_KEYWORDS = ["WHERE", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "ON", "USING", "GROUP", "HAVING", "WINDOW", "ORDER", "LIMIT", "OFFSET", "FETCH", "FOR", "UNION", "INTERSECT", "EXCEPT", "MINUS", "SET", "VALUES", "RETURNING"] as const;

const CLAUSE_EXPRESSION_KEYWORDS = ["AND", "OR", "BETWEEN", "LIKE", "ILIKE", "SIMILAR", "WHERE", "GROUP", "HAVING", "WINDOW", "ORDER", "LIMIT", "OFFSET", "FETCH", "RETURNING", "UNION", "INTERSECT", "EXCEPT", "MINUS", "THEN", "ELSE"] as const;

const VALID_POST_ALIAS_WORDS = new Set<string>([...POST_TABLE_SOURCE_KEYWORDS, "AS", "OUTER", "SEMI", "ANTI", "ASOF", "LATERAL", "TABLESAMPLE", "SAMPLE", "PARTITION", "SUBPARTITION", "CONNECT", "START", "PIVOT", "UNPIVOT", "QUALIFY", "INTO"]);

const BY_PRECEDING_KEYWORDS = ["ORDER", "GROUP", "PARTITION", "CONNECT", "INCREMENT", "IDENTIFIED", "OWNED", "DISTRIBUTE"] as const;
const JOIN_MODIFIER_KEYWORDS = ["LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "NATURAL"] as const;
const SUBQUERY_TRIGGER_WORDS = new Set(["IN", "EXISTS", "FROM", "JOIN", "AS", "ANY", "SOME", "ALL", "UNION", "INTERSECT", "EXCEPT", "MINUS", "RETURN", "QUERY"]);
const SUBQUERY_TRIGGER_OPS = new Set(["=", "!=", "<>", "<", ">", "<=", ">="]);

const WORD_START_RE = /[\p{L}\p{Nl}_@$]/u;
const WORD_CONTINUE_RE = /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}$#]/u;
const ASCII_ALPHA_WORD_RE = /^[A-Za-z]+$/;

interface LintToken {
  kind: "word" | "quoted_ident" | "string" | "number" | "param" | "punct" | "op";
  text: string;
  upper: string;
  from: number;
  to: number;
  parenDepth: number;
  dollarTag?: string;
}

function startsHashLineComment(sql: string, pos: number, parameterOptions?: SqlParameterOptions): boolean {
  if (sql[pos] !== "#") return false;
  return readSqlBracedParameterAt(sql, pos, parameterOptions)?.syntax !== "mybatis";
}

function matchDollarQuoteTag(sql: string, pos: number): string | null {
  if (sql[pos] !== "$") return null;
  if (sql[pos + 1] === "$") return "$$";
  const match = /^\$[A-Za-z_\x80-\uffff][A-Za-z0-9_\x80-\uffff]*\$/.exec(sql.slice(pos));
  return match ? match[0] : null;
}

function countRemainingUnescapedSingleQuotes(sql: string, from: number, parameterOptions?: SqlParameterOptions): number {
  let count = 0;
  let i = from;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";
    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i + 2);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (startsHashLineComment(sql, i, parameterOptions)) {
      const nl = sql.indexOf("\n", i + 1);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'") {
      if (next === "'") {
        i += 2;
        continue;
      }
      count += 1;
    }
    i += 1;
  }
  return count;
}

function isEscapedSingleQuotePrefix(sql: string, quotePos: number): boolean {
  if (quotePos <= 0) return false;
  const prev = sql[quotePos - 1];
  if (prev !== "e" && prev !== "E") return false;
  const beforePrev = quotePos >= 2 ? (sql[quotePos - 2] ?? "") : "";
  return !WORD_CONTINUE_RE.test(beforePrev);
}

function normalizeSqlFullwidthChars(sql: string, replacements: Readonly<Record<string, string>>, parameterOptions?: SqlParameterOptions): string {
  const targets = Object.keys(replacements);
  if (targets.every((ch) => !sql.includes(ch))) return sql;

  let out = "";
  let segmentStart = 0;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? "";

    // Line comments
    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i + 2);
      i = nl === -1 ? len : nl + 1;
      continue;
    }
    if (startsHashLineComment(sql, i, parameterOptions)) {
      const nl = sql.indexOf("\n", i + 1);
      i = nl === -1 ? len : nl + 1;
      continue;
    }

    // Nested block comments
    if (ch === "/" && next === "*") {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }

    // Braced template parameters (#{...}, ${...})
    if (ch === "#" || ch === "$") {
      const braced = readSqlBracedParameterAt(sql, i, parameterOptions);
      if (braced) {
        i = braced.end;
        continue;
      }
    }

    // Single-quoted string literal
    if (ch === "'") {
      const explicitEscape = isEscapedSingleQuotePrefix(sql, i);
      i += 1;
      while (i < len) {
        const c = sql[i]!;
        const n = sql[i + 1] ?? "";
        if (c === "\\" && n) {
          if (explicitEscape) {
            i += 2;
            continue;
          }
          if (n === "'" && countRemainingUnescapedSingleQuotes(sql, i + 2, parameterOptions) % 2 === 1) {
            i += 2;
            continue;
          }
        }
        if (c === "'") {
          if (n === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      i += 1;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // Backtick-quoted identifier
    if (ch === "`") {
      i += 1;
      while (i < len) {
        if (sql[i] === "`") {
          if (sql[i + 1] === "`") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // Bracket-quoted identifier
    if (ch === "[") {
      i += 1;
      while (i < len) {
        if (sql[i] === "]") {
          if (sql[i + 1] === "]") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // Dollar-quoted string
    const dollarTag = matchDollarQuoteTag(sql, i);
    if (dollarTag) {
      const closeIdx = sql.indexOf(dollarTag, i + dollarTag.length);
      i = closeIdx === -1 ? len : closeIdx + dollarTag.length;
      continue;
    }

    const mapped = replacements[ch];
    if (mapped !== undefined) {
      out += sql.slice(segmentStart, i) + mapped;
      segmentStart = i + 1;
    }
    i += 1;
  }

  if (segmentStart === 0) return sql;
  return out + sql.slice(segmentStart);
}

/**
 * Replaces fullwidth semicolons (`；`, U+FF1B) with ASCII `;` ONLY in top-level
 * SQL code regions (outside string literals, dollar-quoted bodies, quoted
 * identifiers, and line/block comments).
 */
export function normalizeSqlFullwidthSemicolons(sql: string, parameterOptions?: SqlParameterOptions): string {
  return normalizeSqlFullwidthChars(sql, { "；": ";" }, parameterOptions);
}

/**
 * Replaces fullwidth semicolons (`；` -> `;`) and fullwidth commas (`，` -> `,`)
 * ONLY in top-level SQL code regions (preserving literals, quoted identifiers,
 * dollar-quoted strings, braced parameters, and comments).
 *
 * UTF-16 length is preserved 1:1 so editor selection/source offsets remain exact.
 */
export function normalizeSqlFullwidthPunctuation(sql: string, parameterOptions?: SqlParameterOptions): string {
  return normalizeSqlFullwidthChars(sql, { "；": ";", "，": "," }, parameterOptions);
}

/**
 * Conservative SQL & PL/SQL syntax checker.
 *
 * Design principles:
 * - Strictly ignores object names, column names, aliases, string literals, quoted
 *   identifiers, dollar-quoted string literals, and comments.
 * - Flags fullwidth SQL punctuation (`；`, `，`, `（`, `）`) in code regions.
 * - Flags unclosed quotes, block comments, dollar-quotes, and unbalanced parentheses.
 * - Flags keyword/reserved-word typos ONLY when both:
 *   (1) the token sits in a grammatical slot where an arbitrary identifier cannot appear, AND
 *   (2) the token is not a valid SQL keyword and closely matches an expected keyword.
 */
export function lintSqlSyntax(sql: string, options: SqlSyntaxLintOptions = {}): SqlSyntaxDiagnostic[] {
  if (!sql || sql.length > MAX_SQL_SYNTAX_LINT_CHARS) return [];

  const diagnostics: SqlSyntaxDiagnostic[] = [];
  lintSqlRegion(sql, 0, options, false, diagnostics);

  attachBatchPunctuationQuickFixes(diagnostics);
  diagnostics.sort((a, b) => a.from - b.from || a.to - b.to || a.code.localeCompare(b.code));
  return diagnostics;
}

function attachBatchPunctuationQuickFixes(diagnostics: SqlSyntaxDiagnostic[]) {
  const groups = new Map<SqlSyntaxDiagnosticCode, SqlSyntaxDiagnostic[]>();
  for (const diag of diagnostics) {
    if ((diag.code === "fullwidth-semicolon" || diag.code === "fullwidth-comma" || diag.code === "fullwidth-lparen" || diag.code === "fullwidth-rparen") && diag.quickFix) {
      const list = groups.get(diag.code) ?? [];
      list.push(diag);
      groups.set(diag.code, list);
    }
  }
  for (const list of groups.values()) {
    if (list.length <= 1) continue;
    const changes = list.map((item) => ({
      from: item.quickFix!.from,
      to: item.quickFix!.to,
      insert: item.quickFix!.replacement,
    }));
    for (const item of list) {
      item.quickFix = {
        ...item.quickFix!,
        replaceAllChanges: changes,
        replaceAllCount: changes.length,
      };
    }
  }
}

function lintSqlRegion(sql: string, baseOffset: number, options: SqlSyntaxLintOptions, isRoutineBodyRegion: boolean, diagnostics: SqlSyntaxDiagnostic[]) {
  const tokens: LintToken[] = [];
  const openParens: Array<{ from: number; to: number }> = [];
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? "";
    const absPos = baseOffset + i;

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }

    // psql meta-commands at line start (e.g. \d, \c)
    if (ch === "\\" && isAtLineStart(sql, i)) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? len : nl + 1;
      continue;
    }

    // Line comments
    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i + 2);
      i = nl === -1 ? len : nl + 1;
      continue;
    }
    if (startsHashLineComment(sql, i, options.parameterOptions)) {
      const nl = sql.indexOf("\n", i + 1);
      i = nl === -1 ? len : nl + 1;
      continue;
    }

    // Unmatched closing block comment
    if (ch === "*" && next === "/") {
      diagnostics.push({
        code: "unmatched-block-comment-end",
        from: absPos,
        to: absPos + 2,
        severity: "error",
        token: "*/",
      });
      i += 2;
      continue;
    }

    // Nested block comments
    if (ch === "/" && next === "*") {
      const openFrom = absPos;
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) {
        diagnostics.push({
          code: "unclosed-block-comment",
          from: openFrom,
          to: openFrom + 2,
          severity: "error",
          token: "/*",
        });
        return;
      }
      continue;
    }

    // Braced template parameters (#{...}, ${...})
    if (ch === "#" || ch === "$") {
      const braced = readSqlBracedParameterAt(sql, i, options.parameterOptions);
      if (braced) {
        tokens.push({
          kind: "param",
          text: sql.slice(i, braced.end),
          upper: "",
          from: absPos,
          to: baseOffset + braced.end,
          parenDepth: openParens.length,
        });
        i = braced.end;
        continue;
      }
    }

    // Single-quoted string
    if (ch === "'") {
      const start = i;
      const explicitEscape = isEscapedSingleQuotePrefix(sql, i);
      i += 1;
      let closed = false;
      while (i < len) {
        const c = sql[i]!;
        const n = sql[i + 1] ?? "";
        if (c === "\\" && n) {
          if (explicitEscape) {
            i += 2;
            continue;
          }
          if (n === "'" && countRemainingUnescapedSingleQuotes(sql, i + 2, options.parameterOptions) % 2 === 1) {
            i += 2;
            continue;
          }
        }
        if (c === "'") {
          if (n === "'") {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        diagnostics.push({
          code: "unclosed-single-quote",
          from: absPos,
          to: absPos + 1,
          severity: "error",
          token: "'",
        });
        return;
      }
      tokens.push({
        kind: "string",
        text: sql.slice(start, i),
        upper: "",
        from: absPos,
        to: baseOffset + i,
        parenDepth: openParens.length,
      });
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      const start = i;
      i += 1;
      let closed = false;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        diagnostics.push({
          code: "unclosed-double-quote",
          from: absPos,
          to: absPos + 1,
          severity: "error",
          token: '"',
        });
        return;
      }
      tokens.push({
        kind: "quoted_ident",
        text: sql.slice(start, i),
        upper: "",
        from: absPos,
        to: baseOffset + i,
        parenDepth: openParens.length,
      });
      continue;
    }

    // Backtick-quoted identifier
    if (ch === "`") {
      const start = i;
      i += 1;
      let closed = false;
      while (i < len) {
        if (sql[i] === "`") {
          if (sql[i + 1] === "`") {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        diagnostics.push({
          code: "unclosed-backtick",
          from: absPos,
          to: absPos + 1,
          severity: "error",
          token: "`",
        });
        return;
      }
      tokens.push({
        kind: "quoted_ident",
        text: sql.slice(start, i),
        upper: "",
        from: absPos,
        to: baseOffset + i,
        parenDepth: openParens.length,
      });
      continue;
    }

    // Bracket-quoted identifier (e.g. M-mode / SQL Server style) or array subscript `[1]`
    if (ch === "[") {
      const prevTok = tokens[tokens.length - 1];
      const isSubscript = prevTok && (prevTok.kind === "word" || prevTok.kind === "quoted_ident" || prevTok.kind === "number" || prevTok.text === ")" || prevTok.text === "]");
      if (!isSubscript) {
        const start = i;
        i += 1;
        let closed = false;
        while (i < len) {
          if (sql[i] === "]") {
            if (sql[i + 1] === "]") {
              i += 2;
              continue;
            }
            i += 1;
            closed = true;
            break;
          }
          i += 1;
        }
        if (closed) {
          tokens.push({
            kind: "quoted_ident",
            text: sql.slice(start, i),
            upper: "",
            from: absPos,
            to: baseOffset + i,
            parenDepth: openParens.length,
          });
          continue;
        }
        i = start;
      }
    }

    // Dollar-quoted string ($tag$...$tag$) or positional parameter ($1)
    if (ch === "$") {
      const paramMatch = /^\$[0-9]+/.exec(sql.slice(i));
      if (paramMatch) {
        tokens.push({
          kind: "param",
          text: paramMatch[0],
          upper: "",
          from: absPos,
          to: absPos + paramMatch[0].length,
          parenDepth: openParens.length,
        });
        i += paramMatch[0].length;
        continue;
      }
      const dollarTag = matchDollarQuoteTag(sql, i);
      if (dollarTag) {
        const closeIdx = sql.indexOf(dollarTag, i + dollarTag.length);
        if (closeIdx === -1) {
          diagnostics.push({
            code: "unclosed-dollar-quote",
            from: absPos,
            to: absPos + dollarTag.length,
            severity: "error",
            token: dollarTag,
          });
          return;
        }
        const end = closeIdx + dollarTag.length;
        const shouldLintRoutineBody = !isRoutineBodyRegion && isRoutineDollarBodyContext(tokens);
        tokens.push({
          kind: "string",
          text: sql.slice(i, end),
          upper: "",
          from: absPos,
          to: baseOffset + end,
          parenDepth: openParens.length,
          dollarTag,
        });
        if (shouldLintRoutineBody) {
          const innerStart = i + dollarTag.length;
          const innerSql = sql.slice(innerStart, closeIdx);
          lintSqlRegion(innerSql, baseOffset + innerStart, options, true, diagnostics);
        }
        i = end;
        continue;
      }
    }

    // Fullwidth punctuation checks
    if (ch === "；") {
      diagnostics.push({
        code: "fullwidth-semicolon",
        from: absPos,
        to: absPos + 1,
        severity: "error",
        token: "；",
        suggestion: ";",
        quickFix: { from: absPos, to: absPos + 1, replacement: ";" },
      });
      tokens.push({
        kind: "punct",
        text: "；",
        upper: "；",
        from: absPos,
        to: absPos + 1,
        parenDepth: openParens.length,
      });
      i += 1;
      continue;
    }

    if (ch === "，") {
      diagnostics.push({
        code: "fullwidth-comma",
        from: absPos,
        to: absPos + 1,
        severity: "error",
        token: "，",
        suggestion: ",",
        quickFix: { from: absPos, to: absPos + 1, replacement: "," },
      });
      tokens.push({
        kind: "punct",
        text: ",",
        upper: ",",
        from: absPos,
        to: absPos + 1,
        parenDepth: openParens.length,
      });
      i += 1;
      continue;
    }

    if (ch === "（") {
      diagnostics.push({
        code: "fullwidth-lparen",
        from: absPos,
        to: absPos + 1,
        severity: "error",
        token: "（",
        suggestion: "(",
        quickFix: { from: absPos, to: absPos + 1, replacement: "(" },
      });
      const depth = openParens.length;
      openParens.push({ from: absPos, to: absPos + 1 });
      tokens.push({
        kind: "punct",
        text: "(",
        upper: "(",
        from: absPos,
        to: absPos + 1,
        parenDepth: depth,
      });
      i += 1;
      continue;
    }

    if (ch === "）") {
      diagnostics.push({
        code: "fullwidth-rparen",
        from: absPos,
        to: absPos + 1,
        severity: "error",
        token: "）",
        suggestion: ")",
        quickFix: { from: absPos, to: absPos + 1, replacement: ")" },
      });
      if (openParens.length > 0) {
        openParens.pop();
      }
      tokens.push({
        kind: "punct",
        text: ")",
        upper: ")",
        from: absPos,
        to: absPos + 1,
        parenDepth: openParens.length,
      });
      i += 1;
      continue;
    }

    // ASCII parentheses
    if (ch === "(") {
      const depth = openParens.length;
      openParens.push({ from: absPos, to: absPos + 1 });
      tokens.push({
        kind: "punct",
        text: "(",
        upper: "(",
        from: absPos,
        to: absPos + 1,
        parenDepth: depth,
      });
      i += 1;
      continue;
    }

    if (ch === ")") {
      if (openParens.length === 0) {
        diagnostics.push({
          code: "unmatched-rparen",
          from: absPos,
          to: absPos + 1,
          severity: "error",
          token: ")",
        });
      } else {
        openParens.pop();
      }
      tokens.push({
        kind: "punct",
        text: ")",
        upper: ")",
        from: absPos,
        to: absPos + 1,
        parenDepth: openParens.length,
      });
      i += 1;
      continue;
    }

    // Named / question parameters (:param, ?) vs `:=` and `::`
    if (ch === ":" && next === "=") {
      tokens.push({ kind: "op", text: ":=", upper: ":=", from: absPos, to: absPos + 2, parenDepth: openParens.length });
      i += 2;
      continue;
    }
    if (ch === ":" && next === ":") {
      tokens.push({ kind: "op", text: "::", upper: "::", from: absPos, to: absPos + 2, parenDepth: openParens.length });
      i += 2;
      continue;
    }
    if (ch === ":" && WORD_START_RE.test(next)) {
      const start = i;
      i += 2;
      while (i < len && WORD_CONTINUE_RE.test(sql[i] ?? "")) i += 1;
      tokens.push({
        kind: "param",
        text: sql.slice(start, i),
        upper: "",
        from: absPos,
        to: baseOffset + i,
        parenDepth: openParens.length,
      });
      continue;
    }
    if (ch === "?") {
      tokens.push({ kind: "param", text: "?", upper: "?", from: absPos, to: absPos + 1, parenDepth: openParens.length });
      i += 1;
      continue;
    }

    // Numeric literal
    if (ch >= "0" && ch <= "9") {
      const start = i;
      i += 1;
      while (i < len && /[0-9a-fA-FxX._]/.test(sql[i] ?? "")) i += 1;
      tokens.push({
        kind: "number",
        text: sql.slice(start, i),
        upper: "",
        from: absPos,
        to: baseOffset + i,
        parenDepth: openParens.length,
      });
      continue;
    }

    // Word / identifier / keyword (supports Unicode identifiers)
    if (WORD_START_RE.test(ch)) {
      const start = i;
      i += 1;
      while (i < len && WORD_CONTINUE_RE.test(sql[i] ?? "")) i += 1;
      const text = sql.slice(start, i);
      // Treat E'...' string prefix as attached to the upcoming literal
      if ((text === "E" || text === "e" || text === "N" || text === "n" || text === "B" || text === "b" || text === "X" || text === "x") && sql[i] === "'") {
        continue;
      }
      tokens.push({
        kind: "word",
        text,
        upper: text.toUpperCase(),
        from: absPos,
        to: baseOffset + i,
        parenDepth: openParens.length,
      });
      continue;
    }

    // Oracle/openGauss `/` standalone block terminator line
    if (ch === "/" && isAtLineStart(sql, i) && isStandaloneSlashLine(sql, i)) {
      const lineEnd = findLineEnd(sql, i);
      tokens.push({
        kind: "punct",
        text: ";",
        upper: ";",
        from: absPos,
        to: absPos + 1,
        parenDepth: openParens.length,
      });
      i = lineEnd;
      continue;
    }

    // Punctuation
    if (ch === "," || ch === "." || ch === ";" || ch === "*") {
      tokens.push({
        kind: "punct",
        text: ch,
        upper: ch,
        from: absPos,
        to: absPos + 1,
        parenDepth: openParens.length,
      });
      i += 1;
      continue;
    }

    // Multi-char operators
    const twoChar = ch + next;
    if (twoChar === "<=" || twoChar === ">=" || twoChar === "<>" || twoChar === "!=" || twoChar === "||" || twoChar === "<<" || twoChar === ">>" || twoChar === "->" || twoChar === "@>" || twoChar === "<@") {
      tokens.push({
        kind: "op",
        text: twoChar,
        upper: twoChar,
        from: absPos,
        to: absPos + 2,
        parenDepth: openParens.length,
      });
      i += 2;
      continue;
    }

    tokens.push({
      kind: "op",
      text: ch,
      upper: ch,
      from: absPos,
      to: absPos + 1,
      parenDepth: openParens.length,
    });
    i += 1;
  }

  for (const unclosed of openParens) {
    diagnostics.push({
      code: "unclosed-lparen",
      from: unclosed.from,
      to: unclosed.to,
      severity: "error",
      token: "(",
    });
  }

  lintTokensConservatively(tokens, options, isRoutineBodyRegion, diagnostics);
}

function isRoutineDollarBodyContext(tokens: readonly LintToken[]): boolean {
  let start = tokens.length - 1;
  while (start >= 0 && !(tokens[start]!.parenDepth === 0 && isSemicolonToken(tokens[start]!))) {
    start -= 1;
  }
  const stmtTokens = tokens.slice(start + 1);
  if (stmtTokens.length === 0) return false;
  const first = stmtTokens[0]?.upper;
  if (first === "DO") return true;
  if (first === "CREATE") {
    return stmtTokens.some((tok) => tok.parenDepth === 0 && (tok.upper === "FUNCTION" || tok.upper === "PROCEDURE" || tok.upper === "TRIGGER"));
  }
  return false;
}

function isSemicolonToken(tok: LintToken | undefined): boolean {
  return !!tok && tok.kind === "punct" && (tok.text === ";" || tok.text === "；");
}

function isAtLineStart(sql: string, pos: number): boolean {
  for (let idx = pos - 1; idx >= 0; idx -= 1) {
    const ch = sql[idx];
    if (ch === "\n" || ch === "\r") return true;
    if (ch !== " " && ch !== "\t") return false;
  }
  return true;
}

function findLineEnd(sql: string, pos: number): number {
  const nl = sql.indexOf("\n", pos);
  return nl === -1 ? sql.length : nl;
}

function isStandaloneSlashLine(sql: string, pos: number): boolean {
  const lineEnd = findLineEnd(sql, pos);
  return sql.slice(pos, lineEnd).trim() === "/";
}

function applyCaseStyle(original: string, keyword: string): string {
  if (original === original.toLowerCase()) return keyword.toLowerCase();
  return keyword.toUpperCase();
}

/**
 * Optimal String Alignment (restricted Damerau-Levenshtein) distance:
 * counts single-char insertion, deletion, substitution, and adjacent transposition as 1.
 */
function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (a === b) return 0;
  if (Math.abs(m - n) > 2) return 3;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0));
  for (let i = 0; i <= m; i += 1) dp[i]![0] = i;
  for (let j = 0; j <= n; j += 1) dp[0]![j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, dp[i - 2]![j - 2]! + 1);
      }
      dp[i]![j] = best;
    }
  }
  return dp[m]![n]!;
}

function matchKeywordTypo(wordUpper: string, candidates: readonly string[], options?: { minWordLength?: number }): string | null {
  if (ALL_KNOWN_SQL_WORDS.has(wordUpper)) return null;
  const len = wordUpper.length;
  const minLen = options?.minWordLength ?? 3;
  if (len < minLen) return null;

  let bestCandidate: string | null = null;
  let bestScore = Infinity;

  for (const candidate of candidates) {
    const cLen = candidate.length;
    if (cLen < 3) continue;
    const lenDiff = Math.abs(len - cLen);
    if (lenDiff > 2) continue;

    const dist = damerauLevenshtein(wordUpper, candidate);
    if (dist === 0) return null;

    if (len <= 5 || cLen <= 5) {
      if (dist > 1) continue;
      // For 3-char tokens (e.g. FOM -> FROM, STE -> SET, NUL -> NULL, KYE -> KEY),
      // require sharing at least the first character or being an adjacent transposition.
      if (len === 3 && wordUpper[0] !== candidate[0] && !(cLen === 3 && wordUpper[0] === candidate[1] && wordUpper[1] === candidate[0])) {
        continue;
      }
    } else {
      if (dist > 2) continue;
      if (dist === 2) {
        const sameStart = wordUpper[0] === candidate[0];
        const transposedStart = wordUpper[0] === candidate[1] && wordUpper[1] === candidate[0];
        if (!sameStart && !transposedStart) continue;
      }
    }

    // Prefer smaller distance, then matching first+last char, then closer length.
    const sameFirst = wordUpper[0] === candidate[0] ? 0 : 0.2;
    const sameLast = wordUpper[len - 1] === candidate[cLen - 1] ? 0 : 0.15;
    const score = dist + sameFirst + sameLast + lenDiff * 0.05;
    if (score < bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function isCandidateWordForTypo(tokens: readonly LintToken[], index: number, allowBeforeLParen = false): boolean {
  const tok = tokens[index];
  if (!tok || tok.kind !== "word") return false;
  if (!ASCII_ALPHA_WORD_RE.test(tok.text)) return false;
  if (ALL_KNOWN_SQL_WORDS.has(tok.upper)) return false;

  const prev = tokens[index - 1];
  const next = tokens[index + 1];
  // Never check qualified parts (`schema.name`, `alias.col`, `::type`)
  if (prev?.text === "." || prev?.text === "::" || next?.text === ".") return false;
  // Never check function calls `foo(...)` unless the slot itself expects a keyword before `(` (e.g. VALUES (...))
  if (!allowBeforeLParen && next?.text === "(") return false;
  return true;
}

function shouldSuppressActivePrefix(tok: LintToken, candidates: readonly string[], activeCursorPos: number | null | undefined): boolean {
  if (activeCursorPos == null) return false;
  if (activeCursorPos < tok.from || activeCursorPos > tok.to) return false;
  return candidates.some((candidate) => candidate.startsWith(tok.upper));
}

function lintTokensConservatively(tokens: readonly LintToken[], options: SqlSyntaxLintOptions, isRoutineBodyRegion: boolean, diagnostics: SqlSyntaxDiagnostic[]) {
  if (tokens.length === 0) return;

  const reportedPositions = new Set<number>();
  const qualifierReferences = collectQualifierReferences(tokens);

  const reportTypo = (tok: LintToken, suggestionUpper: string, candidatesForPrefixCheck: readonly string[]) => {
    if (reportedPositions.has(tok.from)) return;
    if (shouldSuppressActivePrefix(tok, candidatesForPrefixCheck, options.activeCursorPos)) return;
    reportedPositions.add(tok.from);
    const replacement = applyCaseStyle(tok.text, suggestionUpper);
    diagnostics.push({
      code: "keyword-typo",
      from: tok.from,
      to: tok.to,
      severity: "error",
      token: tok.text,
      suggestion: replacement,
      quickFix: {
        from: tok.from,
        to: tok.to,
        replacement,
      },
    });
  };

  // 1. Multi-word keyword pair checks across the token stream
  lintAdjacentKeywordPairs(tokens, qualifierReferences, reportTypo);

  // 2. Subquery start checks inside (...) and CREATE TABLE (...) column constraint checks
  lintParenthesizedConstructs(tokens, reportTypo);

  // 3. Statement-by-statement & PL/SQL section checks at parenDepth === 0
  let plsqlSection: "none" | "declare" | "body" | "package_spec" = isRoutineBodyRegion ? "declare" : "none";
  let plsqlBlockDepth = 0;
  let inPackageBody = false;
  // If a `$$` routine body begins directly with `BEGIN` (no `DECLARE`), the loop handles `BEGIN` immediately.
  if (isRoutineBodyRegion && tokens[0]?.upper !== "DECLARE" && tokens[0]?.upper !== "BEGIN") {
    plsqlSection = "body";
    plsqlBlockDepth = 1;
  }

  let i = 0;
  while (i < tokens.length) {
    // Skip leading semicolons or PL/SQL `<<label>>`
    if (isSemicolonToken(tokens[i])) {
      i += 1;
      continue;
    }
    if (tokens[i]?.text === "<<" && tokens[i + 1]?.kind === "word" && tokens[i + 2]?.text === ">>") {
      i += 3;
      continue;
    }

    // Find end of current top-level (or PL/SQL sub-level) statement
    let stmtEnd = i;
    while (stmtEnd < tokens.length && !(tokens[stmtEnd]!.parenDepth === 0 && isSemicolonToken(tokens[stmtEnd]!))) {
      stmtEnd += 1;
    }

    const slice = tokens.slice(i, stmtEnd);
    if (slice.length > 0) {
      const nextState = lintSingleStatementSlice(slice, tokens, i, plsqlSection, plsqlBlockDepth, inPackageBody, reportTypo);
      plsqlSection = nextState.plsqlSection;
      plsqlBlockDepth = nextState.plsqlBlockDepth;
      inPackageBody = nextState.inPackageBody;
    }

    i = stmtEnd + 1;
  }
}

function collectQualifierReferences(tokens: readonly LintToken[]): Set<string> {
  const refs = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.kind === "word" && tokens[i + 1]!.text === ".") {
      refs.add(tokens[i]!.upper);
    }
  }
  return refs;
}

function lintAdjacentKeywordPairs(tokens: readonly LintToken[], qualifierReferences: Set<string>, reportTypo: (tok: LintToken, suggestion: string, candidates: readonly string[]) => void) {
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];

    // `<typo> BY` -> ORDER BY / GROUP BY / PARTITION BY / CONNECT BY / INCREMENT BY / IDENTIFIED BY
    if (next?.kind === "word" && next.upper === "BY" && isCandidateWordForTypo(tokens, i)) {
      const match = matchKeywordTypo(tok.upper, BY_PRECEDING_KEYWORDS);
      if (match) {
        reportTypo(tok, match, BY_PRECEDING_KEYWORDS);
        continue;
      }
    }

    // `ORDER YB` / `GROUP YB` / `PARTITION YB`
    if (tok.kind === "word" && tok.upper === "YB" && prev?.kind === "word" && (prev.upper === "ORDER" || prev.upper === "GROUP" || prev.upper === "PARTITION") && tokens[i - 2]?.upper !== "CREATE" && tokens[i - 2]?.upper !== "ALTER" && tokens[i - 2]?.upper !== "DROP") {
      reportTypo(tok, "BY", ["BY"]);
      continue;
    }

    // `<PRIMRAY | FOREGIN> KEY` and `PRIMARY | FOREIGN <KYE>`
    if (next?.kind === "word" && next.upper === "KEY" && isCandidateWordForTypo(tokens, i)) {
      const match = matchKeywordTypo(tok.upper, ["PRIMARY", "FOREIGN"]);
      if (match) {
        reportTypo(tok, match, ["PRIMARY", "FOREIGN"]);
        continue;
      }
    }
    if (prev?.kind === "word" && (prev.upper === "PRIMARY" || prev.upper === "FOREIGN") && isCandidateWordForTypo(tokens, i)) {
      const match = matchKeywordTypo(tok.upper, ["KEY"]);
      if (match) {
        reportTypo(tok, match, ["KEY"]);
        continue;
      }
    }

    // `LEFT | RIGHT | INNER | OUTER | FULL | CROSS | NATURAL <JION> <table_ref>`
    if (prev?.kind === "word" && (JOIN_MODIFIER_KEYWORDS as readonly string[]).includes(prev.upper) && isCandidateWordForTypo(tokens, i) && next && (next.kind === "word" || next.kind === "quoted_ident" || next.text === "(")) {
      const match = matchKeywordTypo(tok.upper, ["JOIN"]);
      if (match) {
        reportTypo(tok, match, ["JOIN"]);
        continue;
      }
    }

    // `<LFET | RIHGT | INENR | OUTRE | FURLL | CRSOS> [OUTER] JOIN`
    if (isCandidateWordForTypo(tokens, i) && next?.kind === "word" && (next.upper === "JOIN" || (next.upper === "OUTER" && tokens[i + 2]?.upper === "JOIN")) && !qualifierReferences.has(tok.upper)) {
      const match = matchKeywordTypo(tok.upper, JOIN_MODIFIER_KEYWORDS);
      if (match) {
        reportTypo(tok, match, JOIN_MODIFIER_KEYWORDS);
        continue;
      }
    }

    // `IS [NOT] <NUL | TREU | FASLE | DISTNCT>`
    if (isCandidateWordForTypo(tokens, i)) {
      const afterIs = (prev?.kind === "word" && prev.upper === "IS") || (prev?.kind === "word" && prev.upper === "NOT" && tokens[i - 2]?.kind === "word" && tokens[i - 2]?.upper === "IS");
      if (afterIs) {
        const isTargets = ["NULL", "TRUE", "FALSE", "DISTINCT", "UNKNOWN"] as const;
        const match = matchKeywordTypo(tok.upper, isTargets);
        if (match) {
          reportTypo(tok, match, isTargets);
          continue;
        }
      }
    }

    // `NOT <NUL | EXSITS | BETWEN | LKIE | ILKIE>`
    if (prev?.kind === "word" && prev.upper === "NOT" && isCandidateWordForTypo(tokens, i, true)) {
      const notTargets = next?.text === "(" ? (["EXISTS", "IN"] as const) : (["NULL", "BETWEEN", "LIKE", "ILIKE", "SIMILAR", "MATCHED"] as const);
      const match = matchKeywordTypo(tok.upper, notTargets);
      if (match) {
        reportTypo(tok, match, notTargets);
        continue;
      }
    }

    // `UNION | INTERSECT | EXCEPT | MINUS <DISTNCT> SELECT | (`
    if (prev?.kind === "word" && (prev.upper === "UNION" || prev.upper === "INTERSECT" || prev.upper === "EXCEPT" || prev.upper === "MINUS") && isCandidateWordForTypo(tokens, i) && (next?.upper === "SELECT" || next?.text === "(")) {
      const setModTargets = ["ALL", "DISTINCT"] as const;
      const match = matchKeywordTypo(tok.upper, setModTargets);
      if (match) {
        reportTypo(tok, match, setModTargets);
        continue;
      }
    }

    // `WITH <RECURSVIE> <cte_name> AS (`
    if (prev?.kind === "word" && prev.upper === "WITH" && isCandidateWordForTypo(tokens, i) && next && (next.kind === "word" || next.kind === "quoted_ident")) {
      const match = matchKeywordTypo(tok.upper, ["RECURSIVE"]);
      if (match) {
        reportTypo(tok, match, ["RECURSIVE"]);
        continue;
      }
    }

    // `EXCEPTOIN WHEN`
    if (next?.kind === "word" && next.upper === "WHEN" && isCandidateWordForTypo(tokens, i)) {
      const match = matchKeywordTypo(tok.upper, ["EXCEPTION", "CASE"]);
      if (match) {
        reportTypo(tok, match, ["EXCEPTION", "CASE"]);
        continue;
      }
    }
  }
}

function lintParenthesizedConstructs(tokens: readonly LintToken[], reportTypo: (tok: LintToken, suggestion: string, candidates: readonly string[]) => void) {
  for (let i = 0; i < tokens.length; i += 1) {
    const open = tokens[i]!;
    if (open.text !== "(") continue;

    const prev = tokens[i - 1];
    const firstInner = tokens[i + 1];
    if (!firstInner) continue;

    // 1) Subquery `( SELCET ... )`
    const isSubqueryContext = !prev || prev.text === "(" || prev.text === "," || (prev.kind === "word" && SUBQUERY_TRIGGER_WORDS.has(prev.upper)) || (prev.kind === "op" && SUBQUERY_TRIGGER_OPS.has(prev.text));
    if (isSubqueryContext && isCandidateWordForTypo(tokens, i + 1)) {
      const afterFirst = tokens[i + 2];
      // Require subquery-like continuation (`*`, literal, `(`, or `<ident> <FROM|,|AS>`) so `(col INT)` in CREATE TABLE is never touched.
      const looksLikeSubquery =
        afterFirst?.text === "*" ||
        afterFirst?.kind === "number" ||
        afterFirst?.kind === "string" ||
        (afterFirst && (afterFirst.kind === "word" || afterFirst.kind === "quoted_ident") && (tokens[i + 3]?.upper === "FROM" || tokens[i + 3]?.text === "," || tokens[i + 3]?.upper === "AS" || matchKeywordTypo(tokens[i + 3]?.upper ?? "", ["FROM"]) === "FROM"));
      if (looksLikeSubquery) {
        const subTargets = ["SELECT", "WITH", "VALUES"] as const;
        const match = matchKeywordTypo(firstInner.upper, subTargets);
        if (match) {
          reportTypo(firstInner, match, subTargets);
        }
      }
    }

    // 2) `CREATE [TEMP] TABLE [IF NOT EXISTS] <qualified_name> ( ... )` column constraint keywords
    if (isCreateTableColumnListParen(tokens, i)) {
      const closeIndex = findMatchingCloseParenTokenIndex(tokens, i);
      if (closeIndex > i + 1) {
        lintCreateTableColumns(tokens, i + 1, closeIndex, reportTypo);
      }
    }

    // 3) Subquery clauses inside `( SELECT ... )`
    if (firstInner.kind === "word" && (firstInner.upper === "SELECT" || matchKeywordTypo(firstInner.upper, ["SELECT"]) === "SELECT")) {
      const closeIndex = findMatchingCloseParenTokenIndex(tokens, i);
      if (closeIndex > i + 1) {
        const innerSlice = tokens.slice(i + 1, closeIndex);
        lintSelectOrDmlBodyClauses("SELECT", innerSlice, tokens, i + 1, reportTypo);
      }
    }
  }
}

function findMatchingCloseParenTokenIndex(tokens: readonly LintToken[], openIndex: number): number {
  const targetDepth = tokens[openIndex]!.parenDepth;
  for (let idx = openIndex + 1; idx < tokens.length; idx += 1) {
    if (tokens[idx]!.text === ")" && tokens[idx]!.parenDepth === targetDepth) {
      return idx;
    }
  }
  return tokens.length;
}

function isCreateTableColumnListParen(tokens: readonly LintToken[], openParenIndex: number): boolean {
  const depth = tokens[openParenIndex]!.parenDepth;
  if (depth !== 0) return false;
  // Walk back over `<qualified_table_name>` to see if preceded by `TABLE` (and `CREATE`)
  let idx = openParenIndex - 1;
  if (idx < 1) return false;
  if (tokens[idx]!.kind !== "word" && tokens[idx]!.kind !== "quoted_ident") return false;
  idx -= 1;
  while (idx >= 1 && tokens[idx]!.text === "." && (tokens[idx - 1]!.kind === "word" || tokens[idx - 1]!.kind === "quoted_ident")) {
    idx -= 2;
  }
  // Skip optional `EXISTS` / `NOT` / `IF` (even when `EXISTS` or `TABLE` has a typo)
  const maybeExists = tokens[idx]?.upper ?? "";
  if (maybeExists === "EXISTS" || matchKeywordTypo(maybeExists, ["EXISTS"]) === "EXISTS") {
    idx -= 1;
    if (tokens[idx]?.upper === "NOT") idx -= 1;
    if (tokens[idx]?.upper === "IF") idx -= 1;
  }
  const maybeTable = tokens[idx]?.upper ?? "";
  if (maybeTable !== "TABLE" && matchKeywordTypo(maybeTable, ["TABLE"]) !== "TABLE") return false;
  for (let k = idx - 1; k >= 0; k -= 1) {
    if (tokens[k]!.parenDepth === 0 && isSemicolonToken(tokens[k])) break;
    const kw = tokens[k]!.upper;
    if (kw === "CREATE" || matchKeywordTypo(kw, ["CREATE"]) === "CREATE") return true;
  }
  return false;
}

function lintCreateTableColumns(tokens: readonly LintToken[], fromIndex: number, toIndex: number, reportTypo: (tok: LintToken, suggestion: string, candidates: readonly string[]) => void) {
  const itemDepth = tokens[fromIndex]?.parenDepth ?? 1;
  let itemStart = fromIndex;

  while (itemStart < toIndex) {
    let itemEnd = itemStart;
    while (itemEnd < toIndex && !(tokens[itemEnd]!.parenDepth === itemDepth && tokens[itemEnd]!.text === ",")) {
      itemEnd += 1;
    }

    lintSingleCreateTableItem(tokens, itemStart, itemEnd, itemDepth, reportTypo);
    itemStart = itemEnd + 1;
  }
}

function lintSingleCreateTableItem(tokens: readonly LintToken[], start: number, end: number, itemDepth: number, reportTypo: (tok: LintToken, suggestion: string, candidates: readonly string[]) => void) {
  if (start >= end) return;
  const first = tokens[start]!;

  // Table-level constraint starter: `CONSTRIANT pk_t PRIMARY KEY (...)`
  if (isCandidateWordForTypo(tokens, start)) {
    const second = tokens[start + 1];
    const third = tokens[start + 2];
    if (
      second &&
      (second.kind === "word" || second.kind === "quoted_ident") &&
      third?.kind === "word" &&
      (third.upper === "PRIMARY" || third.upper === "FOREIGN" || third.upper === "UNIQUE" || third.upper === "CHECK" || matchKeywordTypo(third.upper, ["PRIMARY", "FOREIGN", "UNIQUE", "CHECK"]) !== null)
    ) {
      const match = matchKeywordTypo(first.upper, ["CONSTRAINT"]);
      if (match) reportTypo(first, match, ["CONSTRAINT"]);
      return;
    }
  }
  if (first.kind === "word" && (first.upper === "CONSTRAINT" || first.upper === "PRIMARY" || first.upper === "FOREIGN" || first.upper === "UNIQUE" || first.upper === "CHECK" || first.upper === "LIKE" || first.upper === "INCLUDING" || first.upper === "EXCLUDING")) {
    return;
  }

  // Ordinary column definition: `<col_name> <data_type [(...)]> [constraints...]`
  // Skip token 0 (column name) and the data type (which may be a multi-word or schema-qualified custom type).
  let cursor = start + 1;
  if (cursor >= end) return;

  // Skip optional `schema.` on custom data type
  while (cursor + 1 < end && tokens[cursor + 1]!.text === ".") {
    cursor += 2;
  }
  // Skip data type name(s) (e.g. `DOUBLE PRECISION`, `CHARACTER VARYING`, `TIMESTAMP WITH TIME ZONE`)
  cursor += 1;
  while (
    cursor < end &&
    tokens[cursor]!.parenDepth === itemDepth &&
    tokens[cursor]!.kind === "word" &&
    (tokens[cursor]!.upper === "PRECISION" ||
      tokens[cursor]!.upper === "VARYING" ||
      tokens[cursor]!.upper === "WITH" ||
      tokens[cursor]!.upper === "WITHOUT" ||
      tokens[cursor]!.upper === "TIME" ||
      tokens[cursor]!.upper === "ZONE" ||
      tokens[cursor]!.upper === "UNSIGNED" ||
      tokens[cursor]!.upper === "ZEROFILL")
  ) {
    cursor += 1;
  }
  // Skip `(length, scale)` or `[]` array bounds after data type
  while (cursor < end && (tokens[cursor]!.parenDepth > itemDepth || tokens[cursor]!.text === ")" || tokens[cursor]!.text === "[" || tokens[cursor]!.text === "]")) {
    cursor += 1;
  }

  // Remaining top-level words in the column definition are column constraints (`DEFAULT`, `NOT NULL`, `UNIQUE`, `REFERENCES`, etc.)
  for (let idx = cursor; idx < end; idx += 1) {
    const tok = tokens[idx]!;
    if (tok.parenDepth !== itemDepth) continue;
    // Skip expression right after `DEFAULT` or `COLLATE` or `CONSTRAINT` or `REFERENCES`
    const prev = tokens[idx - 1];
    if (prev?.kind === "word" && (prev.upper === "DEFAULT" || prev.upper === "COLLATE" || prev.upper === "CONSTRAINT" || prev.upper === "REFERENCES" || matchKeywordTypo(prev.upper, ["DEFAULT", "COLLATE", "CONSTRAINT", "REFERENCES"]) !== null)) {
      continue;
    }
    if (!isCandidateWordForTypo(tokens, idx, true)) continue;
    const match = matchKeywordTypo(tok.upper, TABLE_COLUMN_CONSTRAINT_KEYWORDS);
    if (match) {
      reportTypo(tok, match, TABLE_COLUMN_CONSTRAINT_KEYWORDS);
    }
  }
}

function lintSingleStatementSlice(
  slice: readonly LintToken[],
  allTokens: readonly LintToken[],
  sliceOffset: number,
  plsqlSection: "none" | "declare" | "body" | "package_spec",
  plsqlBlockDepth: number,
  inPackageBody: boolean,
  reportTypo: (tok: LintToken, suggestion: string, candidates: readonly string[]) => void,
): { plsqlSection: "none" | "declare" | "body" | "package_spec"; plsqlBlockDepth: number; inPackageBody: boolean } {
  let pos = 0;
  let section = plsqlSection;
  let blockDepth = plsqlBlockDepth;
  let pkgBody = inPackageBody;

  // Unwrap control-flow prefixes inside PL/SQL body (`BEGIN ...`, `THEN ...`, `ELSE ...`, `LOOP ...`)
  while (pos < slice.length) {
    const cur = slice[pos]!;
    if (cur.parenDepth !== 0) break;

    if (cur.upper === "DECLARE") {
      section = "declare";
      pos += 1;
      if (pos >= slice.length) return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
      break;
    }

    if (cur.upper === "INSTANTIATION" && pkgBody) {
      pos += 1;
      continue;
    }

    if (cur.upper === "BEGIN" && slice[pos + 1]?.upper !== "TRANSACTION" && slice[pos + 1]?.upper !== "WORK") {
      // Could be top-level `BEGIN;` transaction if alone at end of statement
      if (section === "none" && pos === 0 && slice.length === 1) {
        return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
      }
      section = "body";
      blockDepth += 1;
      pos += 1;
      continue;
    }

    if (section === "body") {
      if (cur.upper === "ELSE" || cur.upper === "LOOP") {
        if (cur.upper === "LOOP") blockDepth += 1;
        pos += 1;
        continue;
      }
      if (cur.upper === "IF" || cur.upper === "ELSIF" || cur.upper === "ELSEIF" || matchKeywordTypo(cur.upper, ["ELSIF"]) === "ELSIF") {
        if (isCandidateWordForTypo(allTokens, sliceOffset + pos)) {
          reportTypo(cur, "ELSIF", ["ELSIF"]);
        }
        if (cur.upper === "IF") blockDepth += 1;
        // Scan condition up to `THEN` (or typo `TEHN`)
        let condIdx = pos + 1;
        let foundThen = false;
        while (condIdx < slice.length) {
          const condTok = slice[condIdx]!;
          if (condTok.parenDepth === 0 && condTok.kind === "word") {
            if (condTok.upper === "THEN") {
              pos = condIdx + 1;
              foundThen = true;
              break;
            }
            if (isCandidateWordForTypo(allTokens, sliceOffset + condIdx) && matchKeywordTypo(condTok.upper, ["THEN"]) === "THEN" && condIdx > pos + 1) {
              reportTypo(condTok, "THEN", ["THEN"]);
              pos = condIdx + 1;
              foundThen = true;
              break;
            }
          }
          condIdx += 1;
        }
        if (foundThen) continue;
        return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
      }

      if (cur.upper === "EXCEPTION") {
        pos += 1;
        continue;
      }
      if (cur.upper === "WHEN") {
        let whenIdx = pos + 1;
        let foundThen = false;
        while (whenIdx < slice.length) {
          const wTok = slice[whenIdx]!;
          if (wTok.parenDepth === 0 && wTok.kind === "word") {
            if (wTok.upper === "THEN") {
              pos = whenIdx + 1;
              foundThen = true;
              break;
            }
            if (isCandidateWordForTypo(allTokens, sliceOffset + whenIdx) && matchKeywordTypo(wTok.upper, ["THEN"]) === "THEN" && whenIdx > pos + 1) {
              reportTypo(wTok, "THEN", ["THEN"]);
              pos = whenIdx + 1;
              foundThen = true;
              break;
            }
          }
          whenIdx += 1;
        }
        if (foundThen) continue;
        return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
      }

      if (cur.upper === "END") {
        blockDepth = Math.max(0, blockDepth - 1);
        if (blockDepth === 0) {
          section = pkgBody ? "declare" : "none";
        }
        return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
      }
    }

    if ((section === "package_spec" || (section === "declare" && pkgBody)) && cur.upper === "END") {
      section = "none";
      pkgBody = false;
      return { plsqlSection: section, plsqlBlockDepth: 0, inPackageBody: false };
    }

    break;
  }

  if (pos >= slice.length) {
    return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
  }

  // Inside `DECLARE` or `PACKAGE` specification, declarations begin with variable/type/cursor/procedure names.
  if (section === "declare" || section === "package_spec") {
    const firstUpper = slice[pos]!.upper;
    if (firstUpper === "PROCEDURE" || firstUpper === "FUNCTION") {
      const asPos = slice.findIndex((tok, idx) => idx > pos && tok.parenDepth === 0 && (tok.upper === "IS" || tok.upper === "AS"));
      if (asPos >= 0) {
        const afterAs = slice[asPos + 1];
        const secondAfterAs = slice[asPos + 2];
        const looksLikeVariableDecl = secondAfterAs?.kind === "word" && ALL_KNOWN_SQL_WORDS.has(secondAfterAs.upper) && secondAfterAs.upper !== "SELECT" && secondAfterAs.upper !== "INSERT" && secondAfterAs.upper !== "UPDATE" && secondAfterAs.upper !== "DELETE";
        if (afterAs && !looksLikeVariableDecl && isCandidateWordForTypo(allTokens, sliceOffset + asPos + 1)) {
          const match = matchKeywordTypo(afterAs.upper, ["BEGIN", "DECLARE"]);
          if (match) reportTypo(afterAs, match, ["BEGIN", "DECLARE"]);
        }
        const beginPos = slice.findIndex((tok, idx) => idx > asPos && tok.parenDepth === 0 && tok.upper === "BEGIN");
        if (beginPos >= 0) {
          return lintSingleStatementSlice(slice.slice(beginPos), allTokens, sliceOffset + beginPos, "declare", blockDepth, pkgBody, reportTypo);
        }
      }
    }
    return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
  }

  const stmtTokens = slice.slice(pos);
  const stmtGlobalStart = sliceOffset + pos;
  const first = stmtTokens[0]!;

  if (section === "body") {
    // In PL/SQL body, skip assignments (`x := 1`, `rec.x := 1`) and procedure calls (`pkg.proc(...)`, `proc_no_args;`)
    let qualEnd = 0;
    while (qualEnd + 2 < stmtTokens.length && stmtTokens[qualEnd + 1]?.text === ".") {
      qualEnd += 2;
    }
    const afterIdent = stmtTokens[qualEnd + 1];
    // Handle ` array(i) := 1` as well
    const afterParens = afterIdent?.text === "(" ? stmtTokens[findMatchingCloseParenTokenIndex(stmtTokens, qualEnd + 1) + 1] : afterIdent;
    if (!afterIdent) {
      // Bare single word `retunr;` — only flag >= 6-char unambiguous control typos
      if (first.text.length >= 6 && isCandidateWordForTypo(allTokens, stmtGlobalStart)) {
        const barePlsqlTargets = ["RETURN", "COMMIT", "ROLLBACK", "CONTINUE"] as const;
        const match = matchKeywordTypo(first.upper, barePlsqlTargets, { minWordLength: 6 });
        if (match) reportTypo(first, match, barePlsqlTargets);
      }
      return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
    }
    if (afterIdent.text === ":=" || afterIdent.text === "=" || afterIdent.text === "(" || afterParens?.text === ":=") {
      return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
    }

    let resolvedLead = first.upper;
    if (isCandidateWordForTypo(allTokens, stmtGlobalStart)) {
      const match = matchKeywordTypo(first.upper, PLSQL_STATEMENT_START_KEYWORDS);
      if (match) {
        reportTypo(first, match, PLSQL_STATEMENT_START_KEYWORDS);
        resolvedLead = match;
      }
    }
    lintStatementByResolvedLead(resolvedLead, stmtTokens, allTokens, stmtGlobalStart, reportTypo);
    return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
  }

  // Top-level SQL statement (`section === "none"`)
  let resolvedLead = first.upper;
  if (isCandidateWordForTypo(allTokens, stmtGlobalStart)) {
    const match = matchKeywordTypo(first.upper, STATEMENT_START_KEYWORDS);
    if (match) {
      reportTypo(first, match, STATEMENT_START_KEYWORDS);
      resolvedLead = match;
    }
  }

  // Track transition into Oracle/openGauss PL/SQL routine/package blocks (non-dollar-quoted)
  if (resolvedLead === "CREATE") {
    const nextState = lintCreateStatementHeader(stmtTokens, allTokens, stmtGlobalStart, reportTypo);
    if (nextState.enteredPlSqlKind === "package_spec") {
      section = "package_spec";
    } else if (nextState.enteredPlSqlKind === "package_body") {
      pkgBody = true;
      if (nextState.subOffset != null) {
        return lintSingleStatementSlice(stmtTokens.slice(nextState.subOffset), allTokens, stmtGlobalStart + nextState.subOffset, "declare", blockDepth, true, reportTypo);
      }
      section = "declare";
    } else if (nextState.enteredPlSqlKind === "routine") {
      if (nextState.subOffset != null) {
        return lintSingleStatementSlice(stmtTokens.slice(nextState.subOffset), allTokens, stmtGlobalStart + nextState.subOffset, "declare", blockDepth, false, reportTypo);
      }
      section = "declare";
    }
    return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
  }

  lintStatementByResolvedLead(resolvedLead, stmtTokens, allTokens, stmtGlobalStart, reportTypo);
  return { plsqlSection: section, plsqlBlockDepth: blockDepth, inPackageBody: pkgBody };
}

function lintCreateStatementHeader(
  stmtTokens: readonly LintToken[],
  allTokens: readonly LintToken[],
  stmtGlobalStart: number,
  reportTypo: (tok: LintToken, suggestion: string, candidates: readonly string[]) => void,
): { enteredPlSqlKind: "none" | "package_spec" | "package_body" | "routine"; subOffset?: number } {
  let idx = 1;

  // `CREATE OR <REPLACE>`
  if (stmtTokens[idx]?.upper === "OR") {
    idx += 1;
    const afterOr = stmtTokens[idx];
    if (afterOr && isCandidateWordForTypo(allTokens, stmtGlobalStart + idx)) {
      const match = matchKeywordTypo(afterOr.upper, ["REPLACE", "ALTER"]);
      if (match) reportTypo(afterOr, match, ["REPLACE", "ALTER"]);
    }
    idx += 1;
  }

  // Optional modifiers before object keyword (`GLOBAL`, `LOCAL`, `TEMP`, `TEMPORARY`, `UNIQUE`, `MATERIALIZED`, `INCREMENTAL`, `PUBLIC`, `FORCE`, `NOFORCE`, `EDITIONABLE`, `NONEDITIONABLE`, `UNLOGGED`)
  const modifiers = new Set(["GLOBAL", "LOCAL", "TEMP", "TEMPORARY", "UNLOGGED", "UNIQUE", "CONCURRENTLY", "MATERIALIZED", "INCREMENTAL", "PUBLIC", "FORCE", "NOFORCE", "EDITIONABLE", "NONEDITIONABLE", "EXTERNAL", "FOREIGN"]);
  const objectKeywords = new Set([
    "TABLE",
    "VIEW",
    "INDEX",
    "SEQUENCE",
    "SCHEMA",
    "DATABASE",
    "FUNCTION",
    "PROCEDURE",
    "PACKAGE",
    "TRIGGER",
    "TYPE",
    "SYNONYM",
    "ROLE",
    "USER",
    "GROUP",
    "TABLESPACE",
    "EXTENSION",
    "RULE",
    "DOMAIN",
    "DIRECTORY",
    "EVENT",
    "JOB",
    "PUBLICATION",
    "SUBSCRIPTION",
    "MODEL",
    "SERVER",
    "POLICY",
    "OPERATOR",
    "AGGREGATE",
    "COLLATION",
    "CONVERSION",
    "LANGUAGE",
    "RESOURCE",
  ]);

  let objectType: string | null = null;
  while (idx < stmtTokens.length && stmtTokens[idx]!.parenDepth === 0) {
    const tok = stmtTokens[idx]!;
    if (tok.kind !== "word") break;

    let upper = tok.upper;
    if (!ALL_KNOWN_SQL_WORDS.has(upper) && isCandidateWordForTypo(allTokens, stmtGlobalStart + idx)) {
      const match = matchKeywordTypo(upper, DDL_CREATE_KEYWORDS);
      if (match) {
        reportTypo(tok, match, DDL_CREATE_KEYWORDS);
        upper = match;
      }
    }

    if (modifiers.has(upper)) {
      idx += 1;
      continue;
    }
    if (objectKeywords.has(upper)) {
      objectType = upper;
      idx += 1;
      break;
    }
    break;
  }

  if (!objectType) return { enteredPlSqlKind: "none" };

  // `CREATE PACKAGE [BODY] <name>` / `CREATE TYPE [BODY] <name>`
  let hasBodyKeyword = false;
  if (objectType === "PACKAGE" || objectType === "TYPE") {
    const maybeBody = stmtTokens[idx];
    if (maybeBody?.upper === "BODY") {
      hasBodyKeyword = true;
      idx += 1;
    } else if (maybeBody && isCandidateWordForTypo(allTokens, stmtGlobalStart + idx) && stmtTokens[idx + 1] && (stmtTokens[idx + 1]!.kind === "word" || stmtTokens[idx + 1]!.kind === "quoted_ident") && stmtTokens[idx + 1]!.upper !== "AS" && stmtTokens[idx + 1]!.upper !== "IS") {
      const match = matchKeywordTypo(maybeBody.upper, ["BODY"]);
      if (match) {
        reportTypo(maybeBody, match, ["BODY"]);
        hasBodyKeyword = true;
        idx += 1;
      }
    }
  }

  // `IF [NOT] EXISTS`
  lintIfExistsClause(stmtTokens, idx, allTokens, stmtGlobalStart, reportTypo);

  // `CREATE [MATERIALIZED] VIEW ... AS SELECT ...` or `CREATE TABLE ... AS SELECT ...`
  if (objectType === "VIEW" || objectType === "TABLE") {
    const asSelectIdx = stmtTokens.findIndex(
      (tok, k) => k >= idx && tok.parenDepth === 0 && tok.upper === "AS" && stmtTokens[k + 1]?.kind === "word" && (stmtTokens[k + 1]!.upper === "SELECT" || stmtTokens[k + 1]!.upper === "WITH" || matchKeywordTypo(stmtTokens[k + 1]!.upper, ["SELECT", "WITH"]) !== null),
    );
    if (asSelectIdx >= 0) {
      const queryStart = asSelectIdx + 1;
      const qFirst = stmtTokens[queryStart]!;
      let qLead = qFirst.upper;
      if (isCandidateWordForTypo(allTokens, stmtGlobalStart + queryStart)) {
        const match = matchKeywordTypo(qFirst.upper, ["SELECT", "WITH"]);
        if (match) {
          reportTypo(qFirst, match, ["SELECT", "WITH"]);
          qLead = match;
        }
      }
      lintStatementByResolvedLead(qLead, stmtTokens.slice(queryStart), allTokens, stmtGlobalStart + queryStart, reportTypo);
    }
  }

  // Check PL/SQL header `IS` / `AS` for non-dollar-quoted routines/packages
  if (objectType === "FUNCTION" || objectType === "PROCEDURE" || objectType === "PACKAGE" || (objectType === "TYPE" && hasBodyKeyword)) {
    const asIdx = stmtTokens.findIndex((tok, k) => k >= idx && tok.parenDepth === 0 && (tok.upper === "AS" || tok.upper === "IS"));
    if (asIdx >= 0) {
      const afterAs = stmtTokens[asIdx + 1];
      // Dollar-quoted body is handled separately by `isRoutineDollarBodyContext`
      if (afterAs?.kind === "string") {
        return { enteredPlSqlKind: "none" };
      }
      if (objectType === "PACKAGE" && !hasBodyKeyword) {
        return { enteredPlSqlKind: "package_spec" };
      }
      if (hasBodyKeyword) {
        return {
          enteredPlSqlKind: "package_body",
          ...(asIdx + 1 < stmtTokens.length ? { subOffset: asIdx + 1 } : {}),
        };
      }
      const secondAfterAs = stmtTokens[asIdx + 2];
      const looksLikeVariableDecl = secondAfterAs?.kind === "word" && ALL_KNOWN_SQL_WORDS.has(secondAfterAs.upper) && secondAfterAs.upper !== "SELECT" && secondAfterAs.upper !== "INSERT" && secondAfterAs.upper !== "UPDATE" && secondAfterAs.upper !== "DELETE";
      if (afterAs && !looksLikeVariableDecl && isCandidateWordForTypo(allTokens, stmtGlobalStart + asIdx + 1)) {
        const match = matchKeywordTypo(afterAs.upper, ["BEGIN", "DECLARE"]);
        if (match) reportTypo(afterAs, match, ["BEGIN", "DECLARE"]);
      }
      const beginIndex = stmtTokens.findIndex((tok, k) => k > asIdx && tok.parenDepth === 0 && tok.upper === "BEGIN");
      return {
        enteredPlSqlKind: "routine",
        ...(beginIndex >= 0 ? { subOffset: beginIndex } : {}),
      };
    }
  }

  return { enteredPlSqlKind: "none" };
}

function lintIfExistsClause(stmtTokens: readonly LintToken[], startIdx: number, allTokens: readonly LintToken[], stmtGlobalStart: number, reportTypo: (tok: LintToken, suggestion: string, candidates: readonly string[]) => void): number {
  let idx = startIdx;
  if (stmtTokens[idx]?.upper === "CONCURRENTLY") idx += 1;
  if (stmtTokens[idx]?.upper === "IF") {
    idx += 1;
    if (stmtTokens[idx]?.upper === "NOT") {
      idx += 1;
    }
    const existsTok = stmtTokens[idx];
    if (existsTok && isCandidateWordForTypo(allTokens, stmtGlobalStart + idx)) {
      const match = matchKeywordTypo(existsTok.upper, ["EXISTS", "NOT"]);
      if (match) reportTypo(existsTok, match, ["EXISTS", "NOT"]);
    }
    idx += 1;
  }
  return idx;
}

function lintStatementByResolvedLead(lead: string, stmtTokens: readonly LintToken[], allTokens: readonly LintToken[], stmtGlobalStart: number, reportTypo: (tok: LintToken, suggestion: string, candidates: readonly string[]) => void) {
  if (lead === "EXPLAIN") {
    // Skip `EXPLAIN [ANALYZE|VERBOSE|PERFORMANCE|(...)]` to inner statement
    let idx = 1;
    while (idx < stmtTokens.length) {
      const t = stmtTokens[idx]!;
      if (t.parenDepth > 0 || t.text === "(" || t.text === ")") {
        idx += 1;
        continue;
      }
      if (t.kind === "word" && (STATEMENT_START_KEYWORDS as readonly string[]).includes(t.upper) && t.upper !== "ANALYZE") {
        lintStatementByResolvedLead(t.upper, stmtTokens.slice(idx), allTokens, stmtGlobalStart + idx, reportTypo);
        return;
      }
      if (t.kind === "word" && isCandidateWordForTypo(allTokens, stmtGlobalStart + idx)) {
        const match = matchKeywordTypo(t.upper, ["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "ANALYZE", "VERBOSE", "PERFORMANCE"]);
        if (match) {
          reportTypo(t, match, ["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "ANALYZE", "VERBOSE", "PERFORMANCE"]);
          if (match !== "ANALYZE" && match !== "VERBOSE" && match !== "PERFORMANCE") {
            lintStatementByResolvedLead(match, stmtTokens.slice(idx), allTokens, stmtGlobalStart + idx, reportTypo);
            return;
          }
        }
      }
      idx += 1;
    }
    return;
  }

  if (lead === "WITH") {
    // Advance past CTE definitions `WITH [RECURSIVE] name AS (...), ...` to main query
    let idx = 1;
    if (stmtTokens[idx]?.upper === "RECURSIVE") idx += 1;
    while (idx < stmtTokens.length) {
      const tok = stmtTokens[idx]!;
      if (tok.parenDepth === 0 && tok.kind === "word" && (tok.upper === "SELECT" || tok.upper === "INSERT" || tok.upper === "UPDATE" || tok.upper === "DELETE" || tok.upper === "MERGE" || matchKeywordTypo(tok.upper, ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]) !== null)) {
        let mainLead = tok.upper;
        if (isCandidateWordForTypo(allTokens, stmtGlobalStart + idx)) {
          const match = matchKeywordTypo(tok.upper, ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]);
          if (match) {
            reportTypo(tok, match, ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]);
            mainLead = match;
          }
        }
        lintStatementByResolvedLead(mainLead, stmtTokens.slice(idx), allTokens, stmtGlobalStart + idx, reportTypo);
        return;
      }
      idx += 1;
    }
    return;
  }

  if (lead === "ALTER") {
    const objTok = stmtTokens[1];
    if (!objTok) return;
    let objUpper = objTok.upper;
    if (isCandidateWordForTypo(allTokens, stmtGlobalStart + 1)) {
      const match = matchKeywordTypo(objTok.upper, DDL_OBJECT_KEYWORDS);
      if (match) {
        reportTypo(objTok, match, DDL_OBJECT_KEYWORDS);
        objUpper = match;
      }
    }
    if (objUpper === "TABLE") {
      let idx = lintIfExistsClause(stmtTokens, 2, allTokens, stmtGlobalStart, reportTypo);
      if (stmtTokens[idx]?.upper === "ONLY") idx += 1;
      idx = skipQualifiedName(stmtTokens, idx);
      const actionTok = stmtTokens[idx];
      if (actionTok && actionTok.parenDepth === 0) {
        let actionUpper = actionTok.upper;
        if (isCandidateWordForTypo(allTokens, stmtGlobalStart + idx)) {
          const match = matchKeywordTypo(actionTok.upper, ALTER_TABLE_ACTION_KEYWORDS);
          if (match) {
            reportTypo(actionTok, match, ALTER_TABLE_ACTION_KEYWORDS);
            actionUpper = match;
          }
        }
        if (actionUpper === "ADD" || actionUpper === "DROP" || actionUpper === "ALTER" || actionUpper === "MODIFY" || actionUpper === "RENAME") {
          const maybeKind = stmtTokens[idx + 1];
          const afterKind = stmtTokens[idx + 2];
          const thirdAfter = stmtTokens[idx + 3];
          // Require `<COLMUN> <col_name> <type_or_action>` (3 tokens) so `ADD col_name VARCHAR` never flags `col_name`.
          if (maybeKind && isCandidateWordForTypo(allTokens, stmtGlobalStart + idx + 1) && afterKind && (afterKind.kind === "word" || afterKind.kind === "quoted_ident") && thirdAfter && thirdAfter.text !== "," && !isSemicolonToken(thirdAfter)) {
            const subTargets = ["COLUMN", "CONSTRAINT"] as const;
            const match = matchKeywordTypo(maybeKind.upper, subTargets);
            if (match) reportTypo(maybeKind, match, subTargets);
          }
        }
      }
    }
    return;
  }

  if (lead === "DROP") {
    let idx = 1;
    if (stmtTokens[idx]?.upper === "CONCURRENTLY") idx += 1;
    const objTok = stmtTokens[idx];
    if (objTok && isCandidateWordForTypo(allTokens, stmtGlobalStart + idx)) {
      const match = matchKeywordTypo(objTok.upper, DDL_OBJECT_KEYWORDS);
      if (match) reportTypo(objTok, match, DDL_OBJECT_KEYWORDS);
    }
    lintIfExistsClause(stmtTokens, idx + 1, allTokens, stmtGlobalStart, reportTypo);
    return;
  }

  if (lead === "TRUNCATE") {
    const firstArg = stmtTokens[1];
    const secondArg = stmtTokens[2];
    // Only check `TRUNCATE <TABEL> <table_name>` when followed by a table identifier (so `TRUNCATE tabel;` never flags a table named `tabel`).
    if (firstArg && isCandidateWordForTypo(allTokens, stmtGlobalStart + 1) && secondArg && (secondArg.kind === "word" || secondArg.kind === "quoted_ident") && secondArg.upper !== "CASCADE" && secondArg.upper !== "RESTRICT") {
      const match = matchKeywordTypo(firstArg.upper, ["TABLE", "ONLY"]);
      if (match) reportTypo(firstArg, match, ["TABLE", "ONLY"]);
    }
    return;
  }

  if (lead === "SELECT" || lead === "INSERT" || lead === "UPDATE" || lead === "DELETE" || lead === "MERGE") {
    lintSelectOrDmlBodyClauses(lead, stmtTokens, allTokens, stmtGlobalStart, reportTypo);
  }
}

function skipQualifiedName(tokens: readonly LintToken[], startIdx: number): number {
  let idx = startIdx;
  if (idx >= tokens.length) return idx;
  if (tokens[idx]!.kind !== "word" && tokens[idx]!.kind !== "quoted_ident") return idx;
  idx += 1;
  while (idx + 1 < tokens.length && tokens[idx]!.text === "." && (tokens[idx + 1]!.kind === "word" || tokens[idx + 1]!.kind === "quoted_ident")) {
    idx += 2;
  }
  return idx;
}

function isExpressionEndToken(tok: LintToken | undefined): boolean {
  if (!tok) return false;
  if (
    tok.kind === "word" &&
    ALL_KNOWN_SQL_WORDS.has(tok.upper) &&
    tok.upper !== "NULL" &&
    tok.upper !== "TRUE" &&
    tok.upper !== "FALSE" &&
    tok.upper !== "END" &&
    tok.upper !== "CURRENT_DATE" &&
    tok.upper !== "CURRENT_TIME" &&
    tok.upper !== "CURRENT_TIMESTAMP" &&
    tok.upper !== "LOCALTIME" &&
    tok.upper !== "LOCALTIMESTAMP" &&
    tok.upper !== "SYSDATE" &&
    tok.upper !== "SYSTIMESTAMP" &&
    tok.upper !== "USER" &&
    tok.upper !== "CURRENT_USER" &&
    tok.upper !== "ROWNUM" &&
    tok.upper !== "LEVEL"
  ) {
    return false;
  }
  return tok.kind === "word" || tok.kind === "quoted_ident" || tok.kind === "number" || tok.kind === "string" || tok.kind === "param" || tok.text === ")" || tok.text === "]" || tok.text === "*";
}

function isExpressionStartToken(tok: LintToken | undefined): boolean {
  if (!tok) return false;
  if (tok.kind === "word" && ALL_KNOWN_SQL_WORDS.has(tok.upper)) {
    return tok.upper === "NOT" || tok.upper === "NULL" || tok.upper === "TRUE" || tok.upper === "FALSE" || tok.upper === "CASE" || tok.upper === "CAST" || tok.upper === "EXISTS" || tok.upper === "SYSDATE" || tok.upper === "CURRENT_TIMESTAMP" || tok.upper === "CURRENT_DATE" || tok.upper === "ROWNUM";
  }
  return tok.kind === "word" || tok.kind === "quoted_ident" || tok.kind === "number" || tok.kind === "string" || tok.kind === "param" || tok.text === "(" || tok.text === "*";
}

function lintSelectOrDmlBodyClauses(lead: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE", stmtTokens: readonly LintToken[], allTokens: readonly LintToken[], stmtGlobalStart: number, reportTypo: (tok: LintToken, suggestion: string, candidates: readonly string[]) => void) {
  const baseDepth = stmtTokens[0]?.parenDepth ?? 0;
  let clause: "select" | "from" | "where" | "group" | "having" | "order" | "limit" | "insert_head" | "update_head" | "set" | "delete_head" | "other" = lead === "SELECT" ? "select" : lead === "INSERT" ? "insert_head" : lead === "UPDATE" ? "update_head" : lead === "DELETE" ? "delete_head" : "other";

  // Pre-handle `SELECT <DISTNCT> ...`, `INSERT <ITNO> ...`, `DELETE <FORM> ...`
  let i = 1;
  if (lead === "SELECT" && stmtTokens[1] && isCandidateWordForTypo(allTokens, stmtGlobalStart + 1)) {
    const afterFirst = stmtTokens[2];
    const thirdTok = stmtTokens[3];
    // `SELECT DISTNCT *` or `SELECT DISTNCT a, b` (only >= 6 chars so short columns are never touched)
    if (stmtTokens[1].text.length >= 6 && (afterFirst?.text === "*" || ((afterFirst?.kind === "word" || afterFirst?.kind === "quoted_ident") && (thirdTok?.text === "," || thirdTok?.upper === "AS" || thirdTok?.upper === "FROM")))) {
      const match = matchKeywordTypo(stmtTokens[1].upper, ["DISTINCT"], { minWordLength: 6 });
      if (match) {
        reportTypo(stmtTokens[1], match, ["DISTINCT"]);
        i = 2;
      }
    }
  } else if (lead === "INSERT") {
    let intoIdx = 1;
    if (stmtTokens[intoIdx]?.upper === "IGNORE" || stmtTokens[intoIdx]?.upper === "OVERWRITE") intoIdx += 1;
    const maybeInto = stmtTokens[intoIdx];
    const afterInto = stmtTokens[intoIdx + 1];
    if (maybeInto?.upper === "INTO") {
      i = intoIdx + 1;
    } else if (maybeInto && isCandidateWordForTypo(allTokens, stmtGlobalStart + intoIdx) && afterInto && (afterInto.kind === "word" || afterInto.kind === "quoted_ident")) {
      const match = matchKeywordTypo(maybeInto.upper, ["INTO"]);
      if (match) {
        reportTypo(maybeInto, match, ["INTO"]);
        i = intoIdx + 1;
      }
    }
    // Skip target table & optional `(col1, col2)` to inspect `VALEUS (...)` or `SELCET ...`
    let afterTarget = skipQualifiedName(stmtTokens, i);
    if (stmtTokens[afterTarget]?.upper === "AS" && stmtTokens[afterTarget + 1]) {
      afterTarget += 2;
    }
    if (stmtTokens[afterTarget]?.text === "(") {
      afterTarget = findMatchingCloseParenTokenIndex(stmtTokens, afterTarget) + 1;
    }
    const sourceTok = stmtTokens[afterTarget];
    if (sourceTok && sourceTok.parenDepth === baseDepth && isCandidateWordForTypo(allTokens, stmtGlobalStart + afterTarget, true)) {
      const insertSourceTargets = sourceTok && stmtTokens[afterTarget + 1]?.text === "(" ? (["VALUES"] as const) : (["VALUES", "SELECT", "WITH", "DEFAULT"] as const);
      const match = matchKeywordTypo(sourceTok.upper, insertSourceTargets);
      if (match) {
        reportTypo(sourceTok, match, insertSourceTargets);
        if (match === "SELECT") {
          clause = "select";
          i = afterTarget + 1;
        } else {
          i = afterTarget + 1;
          clause = "other";
        }
      }
    }
  } else if (lead === "DELETE") {
    if (stmtTokens[1]?.upper === "FROM") {
      clause = "from";
      i = 2;
    } else if (stmtTokens[1] && isCandidateWordForTypo(allTokens, stmtGlobalStart + 1) && stmtTokens[2] && (stmtTokens[2].kind === "word" || stmtTokens[2].kind === "quoted_ident") && stmtTokens[2].upper !== "FROM" && stmtTokens[2].upper !== "WHERE" && stmtTokens[2].upper !== "USING") {
      const match = matchKeywordTypo(stmtTokens[1].upper, ["FROM"]);
      if (match) {
        reportTypo(stmtTokens[1], match, ["FROM"]);
        clause = "from";
        i = 2;
      }
    }
  } else if (lead === "UPDATE") {
    let idx = 1;
    if (stmtTokens[idx]?.upper === "ONLY") idx += 1;
    idx = skipQualifiedName(stmtTokens, idx);
    // Optional `[AS] alias`
    if (stmtTokens[idx]?.upper === "AS" && stmtTokens[idx + 1]) {
      idx += 2;
    } else if (stmtTokens[idx] && (stmtTokens[idx]!.kind === "word" || stmtTokens[idx]!.kind === "quoted_ident") && stmtTokens[idx]!.upper !== "SET" && !(stmtTokens[idx + 1] && stmtTokens[idx + 2]?.text === "=") && !(stmtTokens[idx + 1]?.text === "(")) {
      idx += 1;
    }
    const maybeSet = stmtTokens[idx];
    if (maybeSet?.upper === "SET") {
      clause = "set";
      i = idx + 1;
    } else if (maybeSet && isCandidateWordForTypo(allTokens, stmtGlobalStart + idx) && stmtTokens[idx + 1] && (stmtTokens[idx + 2]?.text === "=" || stmtTokens[idx + 1]?.text === "(")) {
      const match = matchKeywordTypo(maybeSet.upper, ["SET"]);
      if (match) {
        reportTypo(maybeSet, match, ["SET"]);
        clause = "set";
        i = idx + 1;
      }
    }
  }

  let tableExpectingSource = clause === "from";
  let tableAliasConsumed = false;

  while (i < stmtTokens.length) {
    const tok = stmtTokens[i]!;
    if (tok.parenDepth !== baseDepth) {
      i += 1;
      continue;
    }

    // Clause transitions on valid keywords
    if (tok.kind === "word") {
      if (tok.upper === "SELECT") {
        clause = "select";
        i += 1;
        continue;
      }
      if (tok.upper === "FROM" || tok.upper === "USING") {
        // Ignore `FROM` inside `SELECT ... EXTRACT(... FROM ...)` (already filtered by parenDepth === baseDepth)
        clause = "from";
        tableExpectingSource = true;
        tableAliasConsumed = false;
        i += 1;
        continue;
      }
      if (tok.upper === "JOIN") {
        clause = "from";
        tableExpectingSource = true;
        tableAliasConsumed = false;
        i += 1;
        continue;
      }
      if (tok.upper === "ON" && clause === "from") {
        clause = "where";
        i += 1;
        continue;
      }
      if (tok.upper === "WHERE") {
        clause = "where";
        i += 1;
        continue;
      }
      if (tok.upper === "SET") {
        clause = "set";
        i += 1;
        continue;
      }
      if ((tok.upper === "GROUP" || matchKeywordTypo(tok.upper, ["GROUP"]) === "GROUP") && (stmtTokens[i + 1]?.upper === "BY" || stmtTokens[i + 1]?.upper === "YB")) {
        clause = "group";
        i += 2;
        continue;
      }
      if (tok.upper === "HAVING") {
        clause = "having";
        i += 1;
        continue;
      }
      if ((tok.upper === "ORDER" || matchKeywordTypo(tok.upper, ["ORDER"]) === "ORDER") && (stmtTokens[i + 1]?.upper === "BY" || stmtTokens[i + 1]?.upper === "YB")) {
        clause = "order";
        i += 2;
        continue;
      }
      if (tok.upper === "LIMIT" || tok.upper === "OFFSET" || tok.upper === "FETCH") {
        clause = "limit";
        i += 1;
        continue;
      }
      if (tok.upper === "UNION" || tok.upper === "INTERSECT" || tok.upper === "EXCEPT" || tok.upper === "MINUS") {
        clause = "other";
        i += 1;
        continue;
      }
    }

    // Track `FROM <table_source> [AS alias]` slots so neither table names nor table aliases are ever flagged!
    if (clause === "from") {
      if (tok.text === ",") {
        tableExpectingSource = true;
        tableAliasConsumed = false;
        i += 1;
        continue;
      }
      if (tok.kind === "word" && (tok.upper === "LATERAL" || tok.upper === "ONLY")) {
        i += 1;
        continue;
      }
      if (tableExpectingSource) {
        if (tok.text === "(") {
          i = findMatchingCloseParenTokenIndex(stmtTokens, i) + 1;
          tableExpectingSource = false;
          tableAliasConsumed = false;
          continue;
        }
        if (tok.kind === "word" || tok.kind === "quoted_ident") {
          let nextIdx = skipQualifiedName(stmtTokens, i);
          // Skip table-valued function args `func(...)`
          if (stmtTokens[nextIdx]?.text === "(") {
            nextIdx = findMatchingCloseParenTokenIndex(stmtTokens, nextIdx) + 1;
          }
          tableExpectingSource = false;
          tableAliasConsumed = false;
          i = nextIdx;
          continue;
        }
      } else if (!tableAliasConsumed) {
        if (tok.upper === "AS" && stmtTokens[i + 1]) {
          tableAliasConsumed = true;
          i += 2;
          continue;
        }
        if (tok.kind === "quoted_ident") {
          tableAliasConsumed = true;
          i += 1;
          continue;
        }
        if (tok.kind === "word" && !ALL_KNOWN_SQL_WORDS.has(tok.upper)) {
          const afterAlias = stmtTokens[i + 1];
          const isValidAliasFollow = !afterAlias || afterAlias.text === "," || afterAlias.text === "(" || isSemicolonToken(afterAlias) || (afterAlias.kind === "word" && VALID_POST_ALIAS_WORDS.has(afterAlias.upper));
          if (isValidAliasFollow) {
            tableAliasConsumed = true;
            i += 1;
            continue;
          }
          // Not followed by a valid post-alias token (e.g. `FROM users WHREE id = 1`, `FROM users LIMTI 10`, `FROM users JION orders`)!
          if (isCandidateWordForTypo(allTokens, stmtGlobalStart + i)) {
            const match = matchKeywordTypo(tok.upper, POST_TABLE_SOURCE_KEYWORDS);
            if (match) {
              reportTypo(tok, match, POST_TABLE_SOURCE_KEYWORDS);
              if (match === "WHERE" || match === "ON") clause = "where";
              else if (match === "JOIN") {
                tableExpectingSource = true;
                tableAliasConsumed = false;
              } else if (match === "HAVING") clause = "having";
              else if (match === "LIMIT" || match === "OFFSET") clause = "limit";
              else if (match === "SET") clause = "set";
              i += 1;
              continue;
            }
          }
          tableAliasConsumed = true;
          i += 1;
          continue;
        }
      } else if (isCandidateWordForTypo(allTokens, stmtGlobalStart + i)) {
        // Alias WAS already consumed (`FROM users u WHREE u.id = 1`) -> next bare word MUST be a clause keyword!
        const match = matchKeywordTypo(tok.upper, POST_TABLE_SOURCE_KEYWORDS);
        if (match) {
          reportTypo(tok, match, POST_TABLE_SOURCE_KEYWORDS);
          if (match === "WHERE" || match === "ON") clause = "where";
          else if (match === "JOIN") {
            tableExpectingSource = true;
            tableAliasConsumed = false;
          } else if (match === "HAVING") clause = "having";
          else if (match === "LIMIT" || match === "OFFSET") clause = "limit";
          else if (match === "SET") clause = "set";
          i += 1;
          continue;
        }
      }
    }

    // `SELECT` projection clause transition typos (`SELECT * FORM t`, `SELECT a, b FORM t`)
    if (clause === "select" && isCandidateWordForTypo(allTokens, stmtGlobalStart + i)) {
      const prev = stmtTokens[i - 1];
      const next = stmtTokens[i + 1];
      // Case A: right after `*` (`SELECT * FORM users`, `SELECT u.* FORM users`) — `*` never takes a bare alias!
      if (prev?.text === "*" && next && isExpressionStartToken(next)) {
        const match = matchKeywordTypo(tok.upper, POST_SELECT_PROJECTION_KEYWORDS);
        if (match) {
          reportTypo(tok, match, POST_SELECT_PROJECTION_KEYWORDS);
          if (match === "FROM") {
            clause = "from";
            tableExpectingSource = true;
            tableAliasConsumed = false;
          } else if (match === "WHERE") {
            clause = "where";
          }
          i += 1;
          continue;
        }
      }
      // Case B: `<expr_end> <FORM> <table_or_expr>` (`SELECT a, b FORM users`, `SELECT count(1) FORM users`)
      // An expression can take ONE bare alias followed by `,` or a valid clause keyword, NEVER `<expr> <word1> <word2>`!
      if (isExpressionEndToken(prev) && prev?.upper !== "AS" && next && isExpressionStartToken(next)) {
        const match = matchKeywordTypo(tok.upper, POST_SELECT_PROJECTION_KEYWORDS);
        if (match) {
          reportTypo(tok, match, POST_SELECT_PROJECTION_KEYWORDS);
          if (match === "FROM") {
            clause = "from";
            tableExpectingSource = true;
            tableAliasConsumed = false;
          } else if (match === "WHERE") {
            clause = "where";
          } else if (match === "LIMIT" || match === "OFFSET") {
            clause = "limit";
          }
          i += 1;
          continue;
        }
      }
    }

    // Non-alias clauses (`WHERE`, `HAVING`, `SET`, `GROUP BY`, `ORDER BY`, `LIMIT`):
    // Aliases CANNOT appear here! Two adjacent operands separated by a bare word `<operand> <typo> <operand>` must be an operator or clause keyword.
    if ((clause === "where" || clause === "having" || clause === "set" || clause === "group" || clause === "order" || clause === "limit") && isCandidateWordForTypo(allTokens, stmtGlobalStart + i)) {
      const prev = stmtTokens[i - 1];
      const next = stmtTokens[i + 1];
      if (clause === "order" && isExpressionEndToken(prev) && (!next || next.text === "," || isSemicolonToken(next) || next.kind === "word")) {
        const orderTargets = ["ASC", "DESC", "NULLS", "LIMIT", "OFFSET", "FETCH"] as const;
        const match = matchKeywordTypo(tok.upper, orderTargets);
        if (match) {
          reportTypo(tok, match, orderTargets);
          i += 1;
          continue;
        }
      }
      if (isExpressionEndToken(prev) && next && isExpressionStartToken(next)) {
        const match = matchKeywordTypo(tok.upper, CLAUSE_EXPRESSION_KEYWORDS);
        if (match) {
          reportTypo(tok, match, CLAUSE_EXPRESSION_KEYWORDS);
          if (match === "WHERE") clause = "where";
          else if (match === "HAVING") clause = "having";
          else if (match === "LIMIT" || match === "OFFSET") clause = "limit";
          i += 1;
          continue;
        }
      }
    }

    // Universal `<anything> <LIMTI | OFFSTE> <number | param>` check
    if (isCandidateWordForTypo(allTokens, stmtGlobalStart + i) && (stmtTokens[i + 1]?.kind === "number" || stmtTokens[i + 1]?.kind === "param")) {
      const limitTargets = ["LIMIT", "OFFSET"] as const;
      const match = matchKeywordTypo(tok.upper, limitTargets);
      if (match) {
        reportTypo(tok, match, limitTargets);
        clause = "limit";
        i += 1;
        continue;
      }
    }

    i += 1;
  }
}
