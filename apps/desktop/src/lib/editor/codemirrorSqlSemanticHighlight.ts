import { sqlHasProceduralContext, sqlSemanticTableNameSpans } from "@/lib/sql/semantic/model";
import type { SqlSemanticBuildOptions, SqlSemanticSpan } from "@/lib/sql/semantic/types";

type SqlSyntaxTree = ReturnType<typeof import("@codemirror/language").syntaxTree>;

// Multiple viewport windows usually share a tree. Reuse document context while
// scrolling instead of tokenizing the entire routine for every visible window.
const proceduralContextCache = new WeakMap<SqlSyntaxTree, { sql: string; key: string; value: boolean }>();

function proceduralContextForTree(sql: string, tree: SqlSyntaxTree, options: SqlSemanticBuildOptions): boolean {
  const key = `${options.databaseType ?? ""}:${options.dialect ?? ""}`;
  const cached = proceduralContextCache.get(tree);
  if (cached?.sql === sql && cached.key === key) return cached.value;
  const value = sqlHasProceduralContext(sql, options);
  proceduralContextCache.set(tree, { sql, key, value });
  return value;
}

const SUPPRESSED_NODE_NAMES = new Set(["String", "LineComment", "BlockComment"]);

export interface SqlSemanticHighlightWindow {
  from: number;
  to: number;
}

function maskSuppressedSyntax(sql: string, window: SqlSemanticHighlightWindow, tree: SqlSyntaxTree): string {
  const ranges: Array<SqlSemanticHighlightWindow & { string: boolean }> = [];
  tree.iterate({
    from: window.from,
    to: window.to,
    enter(node) {
      if (!SUPPRESSED_NODE_NAMES.has(node.name)) return;
      ranges.push({ from: Math.max(window.from, node.from), to: Math.min(window.to, node.to), string: node.name === "String" });
      return false;
    },
  });

  let cursor = window.from;
  let masked = "";
  for (const range of ranges) {
    if (range.from < cursor) continue;
    masked += sql.slice(cursor, range.from);
    const hidden = sql.slice(range.from, range.to).replace(/[^\r\n]/g, " ");
    // Keep a non-identifier token where a string was, including clipped windows.
    // Removing the token entirely would turn FROM 'value' THEN into FROM THEN.
    masked += range.string && hidden.length ? "0" + hidden.slice(1) : hidden;
    cursor = range.to;
  }
  return masked + sql.slice(cursor, window.to);
}

export function sqlSemanticTableNameSpansForSyntaxTree(sql: string, window: SqlSemanticHighlightWindow, tree: SqlSyntaxTree, options: SqlSemanticBuildOptions = {}): SqlSemanticSpan[] {
  const maskedSql = maskSuppressedSyntax(sql, window, tree);
  return sqlSemanticTableNameSpans(maskedSql, { ...options, proceduralContext: proceduralContextForTree(sql, tree, options) }).map((span) => ({ start: span.start + window.from, end: span.end + window.from }));
}
