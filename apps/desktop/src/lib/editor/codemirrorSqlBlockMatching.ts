import type { Extension, Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

export type SqlBlockKeyword = "BEGIN" | "END" | "CASE";

export interface SqlBlockMatchToken {
  from: number;
  to: number;
  word: SqlBlockKeyword;
}

export interface SqlBeginEndPair {
  begin: SqlBlockMatchToken;
  end: SqlBlockMatchToken;
}

const NON_BLOCK_END_WORDS = new Set(["CATCH", "FOR", "IF", "LOOP", "REPEAT", "TRY", "WHILE"]);
const TRANSACTION_BEGIN_WORDS = new Set(["CONCURRENTLY", "DEFERRED", "EXCLUSIVE", "IMMEDIATE", "ISOLATION", "TRAN", "TRANSACTION", "WORK"]);
const MAX_BLOCK_MATCH_SCAN_DISTANCE = 20_000;
const MAX_BLOCK_MATCH_CURSORS = 8;

function isIdentifierStart(char: string | undefined): boolean {
  return !!char && /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$]/.test(char);
}

function skipQuotedText(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function skipLineComment(sql: string, start: number): number {
  const newline = sql.indexOf("\n", start + 1);
  return newline < 0 ? sql.length : newline;
}

function skipBlockComment(sql: string, start: number): number {
  const close = sql.indexOf("*/", start + 2);
  return close < 0 ? sql.length : close + 2;
}

/**
 * Finds BEGIN/END/CASE words while ignoring quoted text and SQL comments.
 * The scanner intentionally stays lexical so it also works for dialects whose
 * CodeMirror grammar does not expose a stable block node name.
 */
export function sqlBeginEndTokens(sql: string): SqlBlockMatchToken[] {
  const tokens: SqlBlockMatchToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      index = skipLineComment(sql, index + 1);
      continue;
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(sql, index);
      continue;
    }
    if (char === "#") {
      index = skipLineComment(sql, index);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      index = skipQuotedText(sql, index, char);
      continue;
    }
    if (char === "[") {
      const close = sql.indexOf("]", index + 1);
      index = close < 0 ? sql.length : close + 1;
      continue;
    }
    if (!isIdentifierStart(char)) {
      index += 1;
      continue;
    }

    const from = index;
    index += 1;
    while (isIdentifierPart(sql[index])) index += 1;
    const word = sql.slice(from, index).toUpperCase();
    if (word === "BEGIN" || word === "END" || word === "CASE") {
      tokens.push({ from, to: index, word });
    }
  }

  return tokens;
}

function followingWord(sql: string, token: SqlBlockMatchToken): string | undefined {
  return sql
    .slice(token.to)
    .match(/^\s+([A-Za-z_][A-Za-z0-9_$]*)/)?.[1]
    ?.toUpperCase();
}

function nextNonWhitespace(sql: string, token: SqlBlockMatchToken): string | undefined {
  return sql.slice(token.to).match(/^\s*(.)/)?.[1];
}

interface SqlBlockStackToken extends SqlBlockMatchToken {
  endWord?: "TRY" | "CATCH";
}

export function sqlBeginEndPairs(sql: string): SqlBeginEndPair[] {
  const stack: SqlBlockStackToken[] = [];
  const pairs: SqlBeginEndPair[] = [];
  const tokens = sqlBeginEndTokens(sql);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const nextWord = followingWord(sql, token);

    if (token.word === "BEGIN") {
      const transactionStart = TRANSACTION_BEGIN_WORDS.has(nextWord ?? "") || nextNonWhitespace(sql, token) === ";";
      if (!transactionStart) {
        stack.push({
          ...token,
          endWord: nextWord === "TRY" || nextWord === "CATCH" ? nextWord : undefined,
        });
      }
      continue;
    }

    if (token.word === "CASE") {
      stack.push(token);
      continue;
    }

    if (nextWord === "CASE") {
      const begin = stack[stack.length - 1]?.word === "CASE" ? stack.pop() : undefined;
      if (begin) pairs.push({ begin, end: token });
      // CASE is also present in the token list as END CASE's suffix.
      if (tokens[index + 1]?.word === "CASE") index += 1;
      continue;
    }

    if (nextWord === "TRY" || nextWord === "CATCH") {
      const top = stack[stack.length - 1];
      if (top?.word === "BEGIN" && top.endWord === nextWord) {
        stack.pop();
        pairs.push({ begin: top, end: token });
      }
      continue;
    }

    if (nextWord && NON_BLOCK_END_WORDS.has(nextWord)) continue;
    const begin = stack.pop();
    if (begin) pairs.push({ begin, end: token });
  }

  return pairs;
}

function tokenIsNearCursor(token: SqlBlockMatchToken, cursor: number): boolean {
  return cursor >= Math.max(0, token.from - 1) && cursor <= token.to + 1;
}

function sourceLength(source: string | Text): number {
  return typeof source === "string" ? source.length : source.length;
}

function sourceSlice(source: string | Text, from: number, to: number): string {
  return typeof source === "string" ? source.slice(from, to) : source.sliceString(from, to);
}

/**
 * Resolves only a bounded window around each cursor. This keeps cursor motion
 * cheap for large SQL scripts while retaining enough context for normal blocks.
 */
export function sqlBlockMatchRanges(source: string | Text, cursors: readonly number[]): SqlBlockMatchToken[] {
  const ranges = new Map<string, SqlBlockMatchToken>();
  const length = sourceLength(source);
  const uniqueCursors = [...new Set(cursors)].slice(0, MAX_BLOCK_MATCH_CURSORS);

  for (const rawCursor of uniqueCursors) {
    const cursor = Math.max(0, Math.min(rawCursor, length));
    const windowFrom = Math.max(0, cursor - MAX_BLOCK_MATCH_SCAN_DISTANCE);
    const windowTo = Math.min(length, cursor + MAX_BLOCK_MATCH_SCAN_DISTANCE);
    const localSql = sourceSlice(source, windowFrom, windowTo);
    const localCursor = cursor - windowFrom;

    for (const pair of sqlBeginEndPairs(localSql)) {
      if (!tokenIsNearCursor(pair.begin, localCursor) && !tokenIsNearCursor(pair.end, localCursor)) continue;
      const begin = { ...pair.begin, from: pair.begin.from + windowFrom, to: pair.begin.to + windowFrom };
      const end = { ...pair.end, from: pair.end.from + windowFrom, to: pair.end.to + windowFrom };
      ranges.set(`${begin.from}:${begin.to}`, begin);
      ranges.set(`${end.from}:${end.to}`, end);
    }
  }

  return [...ranges.values()].sort((left, right) => left.from - right.from);
}

class SqlBlockMatchingPlugin {
  decorations: import("@codemirror/view").DecorationSet;

  constructor(view: EditorView) {
    this.decorations = this.decorationsFor(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet) this.decorations = this.decorationsFor(update.view);
  }

  private decorationsFor(view: EditorView) {
    const cursors = view.state.selection.ranges.filter((range) => range.empty).map((range) => range.head);
    const ranges = sqlBlockMatchRanges(view.state.doc, cursors);
    return Decoration.set(
      ranges.map((range) => Decoration.mark({ class: "cm-sql-block-match" }).range(range.from, range.to)),
      true,
    );
  }
}

const sqlBlockMatchingPlugin = ViewPlugin.fromClass(SqlBlockMatchingPlugin, {
  decorations: (value) => value.decorations,
});

export function sqlBlockMatching(): Extension {
  return sqlBlockMatchingPlugin;
}
