/**
 * Statement-level SQL text helpers for DDL display.
 *
 * The DDL dialog can hide `COMMENT ON ...` statements (the "显示注释" toggle).
 * Stripping must be literal-safe: comment text may contain semicolons,
 * newlines, quotes, dollar-quoted bodies, or lines that look like SQL, so a
 * regex over lines is not enough — statements are split with a small scanner
 * that tracks string/identifier/dollar/comment regions.
 */

/** Skip a single-quoted string starting at `start` (text[start] === '\''). Returns the index after the closing quote. */
function skipSingleQuoted(text: string, start: number, backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < text.length) {
    if (backslashEscapes && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "'") {
      // Doubled quote is an escape.
      if (text[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return text.length;
}

/** Skip a double-quoted/backtick identifier starting at `start`. Returns the index after the closing quote. */
function skipQuotedIdentifier(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return text.length;
}

/** Skip a (possibly nested) block comment starting at `start` (`/*`). Returns the index after the closing marker. */
function skipBlockComment(text: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < text.length && depth > 0) {
    if (text[i] === "/" && text[i + 1] === "*") {
      depth++;
      i += 2;
      continue;
    }
    if (text[i] === "*" && text[i + 1] === "/") {
      depth--;
      i += 2;
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Skip a dollar-quoted body starting at `start` when text[start] opens a
 * `$tag$` delimiter. Returns the index after the closing delimiter, or
 * `start + 1` when the `$` does not open a valid delimiter.
 */
function skipDollarQuoted(text: string, start: number): number {
  // A delimiter is `$` followed by zero+ identifier chars then `$`.
  if (start > 0 && /[\w$]/.test(text[start - 1])) return start + 1;
  let end = start + 1;
  while (end < text.length && /[\w]/.test(text[end])) end++;
  if (text[end] !== "$") return start + 1;
  const tag = text.slice(start, end + 1);
  const close = text.indexOf(tag, end + 1);
  return close < 0 ? text.length : close + tag.length;
}

/** Detect whether a single quote at `start` opens an E'...' string (backslash escapes enabled). */
function isEStringQuote(text: string, start: number): boolean {
  if (start === 0) return false;
  const prev = text[start - 1];
  if (prev !== "e" && prev !== "E") return false;
  return start < 2 || !/[\w$]/.test(text[start - 2]);
}

/**
 * Split a SQL script into top-level statements at `;` boundaries, keeping the
 * terminating semicolon in each piece. Literal strings, quoted identifiers,
 * dollar-quoted bodies and line/block comments never split a statement.
 * The trailing fragment (no semicolon) is kept when it is not blank.
 */
export function splitTopLevelSqlStatements(text: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      i = skipSingleQuoted(text, i, isEStringQuote(text, i));
      continue;
    }
    if (ch === '"' || ch === "`") {
      i = skipQuotedIdentifier(text, i, ch);
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      const newline = text.indexOf("\n", i + 2);
      i = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = skipBlockComment(text, i);
      continue;
    }
    if (ch === "$") {
      i = skipDollarQuoted(text, i);
      continue;
    }
    if (ch === ";") {
      statements.push(text.slice(start, i + 1));
      start = i + 1;
    }
    i++;
  }
  const tail = text.slice(start);
  if (tail.trim()) statements.push(tail);
  return statements;
}

/**
 * Remove top-level `COMMENT ON ...` statements (PostgreSQL/openGauss comment
 * DDL) from a DDL script. Everything else is preserved verbatim, so toggling
 * comments off never touches structural statements.
 */
export function stripCommentOnStatements(ddl: string): string {
  return splitTopLevelSqlStatements(ddl)
    .filter((statement) => !/^\s*comment\s+on\s/i.test(statement))
    .map((statement) => statement.trim())
    .join("\n");
}
