import type { RoutineHealthRoutine, RoutineHealthSnapshot } from "@/lib/backend/api";
import { buildSqlSemanticModel, sqlSemanticTableNameSpans } from "@/lib/sql/semantic/model";
import { tokenIsIdentifier, tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticRowSource, SqlSemanticToken } from "@/lib/sql/semantic/types";
import { parseSqlRoutineParameters } from "@/lib/sql/sqlRoutineParameters";

export interface RoutineHealthFinding {
  code: string;
  severity: "error" | "warning" | "info";
  objectType?: string;
  objectName?: string;
  line?: number;
  message: string;
}

export interface RoutineHealthResult {
  routine: RoutineHealthRoutine;
  findings: RoutineHealthFinding[];
}

type Token = SqlSemanticToken;
const options = { dialect: "postgres" as const };
const SQL_WORDS = new Set(
  "all and any array as asc asymmetric at between both by case cast collate current_date current_role current_time current_timestamp current_user day default desc distinct else end escape except exists extract false filter first following for from group grouping having hour ilike in interval into is isnull last leading like limit localtime localtimestamp minute month not notnull null nullif nulls offset on only or order others over overlaps partition preceding range recursive returning row rows second select session_user similar some strict symmetric then ties time trailing true unbounded union unique unknown user using values variadic when where window with within year zone coalesce greatest least xmlconcat xmlelement xmlexists xmlforest xmlparse xmlpi xmlroot xmlserialize json_object json_array json_exists json_query json_value substring trim overlay position normalize collation for update share nowait skip locked of set insert delete merge join left right inner outer cross full natural lateral fetch next table begin if elsif loop while raise exception perform return query execute call declare constant record new old found sqlstate sqlerrm diagnostics row_count array_agg numeric decimal integer int int2 int4 int8 smallint bigint real float float4 float8 double precision boolean bool text varchar char character date timestamp timestamptz timetz bit varbit bytea json jsonb uuid serial bigserial void record pg_catalog public".split(
    /\s+/,
  ),
);
const SPECIAL_CALLS = new Set(
  "if elsif while case in exists values select with as over filter within grouping cast treat extract substring trim overlay position coalesce nullif greatest least row array any all some not and or xmltable json_table json_object json_array json_exists json_query json_value xmlconcat xmlelement xmlexists xmlforest xmlparse xmlpi xmlroot xmlserialize normalize collate numeric decimal integer int int2 int4 int8 smallint bigint real float float4 float8 double boolean bool text varchar char character date timestamp timestamptz timetz bit varbit bytea json jsonb uuid".split(
    /\s+/,
  ),
);
const nameOf = (token: Token) => (token.kind === "quoted_identifier" ? unquoteSqlSemanticIdentifier(token) : token.normalized);
const blank = (text: string) => text.replace(/[^\r\n]/g, " ");

/** The shared lexer does not support nested PG comments or E-string escapes. Mask
 * them first, keeping offsets; never interpret their contents as dependencies. */
function safeLexicalSource(source: string): string {
  let output = "";
  for (let i = 0; i < source.length; ) {
    const start = i;
    if (source.startsWith("/*", i)) {
      i += 2;
      let depth = 1;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (source.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      output += blank(source.slice(start, i));
    } else if (source.startsWith("--", i)) {
      while (i < source.length && source[i] !== "\n") i++;
      output += blank(source.slice(start, i));
    } else if (source[i] === "'" || source[i] === '"') {
      const quote = source[i++]!;
      const escape = quote === "'" && /[eE]/.test(source[start - 1] ?? "") && !/[\w$]/.test(source[start - 2] ?? "");
      while (i < source.length) {
        if (escape && source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i++] === quote) {
          if (source[i] === quote) {
            i++;
            continue;
          }
          break;
        }
      }
      const value = source.slice(start, i);
      output += quote === "'" ? "'" + blank(value.slice(1, -1)) + "'" : value;
    } else if (source[i] === "$" && /^\$[\w]*\$/.test(source.slice(i))) {
      const delimiter = /^\$[\w]*\$/.exec(source.slice(i))![0];
      const end = source.indexOf(delimiter, i + delimiter.length);
      i = end < 0 ? source.length : end + delimiter.length;
      output += source.slice(start, i);
    } else output += source[i++];
  }
  return output;
}

function bodySource(source: string): { sql: string; opaque: boolean } {
  const safe = safeLexicalSource(source);
  const tokens = tokenizeSqlSemantic(safe, "postgres");
  if (tokens[0]?.normalized !== "create") return { sql: safe, opaque: false };
  const asIndex = tokens.findIndex((t) => t.depth === 0 && ["as", "is"].includes(t.normalized));
  if (asIndex < 0) return { sql: "", opaque: true };
  const body = tokens[asIndex + 1];
  if (body?.kind === "string") {
    if (!body.quote?.startsWith("$")) return { sql: "", opaque: true };
    const begin = body.span.start + body.quote.length;
    const end = body.span.end - body.quote.length;
    return { sql: blank(source.slice(0, begin)) + safeLexicalSource(source.slice(begin, end)) + blank(source.slice(end)), opaque: false };
  }
  return { sql: blank(source.slice(0, tokens[asIndex]!.span.end)) + safe.slice(tokens[asIndex]!.span.end), opaque: false };
}

function qualified(tokens: Token[], start: number): { parts: string[]; end: number } | undefined {
  if (!tokenIsIdentifier(tokens[start])) return;
  const parts = [nameOf(tokens[start]!)];
  let end = start + 1;
  while (tokens[end]?.text === "." && tokenIsIdentifier(tokens[end + 1])) {
    parts.push(nameOf(tokens[end + 1]!));
    end += 2;
  }
  return { parts, end };
}

/** Static, read-only checks. Unknown scopes are deliberately skipped, not guessed. */
export function analyzeRoutineHealth(snapshot: RoutineHealthSnapshot): RoutineHealthResult[] {
  return snapshot.routines.filter((routine) => routine.source !== null).map((routine) => analyzeRoutine(snapshot, routine));
}

function analyzeRoutine(snapshot: RoutineHealthSnapshot, routine: RoutineHealthRoutine): RoutineHealthResult {
  const findings: RoutineHealthFinding[] = [];
  const source = routine.source ?? "";
  const seen = new Set<string>();
  function add(code: string, severity: RoutineHealthFinding["severity"], message: string, token?: Token, objectType?: string, objectName?: string) {
    const line = token ? source.slice(0, token.span.start).split("\n").length : undefined;
    const key = `${code}:${line}:${objectName ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ code, severity, message, line, objectType, objectName });
    }
  }
  if (!["plpgsql", "sql", "plsql"].includes(routine.language.toLowerCase())) {
    add("unsupported_language", "info", `尚未分析 ${routine.language || "未知"} 语言的例程体。`);
    return { routine, findings };
  }
  const body = bodySource(source);
  if (body.opaque || !body.sql.trim()) {
    add("unparsed_source", "warning", "无法取得可静态分析的例程体。\n");
    return { routine, findings };
  }
  const allTokens = tokenizeSqlSemantic(body.sql, "postgres").filter((t) => t.kind !== "comment");
  if (allTokens.length > 15000) {
    add("analysis_limit", "warning", "例程超出静态分析大小限制，未完成依赖检查。");
    return { routine, findings };
  }
  const searchPath = routine.searchPath ?? snapshot.searchPath;
  const pathKnown = searchPath.length > 0 && searchPath.every((s) => s && !s.includes("$") && !s.startsWith("pg_temp"));
  const path = searchPath.includes("pg_catalog") ? searchPath : ["pg_catalog", ...searchPath];
  const changesPath = allTokens.some((t, i) => (t.normalized === "set" && allTokens[i + 1]?.normalized === "search_path") || t.normalized === "set_config");
  if (!pathKnown || changesPath) add("unresolved_search_path", "warning", "search_path 无法静态确定；未判定未限定名称是否缺失。");
  function resolve<T extends { schema: string; name: string }>(items: T[], parts: string[]): T | undefined {
    if (parts.length === 2) return items.find((item) => item.schema === parts[0] && item.name === parts[1]);
    if (parts.length !== 1 || !pathKnown || changesPath) return;
    for (const schema of path) {
      const item = items.find((candidate) => candidate.schema === schema && candidate.name === parts[0]);
      if (item) return item;
    }
  }
  const canResolve = (parts: string[]) => parts.length === 2 || (parts.length === 1 && pathKnown && !changesPath);
  const variables = new Set(["new", "old", "found", "sqlstate", "sqlerrm"]);
  for (const parameter of parseSqlRoutineParameters(routine.signature)) {
    if (parameter.name) variables.add(nameOf(tokenizeSqlSemantic(parameter.name, "postgres")[0]!));
  }
  let declaring = false;
  let declarationStart = false;
  const temporaryNames = new Set<string>();
  for (let i = 0; i < allTokens.length; i++) {
    const t = allTokens[i]!;
    if (t.normalized === "declare") {
      declaring = true;
      declarationStart = true;
    } else if (t.normalized === "begin") declaring = false;
    else if (declaring && declarationStart && tokenIsIdentifier(t)) {
      variables.add(nameOf(t));
      declarationStart = false;
    } else if (declaring && t.text === ";") declarationStart = true;
    if (t.normalized === "for" && tokenIsIdentifier(allTokens[i + 1]) && allTokens[i + 2]?.normalized === "in") variables.add(nameOf(allTokens[i + 1]!));
    if (t.normalized === "execute") add("dynamic_sql", "warning", "动态 SQL 的依赖只能在运行时确定，未分析字符串中的 SQL。", t);
    if (t.normalized === "table" && allTokens.slice(Math.max(0, i - 3), i).some((v) => ["temp", "temporary"].includes(v.normalized))) {
      let at = i + 1;
      while (["if", "not", "exists"].includes(allTokens[at]?.normalized ?? "")) at++;
      const q = qualified(allTokens, at);
      if (q) temporaryNames.add(q.parts[q.parts.length - 1]!);
      add("temporary_relation", "warning", "例程创建临时表；其结构和会话依赖未完整检查。", t);
    }
  }
  const statements: Token[][] = [];
  let current: Token[] = [];
  for (const t of allTokens) {
    if (t.text === ";") {
      if (current.length) statements.push(current);
      current = [];
    } else current.push(t);
  }
  if (current.length) statements.push(current);
  for (const tokens of statements) analyzeStatement(tokens);
  return { routine, findings };

  function analyzeStatement(tokens: Token[]) {
    const start = tokens[0]!.span.start;
    const end = tokens[tokens.length - 1]!.span.end;
    // Keep absolute positions throughout so every finding opens the original source line.
    let sql = blank(body.sql.slice(0, start)) + body.sql.slice(start, end);
    const relationSpans = sqlSemanticTableNameSpans(sql, { ...options, proceduralContext: routine.language !== "sql" });
    const relationEnds = new Set(relationSpans.map((span) => span.end));
    const relationNames = new Set<number>();
    const ctes = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
      if (!["with", ","].includes(tokens[i]!.normalized)) continue;
      let at = i + 1;
      if (tokens[at]?.normalized === "recursive") at++;
      const t = tokens[at];
      if (!tokenIsIdentifier(t)) continue;
      let after = at + 1;
      if (tokens[after]?.text === "(") {
        const d = tokens[after]!.depth;
        while (++after < tokens.length && !(tokens[after]!.text === ")" && tokens[after]!.depth === d)) {
          /* column aliases */
        }
        after++;
      }
      if (tokens[after]?.normalized === "as" && ["(", "materialized", "not"].includes(tokens[after + 1]?.normalized ?? "")) ctes.add(nameOf(t));
    }
    const references: { parts: string[]; token: Token }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i - 1]?.text === ".") continue;
      const q = qualified(tokens, i);
      if (!q || !relationEnds.has(tokens[q.end - 1]!.span.end)) continue;
      for (let n = i; n < q.end; n++) relationNames.add(tokens[n]!.span.start);
      const last = q.parts[q.parts.length - 1]!;
      if (q.parts.length === 1 && ctes.has(last)) continue;
      if (temporaryNames.has(last) || q.parts[0]?.startsWith("pg_temp")) {
        add("temporary_relation", "warning", "临时表依赖未完整检查。", tokens[i], "relation", q.parts.join("."));
        continue;
      }
      references.push({ parts: q.parts, token: tokens[i]! });
      if (canResolve(q.parts) && !resolve(snapshot.relations, q.parts)) add("missing_relation", "error", `未找到表或视图 ${q.parts.join(".")}。`, tokens[i], "relation", q.parts.join("."));
    }
    // The generic completion model treats SELECT INTO as a relation. Mask only
    // the assignment clause before asking it for visible row sources.
    if (routine.language !== "sql") {
      const chars = sql.split("");
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i]!.normalized !== "into") continue;
        const previous = tokens
          .slice(0, i)
          .reverse()
          .find((t) => t.depth === tokens[i]!.depth && ["select", "insert", "merge", "returning"].includes(t.normalized));
        if (!previous || !["select", "returning"].includes(previous.normalized)) continue;
        for (let j = i; j < tokens.length; j++) {
          const t = tokens[j]!;
          if (j > i && t.depth === tokens[i]!.depth && ["from", "where", "order", "group", "limit"].includes(t.normalized)) break;
          for (let p = t.span.start; p < t.span.end; p++) chars[p] = " ";
        }
      }
      sql = chars.join("");
    }
    const sourceCache = new Map<string, SqlSemanticRowSource[]>();
    function visible(t: Token): SqlSemanticRowSource[] {
      const starts = tokens.filter((v) => v.span.start <= t.span.start && v.depth <= t.depth && v.normalized === "select").map((v) => v.span.start);
      const key = `${t.depth}:${starts.join(",")}`;
      let sources = sourceCache.get(key);
      if (!sources) {
        sources = buildSqlSemanticModel(sql, t.span.end, options).rowSources.filter((row) => row.kind === "subquery" || row.kind === "cte" || row.kind === "table_function" || (row.qualifiedName && relationEnds.has(row.qualifiedName.span.end)));
        sourceCache.set(key, sources);
      }
      return sources;
    }
    function columns(row: SqlSemanticRowSource, visited = new Set<SqlSemanticRowSource>()): string[] | undefined {
      if (visited.has(row)) return;
      visited.add(row);
      if (row.kind === "table_function" || temporaryNames.has(row.name)) return;
      if (row.derivedQuery) {
        const result: string[] = [];
        for (const projection of row.derivedQuery.projections) {
          if (!projection.wildcardQualifier) {
            result.push(projection.name);
            continue;
          }
          const qualifier = projection.wildcardQualifier.join(".");
          const from = row.derivedQuery.sources.filter((v) => !qualifier || (v.alias ?? v.name) === qualifier);
          if (!from.length) return;
          for (const child of from) {
            const names = columns(child, new Set(visited));
            if (!names) return;
            result.push(...names);
          }
        }
        return result.map((name, i) => row.columnAliases?.[i] ?? name);
      }
      if (row.columns) return row.columns;
      return resolve(snapshot.relations, [...row.qualifierParts, row.name])?.columns;
    }
    function checkColumn(t: Token, column: string, qualifier?: string) {
      if (variables.has(qualifier ?? column)) return;
      const rows = visible(t);
      const matches = qualifier ? rows.filter((row) => (row.alias ?? row.name) === qualifier || (!row.alias && [...row.qualifierParts, row.name].join(".") === qualifier)) : rows;
      if (!matches.length) return;
      if (qualifier) {
        // The first visible alias is the innermost one (correlated queries may shadow it).
        const names = columns(matches[0]!);
        if (names && !names.includes(column)) add("missing_column", "error", `未找到字段 ${qualifier}.${column}。`, t, "column", `${qualifier}.${column}`);
      } else if (matches.length === 1) {
        const names = columns(matches[0]!);
        if (names && !names.includes(column)) add("missing_column", "error", `未找到字段 ${column}（${matches[0]!.name}）。`, t, "column", column);
      }
    }
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (!tokenIsIdentifier(t) || tokens[i - 1]?.text === "." || relationNames.has(t.span.start)) continue;
      const q = qualified(tokens, i)!;
      const next = tokens[q.end];
      if (next?.text === "(") {
        if (q.parts.length === 1 && (SPECIAL_CALLS.has(q.parts[0]!) || ctes.has(q.parts[0]!))) continue;
        if (["function", "procedure", "table", "type", "index"].includes(tokens[i - 1]?.normalized ?? "")) continue;
        if (q.parts.length > 2) {
          add("unresolved_package_call", "warning", "包或多级限定调用未完整检查。", t, "routine", q.parts.join("."));
          continue;
        }
        if (canResolve(q.parts) && !resolve(snapshot.routines, q.parts) && !resolve(snapshot.relations, q.parts)) {
          add("missing_routine", "warning", `未找到同名例程 ${q.parts.join(".")}；需核实类型转换或扩展语法。`, t, "routine", q.parts.join("."));
        }
      } else if (q.parts.length >= 2 && q.parts.length <= 3) {
        checkColumn(t, q.parts[q.parts.length - 1]!, q.parts.slice(0, -1).join("."));
      }
    }
    // Only unambiguous single-identifier projections are checked as bare columns;
    // arbitrary PL/SQL expressions may contain labels, types, output aliases or variables.
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.normalized !== "select") continue;
      const depth = tokens[i]!.depth;
      let at = i + 1;
      if (["distinct", "all"].includes(tokens[at]?.normalized ?? "")) at++;
      while (at < tokens.length) {
        let stop = at;
        while (stop < tokens.length && !(tokens[stop]!.depth === depth && [",", "from", "into", ";"].includes(tokens[stop]!.normalized)) && tokens[stop]!.depth >= depth) stop++;
        const group = tokens.slice(at, stop);
        if (tokenIsIdentifier(group[0]) && !SQL_WORDS.has(group[0]!.normalized) && (group.length === 1 || (group.length === 2 && tokenIsIdentifier(group[1])) || (group.length === 3 && group[1]!.normalized === "as"))) checkColumn(group[0]!, nameOf(group[0]!));
        if (tokens[stop]?.text !== ",") break;
        at = stop + 1;
      }
    }
    // DML target lists have no variable/column ambiguity.
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (!["insert", "update"].includes(t.normalized)) continue;
      if (t.normalized === "update" && ["for", "do", "key"].includes(tokens[i - 1]?.normalized ?? "")) continue;
      let at = i + 1;
      if (tokens[at]?.normalized === "into") at++;
      if (tokens[at]?.normalized === "only") at++;
      const q = qualified(tokens, at);
      if (!q) continue;
      const relation = resolve(snapshot.relations, q.parts);
      if (!relation) continue;
      const reportTarget = (column: Token) => {
        if (!relation.columns.includes(nameOf(column))) add("missing_column", "error", `目标表 ${q.parts.join(".")} 缺少字段 ${nameOf(column)}。`, column, "column", `${q.parts.join(".")}.${nameOf(column)}`);
      };
      if (t.normalized === "insert" && tokens[q.end]?.text === "(") {
        const depth = tokens[q.end]!.depth + 1;
        for (let n = q.end + 1; n < tokens.length && tokens[n]!.depth >= depth; n++) if (tokens[n]!.depth === depth && tokenIsIdentifier(tokens[n])) reportTarget(tokens[n]!);
      }
      if (t.normalized === "update") {
        const set = tokens.findIndex((v, n) => n >= q.end && v.depth === t.depth && v.normalized === "set");
        for (let n = set + 1; set >= 0 && n < tokens.length; n++) {
          if (tokens[n]!.depth === t.depth && ["where", "from", "returning"].includes(tokens[n]!.normalized)) break;
          if ((n === set + 1 || (tokens[n - 1]?.text === "," && tokens[n - 1]?.depth === t.depth)) && tokenIsIdentifier(tokens[n]) && tokens[n + 1]?.text === "=") reportTarget(tokens[n]!);
        }
      }
    }
    // A bare identifier is ambiguous in PL/pgSQL (variable, label, column...).
    // Resolve predicate operands against their own complete visible source set;
    // skip unknown columns and variables rather than guessing.
    const comparison = new Set(["=", "<", ">", "<=", ">=", "<>", "!="]);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (!tokenIsIdentifier(t) || tokens[i - 1]?.text === "." || relationNames.has(t.span.start)) continue;
      const q = qualified(tokens, i)!;
      if (q.parts.length !== 1) continue;
      const next = tokens[q.end];
      const previous = tokens[i - 1];
      if (next?.text === "(" || previous?.normalized === "::" || next?.normalized === "::") continue;
      const name = q.parts[0]!;
      if (variables.has(name) || SQL_WORDS.has(name) || SPECIAL_CALLS.has(name)) continue;
      const inPredicate = comparison.has(previous?.text ?? "") || comparison.has(next?.text ?? "") || ["is", "between", "in", "like", "ilike"].includes(next?.normalized ?? "");
      if (!inPredicate) continue;
      // Assignment targets in UPDATE ... SET are covered by the DML target check.
      if (next?.text === "=" && (previous?.normalized === "set" || previous?.text === ",")) continue;
      // Resolve at the operand's position, never at the end of the outer query.
      // A correlated query can see outer columns too. Only report a missing name
      // when every visible source has known columns and none contains it.
      const predicateRows = visible(t);
      const available = predicateRows.map((row) => columns(row));
      if (!predicateRows.length || available.some((names) => !names)) continue;
      if (available.every((names) => !names!.includes(name))) {
        add("missing_column", "error", `未找到字段 ${name}。`, t, "column", name);
      }
    }
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.normalized !== "index" || !["drop", "alter", "reindex"].includes(tokens[i - 1]?.normalized ?? "")) continue;
      let at = i + 1;
      const optional = tokens[at]?.normalized === "if";
      while (["if", "exists", "concurrently"].includes(tokens[at]?.normalized ?? "")) at++;
      const q = qualified(tokens, at);
      if (q && canResolve(q.parts) && !resolve(snapshot.indexes, q.parts)) add(optional ? "optional_index_missing" : "missing_index", optional ? "info" : "error", `未找到显式引用的索引 ${q.parts.join(".")}${optional ? "（IF EXISTS 允许不存在）" : ""}。`, tokens[at], "index", q.parts.join("."));
    }
    if (tokens.some((t) => t.normalized === "merge"))
      add(
        "partial_statement",
        "info",
        "MERGE 分支与字段映射尚未完整分析。",
        tokens.find((t) => t.normalized === "merge"),
      );
  }
}
