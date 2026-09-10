import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";

export type SqlSelectionCaseMode = "upper" | "lower";

type SqlSelectionRange = {
  from: number;
  to: number;
};

// Routine bodies can nest (e.g. a function body containing another `AS $...$`
// block); bound the recursion so pathological input stays cheap.
const MAX_ROUTINE_BODY_DEPTH = 8;

function convertCase(text: string, mode: SqlSelectionCaseMode): string {
  return mode === "upper" ? text.toUpperCase() : text.toLowerCase();
}

function isDollarQuotedString(item: SqlSemanticToken): boolean {
  return item.kind === "string" && (item.quote ?? "").startsWith("$");
}

// A dollar-quoted block introduced by AS is a routine body (code), not a string
// value: `CREATE FUNCTION ... AS $body$ ... $body$`. Dollar-quoted values in
// expression position (e.g. `SELECT $tag$Mixed Value$tag$`) keep their content
// untouched.
function isRoutineBodyString(tokens: readonly SqlSemanticToken[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = tokens[cursor];
    if (!previous || previous.kind === "comment") continue;
    return previous.kind === "word" && previous.normalized === "as";
  }
  return false;
}

function dollarBodyBounds(item: SqlSemanticToken): { contentStart: number; contentEnd: number } {
  const marker = item.quote ?? "";
  const terminated = item.text.length >= marker.length * 2 && item.text.endsWith(marker);
  const contentStart = item.span.start + marker.length;
  const contentEnd = terminated ? item.span.end - marker.length : item.span.end;
  return { contentStart, contentEnd };
}

// Converts the case of a self-contained SQL fragment, preserving string literal
// contents and recursing into dollar-quoted routine bodies.
function convertSqlTextCase(text: string, mode: SqlSelectionCaseMode, dialectId: "postgres" | undefined, depth: number): string {
  const tokens = tokenizeSqlSemantic(text, dialectId);
  let converted = "";
  let cursor = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const item = tokens[index];
    if (!item || item.kind !== "string") continue;
    const { start, end } = item.span;
    converted += convertCase(text.slice(cursor, start), mode);
    if (isDollarQuotedString(item) && depth < MAX_ROUTINE_BODY_DEPTH && isRoutineBodyString(tokens, index)) {
      const { contentStart, contentEnd } = dollarBodyBounds(item);
      converted += convertCase(text.slice(start, contentStart), mode);
      converted += convertSqlTextCase(text.slice(contentStart, contentEnd), mode, dialectId, depth + 1);
      converted += convertCase(text.slice(contentEnd, end), mode);
    } else {
      converted += text.slice(start, end);
    }
    cursor = end;
  }
  converted += convertCase(text.slice(cursor), mode);
  return converted;
}

export function convertSqlSelectionCase(sql: string, range: SqlSelectionRange, mode: SqlSelectionCaseMode, dialectId?: "postgres"): string {
  const from = Math.max(0, Math.min(range.from, sql.length));
  const to = Math.max(from, Math.min(range.to, sql.length));
  const tokens = tokenizeSqlSemantic(sql, dialectId);
  const intersecting = tokens.map((item, index) => ({ item, index })).filter(({ item }) => item.kind === "string" && item.span.end > from && item.span.start < to);

  if (intersecting.length === 0) return convertCase(sql.slice(from, to), mode);

  let converted = "";
  let cursor = from;
  for (const { item, index } of intersecting) {
    const literalFrom = Math.max(from, item.span.start);
    const literalTo = Math.min(to, item.span.end);
    converted += convertCase(sql.slice(cursor, literalFrom), mode);
    if (isDollarQuotedString(item) && isRoutineBodyString(tokens, index)) {
      // Routine body: convert the code inside the dollar quotes while still
      // preserving string literals within the body.
      const { contentStart, contentEnd } = dollarBodyBounds(item);
      converted += convertCase(sql.slice(literalFrom, Math.min(literalTo, contentStart)), mode);
      const bodyFrom = Math.max(literalFrom, contentStart);
      const bodyTo = Math.min(literalTo, contentEnd);
      if (bodyFrom < bodyTo) converted += convertSqlTextCase(sql.slice(bodyFrom, bodyTo), mode, dialectId, 1);
      if (literalTo > contentEnd) converted += convertCase(sql.slice(Math.max(literalFrom, contentEnd), literalTo), mode);
    } else {
      converted += sql.slice(literalFrom, literalTo);
    }
    cursor = literalTo;
  }
  converted += convertCase(sql.slice(cursor, to), mode);
  return converted;
}
