import type { Extension, Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

export type SqlBlockKeyword = "BEGIN" | "END" | "CASE" | "IF" | "LOOP" | "ELSIF" | "ELSEIF" | "ELSE" | "WHEN";

export interface SqlBlockMatchToken {
  from: number;
  to: number;
  word: SqlBlockKeyword;
}

export interface SqlBeginEndPair {
  begin: SqlBlockMatchToken;
  end: SqlBlockMatchToken;
  branches?: SqlBlockMatchToken[];
}

const BLOCK_WORDS = new Set(["BEGIN", "END", "CASE", "IF", "LOOP", "ELSIF", "ELSEIF", "ELSE", "WHEN"]);
const END_SUFFIXES = new Set(["CASE", "IF", "LOOP", "TRY", "CATCH", "FOR", "REPEAT", "WHILE"]);
const TRANSACTION_BEGIN_WORDS = new Set(["CONCURRENTLY", "DEFERRED", "EXCLUSIVE", "IMMEDIATE", "ISOLATION", "TRAN", "TRANSACTION", "WORK"]);
const MAX_BLOCK_MATCH_SCAN_DISTANCE = 20_000;
const MAX_BLOCK_MATCH_CURSORS = 8;

interface SqlBlockLexeme {
  from: number;
  to: number;
  word: string;
}

function skipQuotedText(sql: string, start: number, quote: string): number {
  let index = start + 1;
  const close = quote === "[" ? "]" : quote;
  while (index < sql.length) {
    if (sql[index] === close) {
      if (sql[index + 1] === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/** Lexical matching also works where the SQL grammar has no procedural nodes. */
function sqlBlockLexemes(sql: string): SqlBlockLexeme[] {
  const tokens: SqlBlockLexeme[] = [];
  let index = 0;
  let bodyDelimiter: string | undefined;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if ((char === "-" && next === "-") || char === "#") {
      const newline = sql.indexOf("\n", index);
      index = newline < 0 ? sql.length : newline;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      let depth = 1;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      continue;
    }
    const from = index;
    if (char === "$" && /^\$[A-Za-z_0-9]*\$/.test(sql.slice(index))) {
      const marker = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index))![0];
      if (marker === bodyDelimiter) {
        bodyDelimiter = undefined;
        index += marker.length;
      } else if (!bodyDelimiter && (tokens[tokens.length - 1]?.word === "AS" || tokens[tokens.length - 1]?.word === "DO")) {
        // Routine bodies are code; other dollar-quoted values are strings.
        bodyDelimiter = marker;
        index += marker.length;
      } else {
        const close = sql.indexOf(marker, index + marker.length);
        index = close < 0 ? sql.length : close + marker.length;
        tokens.push({ from, to: index, word: "<literal>" });
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      index = skipQuotedText(sql, index, char);
      tokens.push({ from, to: index, word: "<literal>" });
      continue;
    }
    index += 1;
    if (/[A-Za-z_]/.test(char)) {
      while (/[A-Za-z0-9_$]/.test(sql[index] ?? "")) index += 1;
    }
    tokens.push({ from, to: index, word: sql.slice(from, index).toUpperCase() });
  }
  return tokens;
}

export function sqlBeginEndTokens(sql: string): SqlBlockMatchToken[] {
  return sqlBlockLexemes(sql).filter((token) => BLOCK_WORDS.has(token.word)) as SqlBlockMatchToken[];
}

function isConditionalIf(tokens: readonly SqlBlockLexeme[], index: number): boolean {
  const previous = tokens[index - 1]?.word;
  // IF() expressions and CREATE ... IF EXISTS are not procedural blocks.
  if (previous && ![";", "BEGIN", "THEN", "ELSE", "LOOP", ">"].includes(previous)) return false;
  let parentheses = 0;
  let cases = 0;
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const word = tokens[cursor]!.word;
    if (word === ";" || word === "BEGIN") return false;
    if (word === "(") parentheses += 1;
    else if (word === ")") parentheses -= 1;
    else if (word === "CASE") cases += 1;
    else if (word === "END" && cases) cases -= 1;
    else if (word === "THEN" && parentheses === 0 && cases === 0) return true;
  }
  return false;
}

interface SqlBlockStackToken extends SqlBlockMatchToken {
  endWord?: "TRY" | "CATCH";
  branches: SqlBlockMatchToken[];
}

export function sqlBeginEndPairs(sql: string): SqlBeginEndPair[] {
  const stack: SqlBlockStackToken[] = [];
  const pairs: SqlBeginEndPair[] = [];
  const tokens = sqlBlockLexemes(sql);
  for (let index = 0; index < tokens.length; index += 1) {
    const lexeme = tokens[index]!;
    if (!BLOCK_WORDS.has(lexeme.word)) continue;
    const token = lexeme as SqlBlockMatchToken;
    const nextWord = tokens[index + 1]?.word;
    // Qualified names such as app.if(...) must never open a block.
    if (tokens[index - 1]?.word === "." || nextWord === ".") continue;
    if (token.word === "BEGIN") {
      if (!TRANSACTION_BEGIN_WORDS.has(nextWord ?? "") && nextWord !== ";") {
        stack.push({ ...token, endWord: nextWord === "TRY" || nextWord === "CATCH" ? nextWord : undefined, branches: [] });
      }
      continue;
    }
    if (token.word === "CASE" || token.word === "LOOP" || (token.word === "IF" && isConditionalIf(tokens, index))) {
      stack.push({ ...token, branches: [] });
      continue;
    }
    const top = stack[stack.length - 1];
    if (token.word === "ELSE" || token.word === "ELSIF" || token.word === "ELSEIF" || token.word === "WHEN") {
      if ((top?.word === "IF" && token.word !== "WHEN") || (top?.word === "CASE" && (token.word === "WHEN" || token.word === "ELSE"))) {
        top.branches.push(token);
      }
      continue;
    }
    if (token.word !== "END") continue;
    const suffix = END_SUFFIXES.has(nextWord ?? "") ? tokens[++index] : undefined;
    const matches = suffix ? top?.word === suffix.word || (top?.word === "BEGIN" && top.endWord === suffix.word) : (top?.word === "BEGIN" && !top.endWord) || top?.word === "CASE";
    if (matches && top) {
      stack.pop();
      const { branches, endWord: _endWord, ...begin } = top;
      pairs.push({ begin, end: { ...token, to: suffix?.to ?? token.to }, ...(branches.length ? { branches } : {}) });
    }
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
      const members = [pair.begin, ...(pair.branches ?? []), pair.end];
      if (!members.some((token) => tokenIsNearCursor(token, localCursor))) continue;
      for (const member of members) {
        const range = { ...member, from: member.from + windowFrom, to: member.to + windowFrom };
        ranges.set(`${range.from}:${range.to}`, range);
      }
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
