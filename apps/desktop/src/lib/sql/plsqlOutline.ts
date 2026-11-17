export type PlSqlOutlineKind = "package" | "package-body" | "procedure" | "function" | "cursor" | "type" | "variable" | "constant" | "exception" | "trigger";

export type PlSqlParameterMode = "IN" | "OUT" | "INOUT";

export interface PlSqlOutlineParameter {
  name: string;
  mode?: PlSqlParameterMode;
  dataType: string;
}

export interface PlSqlOutlineItem {
  id: string;
  name: string;
  kind: PlSqlOutlineKind;
  signature?: string;
  parameters?: PlSqlOutlineParameter[];
  line: number;
  endLine?: number;
  offset: number;
  isExecutableSubprogram: boolean;
  isForwardDeclaration?: boolean;
}

interface LexToken {
  kind: "word" | "quoted-ident" | "string" | "dollar" | "symbol" | "other";
  text: string;
  upper: string;
  value: string;
  offset: number;
  endOffset: number;
  line: number;
  endLine: number;
  innerText?: string;
  innerOffset?: number;
  innerLine?: number;
}

const TRANSACTION_BEGIN_FOLLOWERS = new Set([";", "TRAN", "TRANSACTION", "WORK", "CONCURRENTLY", "DEFERRED", "EXCLUSIVE", "IMMEDIATE", "ISOLATION"]);

const END_COMPOUND_SUFFIXES = new Set(["IF", "LOOP", "CASE"]);

const ROUTINE_MODIFIER_STOP_WORDS = new Set([
  "IS",
  "AS",
  "LANGUAGE",
  "IMMUTABLE",
  "STABLE",
  "VOLATILE",
  "STRICT",
  "SECURITY",
  "AUTHID",
  "DETERMINISTIC",
  "PIPELINED",
  "RESULT_CACHE",
  "PARALLEL",
  "COST",
  "ROWS",
  "SUPPORT",
  "TRANSFORM",
  "WINDOW",
  "LEAKPROOF",
  "CALLED",
  "SET",
  "FENCED",
  "SHIPPABLE",
  "PACKAGE",
  "BEGIN",
  "DECLARE",
]);

const NON_DECLARATION_LEADING_WORDS = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "WITH",
  "PERFORM",
  "RETURN",
  "RAISE",
  "IF",
  "ELSIF",
  "ELSEIF",
  "ELSE",
  "LOOP",
  "FOR",
  "WHILE",
  "CASE",
  "WHEN",
  "NULL",
  "OPEN",
  "FETCH",
  "CLOSE",
  "EXIT",
  "CONTINUE",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "EXECUTE",
  "CALL",
  "GRANT",
  "REVOKE",
  "ALTER",
  "DROP",
  "COMMENT",
  "CREATE",
  "TRUNCATE",
  "LOCK",
  "EXCEPTION",
  "PRAGMA",
  "SET",
  "INTO",
]);

function isIdentPart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$#\u0080-\uffff]/.test(ch);
}

function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_\u0080-\uffff]/.test(ch);
}

function matchingQuoteDelimiter(openChar: string): string {
  switch (openChar) {
    case "[":
      return "]";
    case "{":
      return "}";
    case "(":
      return ")";
    case "<":
      return ">";
    default:
      return openChar;
  }
}

function lexPlSql(source: string, baseOffset = 0, baseLine = 1): LexToken[] {
  const tokens: LexToken[] = [];
  const len = source.length;
  let index = 0;
  let line = baseLine;

  const advanceChar = (): string => {
    const ch = source[index++];
    if (ch === "\n") {
      line++;
    } else if (ch === "\r" && source[index] !== "\n") {
      line++;
    }
    return ch;
  };

  while (index < len) {
    const ch = source[index];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      advanceChar();
      continue;
    }

    // Single-line comment -- ...
    if (ch === "-" && source[index + 1] === "-") {
      while (index < len && source[index] !== "\n" && source[index] !== "\r") {
        index++;
      }
      continue;
    }

    // Nested block comment /* ... */
    if (ch === "/" && source[index + 1] === "*") {
      index += 2;
      let depth = 1;
      while (index < len && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth++;
          index += 2;
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth--;
          index += 2;
        } else {
          advanceChar();
        }
      }
      continue;
    }

    const startIndex = index;
    const startLine = line;

    // Oracle alternative quoting literal q'[...]' / Q'{...}'
    if ((ch === "q" || ch === "Q") && source[index + 1] === "'" && index + 2 < len && !isIdentPart(source[index - 1])) {
      index += 2;
      const openDelim = advanceChar();
      const closeDelim = matchingQuoteDelimiter(openDelim);
      while (index < len) {
        if (source[index] === closeDelim && source[index + 1] === "'") {
          index += 2;
          break;
        }
        advanceChar();
      }
      const text = source.slice(startIndex, index);
      tokens.push({
        kind: "string",
        text,
        upper: "",
        value: text,
        offset: baseOffset + startIndex,
        endOffset: baseOffset + index,
        line: startLine,
        endLine: line,
      });
      continue;
    }

    // Escape string literal E'...' / e'...'
    if ((ch === "e" || ch === "E") && source[index + 1] === "'" && !isIdentPart(source[index - 1])) {
      index += 2;
      while (index < len) {
        if (source[index] === "\\" && index + 1 < len) {
          advanceChar();
          advanceChar();
          continue;
        }
        if (source[index] === "'") {
          index++;
          if (source[index] === "'") {
            index++;
            continue;
          }
          break;
        }
        advanceChar();
      }
      const text = source.slice(startIndex, index);
      tokens.push({
        kind: "string",
        text,
        upper: "",
        value: text,
        offset: baseOffset + startIndex,
        endOffset: baseOffset + index,
        line: startLine,
        endLine: line,
      });
      continue;
    }

    // Standard single-quoted string literal '...'
    if (ch === "'") {
      index++;
      while (index < len) {
        if (source[index] === "'") {
          index++;
          if (source[index] === "'") {
            index++;
            continue;
          }
          break;
        }
        advanceChar();
      }
      const text = source.slice(startIndex, index);
      tokens.push({
        kind: "string",
        text,
        upper: "",
        value: text,
        offset: baseOffset + startIndex,
        endOffset: baseOffset + index,
        line: startLine,
        endLine: line,
      });
      continue;
    }

    // Double-quoted identifier "..."
    if (ch === '"') {
      index++;
      while (index < len) {
        if (source[index] === '"') {
          index++;
          if (source[index] === '"') {
            index++;
            continue;
          }
          break;
        }
        advanceChar();
      }
      const text = source.slice(startIndex, index);
      const inner = text.endsWith('"') && text.length >= 2 ? text.slice(1, -1).replace(/""/g, '"') : text.slice(1);
      tokens.push({
        kind: "quoted-ident",
        text,
        upper: inner.toUpperCase(),
        value: inner,
        offset: baseOffset + startIndex,
        endOffset: baseOffset + index,
        line: startLine,
        endLine: line,
      });
      continue;
    }

    // Dollar-quoted literal $tag$...$tag$ or $$...$$
    if (ch === "$" && !isIdentPart(source[index - 1])) {
      const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(index));
      if (tagMatch) {
        const tag = tagMatch[0];
        index += tag.length;
        const innerStartIndex = index;
        const innerStartLine = line;
        const closePos = source.indexOf(tag, innerStartIndex);
        if (closePos < 0) {
          while (index < len) advanceChar();
          const innerText = source.slice(innerStartIndex);
          const text = source.slice(startIndex, index);
          tokens.push({
            kind: "dollar",
            text,
            upper: "",
            value: innerText,
            offset: baseOffset + startIndex,
            endOffset: baseOffset + index,
            line: startLine,
            endLine: line,
            innerText,
            innerOffset: baseOffset + innerStartIndex,
            innerLine: innerStartLine,
          });
        } else {
          while (index < closePos) advanceChar();
          const innerText = source.slice(innerStartIndex, closePos);
          index += tag.length;
          const text = source.slice(startIndex, index);
          tokens.push({
            kind: "dollar",
            text,
            upper: "",
            value: innerText,
            offset: baseOffset + startIndex,
            endOffset: baseOffset + index,
            line: startLine,
            endLine: line,
            innerText,
            innerOffset: baseOffset + innerStartIndex,
            innerLine: innerStartLine,
          });
        }
        continue;
      }
    }

    // Word / unquoted identifier
    if (isIdentStart(ch)) {
      index++;
      while (index < len && isIdentPart(source[index])) {
        index++;
      }
      const text = source.slice(startIndex, index);
      tokens.push({
        kind: "word",
        text,
        upper: text.toUpperCase(),
        value: text,
        offset: baseOffset + startIndex,
        endOffset: baseOffset + index,
        line: startLine,
        endLine: line,
      });
      continue;
    }

    // Multi-character symbols
    const twoChar = source.slice(index, index + 2);
    if (twoChar === ":=" || twoChar === "=>" || twoChar === ".." || twoChar === "||" || twoChar === "<>" || twoChar === "!=" || twoChar === "<=" || twoChar === ">=" || twoChar === "::" || twoChar === "<<" || twoChar === ">>") {
      index += 2;
      tokens.push({
        kind: "symbol",
        text: twoChar,
        upper: twoChar,
        value: twoChar,
        offset: baseOffset + startIndex,
        endOffset: baseOffset + index,
        line: startLine,
        endLine: line,
      });
      continue;
    }

    // Single-character symbol / number / other
    if (/[0-9]/.test(ch)) {
      index++;
      while (index < len && /[0-9._eE+-]/.test(source[index])) {
        if (source[index] === "." && source[index + 1] === ".") break;
        if ((source[index] === "+" || source[index] === "-") && !/[eE]/.test(source[index - 1])) break;
        index++;
      }
      const text = source.slice(startIndex, index);
      tokens.push({
        kind: "other",
        text,
        upper: text.toUpperCase(),
        value: text,
        offset: baseOffset + startIndex,
        endOffset: baseOffset + index,
        line: startLine,
        endLine: line,
      });
      continue;
    }

    advanceChar();
    const text = source.slice(startIndex, index);
    tokens.push({
      kind: "symbol",
      text,
      upper: text,
      value: text,
      offset: baseOffset + startIndex,
      endOffset: baseOffset + index,
      line: startLine,
      endLine: line,
    });
  }

  return tokens;
}

function isIdentifierToken(token: LexToken | undefined): boolean {
  return token !== undefined && (token.kind === "word" || token.kind === "quoted-ident");
}

function isKeyword(token: LexToken | undefined, expectedUpper: string): boolean {
  return token !== undefined && token.kind === "word" && token.upper === expectedUpper;
}

function formatTokenSequenceCompact(tokens: readonly LexToken[]): string {
  if (tokens.length === 0) return "";
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i];
    const prev = tokens[i - 1];
    if (i > 0) {
      const noSpaceBefore =
        cur.text === "," ||
        cur.text === ")" ||
        cur.text === "]" ||
        cur.text === "." ||
        cur.text === "%" ||
        cur.text === "::" ||
        (cur.text === "(" && (prev.kind === "word" || prev.kind === "quoted-ident")) ||
        (cur.text === "[" && (prev.kind === "word" || prev.kind === "quoted-ident" || prev.text === "]"));
      const noSpaceAfterPrev = prev.text === "(" || prev.text === "[" || prev.text === "." || prev.text === "%" || prev.text === "::";
      if (!noSpaceBefore && !noSpaceAfterPrev) {
        out += " ";
      }
    }
    out += cur.text;
  }
  return out.trim();
}

function parseParameterSlice(paramTokens: readonly LexToken[], positionalIndex: number): PlSqlOutlineParameter | null {
  // Trim leading/trailing empty
  if (paramTokens.length === 0) return null;

  // Strip DEFAULT ... or := ... at parenDepth 0
  let depth = 0;
  let typeEnd = paramTokens.length;
  for (let i = 0; i < paramTokens.length; i++) {
    const t = paramTokens[i];
    if (t.text === "(" || t.text === "[") depth++;
    else if (t.text === ")" || t.text === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (t.text === ":=" || isKeyword(t, "DEFAULT"))) {
      typeEnd = i;
      break;
    }
  }

  const core = paramTokens.slice(0, typeEnd);
  if (core.length === 0) return null;

  let cursor = 0;
  let mode: PlSqlParameterMode | undefined;

  const consumeModeAt = (idx: number): { mode: PlSqlParameterMode; nextIdx: number } | null => {
    const first = core[idx];
    if (!first || first.kind !== "word") return null;
    if (first.upper === "IN") {
      if (isKeyword(core[idx + 1], "OUT")) {
        const after = isKeyword(core[idx + 2], "NOCOPY") ? idx + 3 : idx + 2;
        return { mode: "INOUT", nextIdx: after };
      }
      return { mode: "IN", nextIdx: idx + 1 };
    }
    if (first.upper === "OUT") {
      const after = isKeyword(core[idx + 1], "NOCOPY") ? idx + 2 : idx + 1;
      return { mode: "OUT", nextIdx: after };
    }
    if (first.upper === "INOUT") {
      const after = isKeyword(core[idx + 1], "NOCOPY") ? idx + 2 : idx + 1;
      return { mode: "INOUT", nextIdx: after };
    }
    if (first.upper === "VARIADIC") {
      return { mode: "IN", nextIdx: idx + 1 };
    }
    return null;
  };

  const isTypeOnlyTokens = (slice: readonly LexToken[]): boolean => {
    if (slice.length === 0) return false;
    if (slice.length === 1 || slice[1]?.text === "(" || slice[1]?.text === "[" || slice[1]?.text === "." || slice[1]?.text === "%") {
      return true;
    }
    return (
      (isKeyword(slice[0], "CHARACTER") && isKeyword(slice[1], "VARYING")) ||
      (isKeyword(slice[0], "DOUBLE") && isKeyword(slice[1], "PRECISION")) ||
      (isKeyword(slice[0], "TIMESTAMP") && (isKeyword(slice[1], "WITH") || isKeyword(slice[1], "WITHOUT"))) ||
      (isKeyword(slice[0], "TIME") && (isKeyword(slice[1], "WITH") || isKeyword(slice[1], "WITHOUT")))
    );
  };

  // Case A: Mode comes first (e.g., `IN p_id INT`, `OUT o_cnt INT`, `IN OUT io_x VARCHAR2`, `OUT INT`)
  const leadingMode = consumeModeAt(0);
  if (leadingMode) {
    mode = leadingMode.mode;
    cursor = leadingMode.nextIdx;
    const rest = core.slice(cursor);
    if (rest.length === 0) return null;
    // Check if rest is `<type>` only (e.g. `OUT integer`, `OUT character varying(50)`) vs `<name> <type>`
    if (isTypeOnlyTokens(rest)) {
      return {
        name: `$${positionalIndex}`,
        mode,
        dataType: formatTokenSequenceCompact(rest),
      };
    }
    if (isIdentifierToken(rest[0])) {
      const dataType = formatTokenSequenceCompact(rest.slice(1));
      if (dataType) {
        return {
          name: rest[0].value,
          mode,
          dataType,
        };
      }
    }
    return {
      name: `$${positionalIndex}`,
      mode,
      dataType: formatTokenSequenceCompact(rest),
    };
  }

  // Case B: Name comes first, optionally followed by mode (`p_id IN INT`, `o_cnt OUT INT`, `io_v IN OUT NOCOPY TEXT`, `p_id INT`)
  if (isIdentifierToken(core[0])) {
    const secondMode = consumeModeAt(1);
    if (secondMode) {
      const typeTokens = core.slice(secondMode.nextIdx);
      const dataType = formatTokenSequenceCompact(typeTokens);
      if (dataType) {
        return {
          name: core[0].value,
          mode: secondMode.mode,
          dataType,
        };
      }
    }

    // Type-only positional parameter (e.g. `CREATE FUNCTION f(integer, character varying(20))`)
    if (isTypeOnlyTokens(core)) {
      return {
        name: `$${positionalIndex}`,
        dataType: formatTokenSequenceCompact(core),
      };
    }

    const dataType = formatTokenSequenceCompact(core.slice(1));
    if (dataType) {
      return {
        name: core[0].value,
        dataType,
      };
    }
  }

  return null;
}

function formatSignatureFromParams(parameters: readonly PlSqlOutlineParameter[], returnType?: string): string {
  const rendered = parameters.map((p) => {
    const isPositional = /^\$\d+$/.test(p.name);
    const modePart = p.mode && p.mode !== "IN" ? `${p.mode} ` : "";
    if (isPositional) {
      return `${modePart}${p.dataType}`.trim();
    }
    if (p.mode && p.mode !== "IN") {
      return `${p.name} ${p.mode} ${p.dataType}`;
    }
    return `${p.name} ${p.dataType}`;
  });
  const base = `(${rendered.join(", ")})`;
  return returnType ? `${base} RETURN ${returnType}` : base;
}

type ScopeKind = "top" | "package" | "package-body" | "routine" | "block";

class OutlineParser {
  private items: PlSqlOutlineItem[] = [];
  private idCounter = 0;

  constructor(private readonly tokens: readonly LexToken[]) {}

  private nextId(kind: PlSqlOutlineKind, name: string, line: number): string {
    this.idCounter++;
    return `${kind}:${name}:${line}:${this.idCounter}`;
  }

  parseTopLevel(): PlSqlOutlineItem[] {
    let i = 0;
    while (i < this.tokens.length) {
      const tok = this.tokens[i];

      if (tok.text === ";") {
        i++;
        continue;
      }

      // Skip <<label>>
      if (tok.text === "<<" && isIdentifierToken(this.tokens[i + 1]) && this.tokens[i + 2]?.text === ">>") {
        i += 3;
        continue;
      }

      // DO [LANGUAGE lang] $body$ ... $body$
      if (isKeyword(tok, "DO")) {
        i = this.parseDoBlock(i);
        continue;
      }

      // CREATE [OR REPLACE] [EDITIONABLE|NONEDITIONABLE] [CONSTRAINT] PACKAGE / PROCEDURE / FUNCTION / TRIGGER / TYPE
      if (isKeyword(tok, "CREATE")) {
        const nextIdx = this.parseCreateStatement(i);
        if (nextIdx > i) {
          i = nextIdx;
          continue;
        }
      }

      // Bare PACKAGE [BODY] ... (without CREATE)
      if (isKeyword(tok, "PACKAGE")) {
        i = this.parsePackageUnit(i, tok.line, tok.offset);
        continue;
      }

      // Bare PROCEDURE / FUNCTION ... (without CREATE)
      if (isKeyword(tok, "PROCEDURE") || isKeyword(tok, "FUNCTION")) {
        i = this.parseRoutineUnit(i, tok.line, tok.offset, "top");
        continue;
      }

      // Bare TRIGGER ...
      if (isKeyword(tok, "TRIGGER")) {
        i = this.parseTriggerUnit(i, tok.line, tok.offset);
        continue;
      }

      // Top-level anonymous block: DECLARE ... BEGIN ... END;
      if (isKeyword(tok, "DECLARE")) {
        // Distinguish SQL `DECLARE cur CURSOR FOR ...` from PL/SQL `DECLARE ... BEGIN ... END`
        if (this.hasMatchingBeginAfterDeclare(i)) {
          i = this.parseAnonymousBlock(i);
          continue;
        }
      }

      // Top-level anonymous BEGIN ... END; (ignore transaction `BEGIN;`)
      if (isKeyword(tok, "BEGIN") && !this.isTransactionBegin(i)) {
        i = this.consumeBeginEndBlock(i);
        if (this.tokens[i]?.text === ";") i++;
        continue;
      }

      i++;
    }
    return this.items;
  }

  private isTransactionBegin(beginIdx: number): boolean {
    const next = this.tokens[beginIdx + 1];
    if (!next) return true;
    const key = next.kind === "symbol" ? next.text : next.upper;
    return TRANSACTION_BEGIN_FOLLOWERS.has(key);
  }

  private hasMatchingBeginAfterDeclare(declareIdx: number): boolean {
    // Check if `DECLARE <ident> [BINARY] [INSENSITIVE] [NO] [SCROLL] CURSOR` without `;` before `BEGIN`
    let depth = 0;
    let sawSemicolon = false;
    for (let j = declareIdx + 1; j < this.tokens.length; j++) {
      const t = this.tokens[j];
      if (t.text === "(") depth++;
      else if (t.text === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && t.text === ";") {
        sawSemicolon = true;
      } else if (depth === 0 && isKeyword(t, "BEGIN") && !this.isTransactionBegin(j)) {
        return sawSemicolon || j === declareIdx + 1;
      }
      if (!sawSemicolon && depth === 0 && isKeyword(t, "SELECT")) {
        return false;
      }
    }
    return false;
  }

  private readQualifiedName(startIdx: number): { name: string; nextIdx: number } | null {
    if (!isIdentifierToken(this.tokens[startIdx])) return null;
    let lastIdent = this.tokens[startIdx].value;
    let cursor = startIdx + 1;
    while (this.tokens[cursor]?.text === "." && isIdentifierToken(this.tokens[cursor + 1])) {
      lastIdent = this.tokens[cursor + 1].value;
      cursor += 2;
    }
    return { name: lastIdent, nextIdx: cursor };
  }

  private parseCreateStatement(createIdx: number): number {
    const startLine = this.tokens[createIdx].line;
    const startOffset = this.tokens[createIdx].offset;
    let cursor = createIdx + 1;

    if (isKeyword(this.tokens[cursor], "OR") && isKeyword(this.tokens[cursor + 1], "REPLACE")) {
      cursor += 2;
    }
    while (isKeyword(this.tokens[cursor], "EDITIONABLE") || isKeyword(this.tokens[cursor], "NONEDITIONABLE") || isKeyword(this.tokens[cursor], "CONSTRAINT") || isKeyword(this.tokens[cursor], "DEFINER")) {
      if (isKeyword(this.tokens[cursor], "DEFINER") && this.tokens[cursor + 1]?.text === "=") {
        cursor += 2;
        const q = this.readQualifiedName(cursor);
        cursor = q ? q.nextIdx : cursor + 1;
      } else {
        cursor++;
      }
    }

    const kw = this.tokens[cursor];
    if (!kw || kw.kind !== "word") return createIdx + 1;

    if (kw.upper === "PACKAGE") {
      return this.parsePackageUnit(cursor, startLine, startOffset);
    }
    if (kw.upper === "PROCEDURE" || kw.upper === "FUNCTION") {
      return this.parseRoutineUnit(cursor, startLine, startOffset, "top");
    }
    if (kw.upper === "TRIGGER") {
      return this.parseTriggerUnit(cursor, startLine, startOffset);
    }
    if (kw.upper === "TYPE") {
      return this.parseTopLevelTypeUnit(cursor, startLine, startOffset);
    }

    return cursor + 1;
  }

  private parseDoBlock(doIdx: number): number {
    let cursor = doIdx + 1;
    while (cursor < this.tokens.length && this.tokens[cursor].text !== ";") {
      const t = this.tokens[cursor];
      if (t.kind === "dollar" && t.innerText !== undefined) {
        this.scanDollarBody(t, "routine");
        cursor++;
        while (cursor < this.tokens.length && this.tokens[cursor].text !== ";") cursor++;
        if (this.tokens[cursor]?.text === ";") cursor++;
        return cursor;
      }
      cursor++;
    }
    if (this.tokens[cursor]?.text === ";") cursor++;
    return cursor;
  }

  private scanDollarBody(dollarToken: LexToken, bodyMode: "package" | "package-body" | "routine"): void {
    if (!dollarToken.innerText || dollarToken.innerOffset === undefined || dollarToken.innerLine === undefined) {
      return;
    }
    const innerTokens = lexPlSql(dollarToken.innerText, dollarToken.innerOffset, dollarToken.innerLine);
    if (innerTokens.length === 0) return;

    const subParser = new OutlineParser(innerTokens);
    subParser.idCounter = this.idCounter;

    if (bodyMode === "package" || bodyMode === "package-body") {
      // Check if inner text starts with `PACKAGE [BODY]` or directly with member declarations
      let idx = 0;
      if (isKeyword(innerTokens[idx], "DECLARE")) idx++;
      idx = subParser.parseDeclarationSection(idx, bodyMode);
      if (bodyMode === "package-body" && isKeyword(innerTokens[idx], "BEGIN") && !subParser.isTransactionBegin(idx)) {
        subParser.consumeBeginEndBlock(idx);
      }
    } else {
      // Routine or DO dollar-quoted body
      let idx = 0;
      if (innerTokens[idx]?.text === "<<" && isIdentifierToken(innerTokens[idx + 1]) && innerTokens[idx + 2]?.text === ">>") {
        idx += 3;
      }
      if (isKeyword(innerTokens[idx], "DECLARE")) {
        idx = subParser.parseDeclarationSection(idx + 1, "routine");
        if (isKeyword(innerTokens[idx], "BEGIN") && !subParser.isTransactionBegin(idx)) {
          subParser.consumeBeginEndBlock(idx);
        }
      } else if (isKeyword(innerTokens[idx], "BEGIN") && !subParser.isTransactionBegin(idx)) {
        subParser.consumeBeginEndBlock(idx);
      } else if (isIdentifierToken(innerTokens[idx]) && !NON_DECLARATION_LEADING_WORDS.has(innerTokens[idx].upper) && subParser.hasMatchingBeginAfterDeclare(idx - 1)) {
        idx = subParser.parseDeclarationSection(idx, "routine");
        if (isKeyword(innerTokens[idx], "BEGIN") && !subParser.isTransactionBegin(idx)) {
          subParser.consumeBeginEndBlock(idx);
        }
      }
    }

    this.idCounter = subParser.idCounter;
    this.items.push(...subParser.items);
  }

  private parsePackageUnit(pkgKwIdx: number, startLine: number, startOffset: number): number {
    let cursor = pkgKwIdx + 1;
    let isBody = false;
    if (isKeyword(this.tokens[cursor], "BODY")) {
      isBody = true;
      cursor++;
    }

    const qName = this.readQualifiedName(cursor);
    if (!qName) return cursor + 1;
    cursor = qName.nextIdx;

    const kind: PlSqlOutlineKind = isBody ? "package-body" : "package";
    const item: PlSqlOutlineItem = {
      id: this.nextId(kind, qName.name, startLine),
      name: qName.name,
      kind,
      line: startLine,
      offset: startOffset,
      isExecutableSubprogram: false,
    };
    this.items.push(item);

    // Skip AUTHID DEFINER / CURRENT_USER etc. until IS / AS / $dollar$ / ;
    while (cursor < this.tokens.length && !isKeyword(this.tokens[cursor], "IS") && !isKeyword(this.tokens[cursor], "AS") && this.tokens[cursor].kind !== "dollar" && this.tokens[cursor].text !== ";") {
      cursor++;
    }

    if (isKeyword(this.tokens[cursor], "IS") || isKeyword(this.tokens[cursor], "AS")) {
      cursor++;
    }

    // OpenGauss dollar-quoted package: `CREATE PACKAGE pkg AS $pkg$ ... $pkg$;`
    if (this.tokens[cursor]?.kind === "dollar") {
      const dollarTok = this.tokens[cursor];
      this.scanDollarBody(dollarTok, isBody ? "package-body" : "package");
      cursor++;
      let endLine = dollarTok.endLine;
      while (cursor < this.tokens.length && this.tokens[cursor].text !== ";") {
        endLine = this.tokens[cursor].endLine;
        cursor++;
      }
      if (this.tokens[cursor]?.text === ";") {
        endLine = this.tokens[cursor].endLine;
        cursor++;
      }
      item.endLine = endLine;
      return cursor;
    }

    // Standard Oracle/openGauss `PACKAGE [BODY] name IS ... [BEGIN ...] END [name];`
    cursor = this.parseDeclarationSection(cursor, isBody ? "package-body" : "package");

    // Optional initialization block in PACKAGE BODY: `BEGIN ... END [pkg_name];`
    if (isBody && isKeyword(this.tokens[cursor], "BEGIN") && !this.isTransactionBegin(cursor)) {
      cursor = this.consumeBeginEndBlock(cursor);
      if (this.tokens[cursor]?.text === ";") {
        item.endLine = this.tokens[cursor].endLine;
        cursor++;
      } else if (cursor > 0) {
        item.endLine = this.tokens[cursor - 1].endLine;
      }
      return cursor;
    }

    if (isKeyword(this.tokens[cursor], "END")) {
      let endLine = this.tokens[cursor].endLine;
      cursor++;
      if (isIdentifierToken(this.tokens[cursor]) && !END_COMPOUND_SUFFIXES.has(this.tokens[cursor].upper)) {
        endLine = this.tokens[cursor].endLine;
        cursor++;
      }
      if (this.tokens[cursor]?.text === ";") {
        endLine = this.tokens[cursor].endLine;
        cursor++;
      }
      item.endLine = endLine;
    } else if (cursor > pkgKwIdx) {
      item.endLine = this.tokens[Math.min(cursor, this.tokens.length - 1)].endLine;
    }

    return cursor;
  }

  private parseRoutineUnit(routineKwIdx: number, startLine: number, startOffset: number, scope: ScopeKind): number {
    const isFunction = isKeyword(this.tokens[routineKwIdx], "FUNCTION");
    const kind: PlSqlOutlineKind = isFunction ? "function" : "procedure";
    let cursor = routineKwIdx + 1;

    const qName = this.readQualifiedName(cursor);
    if (!qName) return cursor;
    cursor = qName.nextIdx;

    // Optional parameter list `( ... )`
    const parameters: PlSqlOutlineParameter[] = [];
    if (this.tokens[cursor]?.text === "(") {
      const parsed = this.parseParameterList(cursor);
      parameters.push(...parsed.parameters);
      cursor = parsed.nextIdx;
    }

    // Optional RETURN / RETURNS <type>
    let returnType: string | undefined;
    if (isKeyword(this.tokens[cursor], "RETURN") || isKeyword(this.tokens[cursor], "RETURNS")) {
      cursor++;
      if (isKeyword(this.tokens[cursor], "SETOF")) {
        const setofTok = this.tokens[cursor];
        cursor++;
        const innerType = this.readDataTypeTokens(cursor, true);
        returnType = innerType.tokens.length > 0 ? `SETOF ${formatTokenSequenceCompact(innerType.tokens)}` : setofTok.text;
        cursor = innerType.nextIdx;
      } else if (isKeyword(this.tokens[cursor], "TABLE") && this.tokens[cursor + 1]?.text === "(") {
        const tableStart = cursor;
        cursor += 2;
        let depth = 1;
        while (cursor < this.tokens.length && depth > 0) {
          if (this.tokens[cursor].text === "(") depth++;
          else if (this.tokens[cursor].text === ")") depth--;
          cursor++;
        }
        returnType = formatTokenSequenceCompact(this.tokens.slice(tableStart, cursor));
      } else {
        const rt = this.readDataTypeTokens(cursor, true);
        if (rt.tokens.length > 0) {
          returnType = formatTokenSequenceCompact(rt.tokens);
          cursor = rt.nextIdx;
        }
      }
    }

    const signature = formatSignatureFromParams(parameters, isFunction ? returnType : undefined);

    // Scan routine modifiers until `;`, `IS`, `AS`, `BEGIN`, or dollar-quote
    let sawBodyIntroducer = false;
    let bodyDollarToken: LexToken | undefined;
    let bodyStringToken: LexToken | undefined;

    while (cursor < this.tokens.length) {
      const t = this.tokens[cursor];
      if (t.text === ";") {
        break;
      }
      if (isKeyword(t, "IS") || isKeyword(t, "AS")) {
        sawBodyIntroducer = true;
        cursor++;
        if (this.tokens[cursor]?.kind === "dollar") {
          bodyDollarToken = this.tokens[cursor];
          cursor++;
        } else if (this.tokens[cursor]?.kind === "string") {
          bodyStringToken = this.tokens[cursor];
          cursor++;
        } else {
          // Procedural PL/SQL body starts here!
          break;
        }
        continue;
      }
      if (t.kind === "dollar") {
        sawBodyIntroducer = true;
        bodyDollarToken = t;
        cursor++;
        continue;
      }
      if (isKeyword(t, "BEGIN") && !this.isTransactionBegin(cursor)) {
        sawBodyIntroducer = true;
        break;
      }
      cursor++;
    }

    // Case 1: Terminated by `;` without body (Package Spec declaration OR Forward Declaration in Package Body / Routine)
    if (!sawBodyIntroducer) {
      let endLine = this.tokens[Math.max(routineKwIdx, cursor - 1)].endLine;
      if (this.tokens[cursor]?.text === ";") {
        endLine = this.tokens[cursor].endLine;
        cursor++;
      }
      const isForward = scope === "package-body" || scope === "routine";
      const item: PlSqlOutlineItem = {
        id: this.nextId(kind, qName.name, startLine),
        name: qName.name,
        kind,
        signature,
        parameters,
        line: startLine,
        endLine,
        offset: startOffset,
        isExecutableSubprogram: scope === "package" || scope === "top",
        ...(isForward ? { isForwardDeclaration: true } : {}),
      };
      this.items.push(item);
      return cursor;
    }

    // Case 2: Dollar-quoted or single-quoted routine body (`CREATE FUNCTION ... AS $$ ... $$ LANGUAGE plpgsql;`)
    if (bodyDollarToken || bodyStringToken) {
      const item: PlSqlOutlineItem = {
        id: this.nextId(kind, qName.name, startLine),
        name: qName.name,
        kind,
        signature,
        parameters,
        line: startLine,
        offset: startOffset,
        isExecutableSubprogram: scope === "top" || scope === "package" || scope === "package-body",
      };
      this.items.push(item);

      if (bodyDollarToken) {
        this.scanDollarBody(bodyDollarToken, "routine");
      }

      let endLine = (bodyDollarToken ?? bodyStringToken)!.endLine;
      while (cursor < this.tokens.length && this.tokens[cursor].text !== ";") {
        // Stop if another CREATE starts without semicolon
        if (isKeyword(this.tokens[cursor], "CREATE")) break;
        endLine = this.tokens[cursor].endLine;
        cursor++;
      }
      if (this.tokens[cursor]?.text === ";") {
        endLine = this.tokens[cursor].endLine;
        cursor++;
      }
      item.endLine = endLine;
      return cursor;
    }

    // Case 3: Inline PL/SQL body (`IS/AS [DECLARE] <decls> BEGIN <stmts> END [name];`)
    const item: PlSqlOutlineItem = {
      id: this.nextId(kind, qName.name, startLine),
      name: qName.name,
      kind,
      signature,
      parameters,
      line: startLine,
      offset: startOffset,
      isExecutableSubprogram: scope === "top" || scope === "package" || scope === "package-body",
    };
    this.items.push(item);

    if (isKeyword(this.tokens[cursor], "DECLARE")) {
      cursor++;
    }

    if (!isKeyword(this.tokens[cursor], "BEGIN")) {
      cursor = this.parseDeclarationSection(cursor, "routine");
    }

    if (isKeyword(this.tokens[cursor], "BEGIN") && !this.isTransactionBegin(cursor)) {
      cursor = this.consumeBeginEndBlock(cursor);
    }

    let endLine = this.tokens[Math.max(routineKwIdx, cursor - 1)].endLine;
    if (this.tokens[cursor]?.text === ";") {
      endLine = this.tokens[cursor].endLine;
      cursor++;
    }
    item.endLine = endLine;
    return cursor;
  }

  private parseTriggerUnit(triggerKwIdx: number, startLine: number, startOffset: number): number {
    let cursor = triggerKwIdx + 1;
    const qName = this.readQualifiedName(cursor);
    if (!qName) return cursor;
    cursor = qName.nextIdx;

    const item: PlSqlOutlineItem = {
      id: this.nextId("trigger", qName.name, startLine),
      name: qName.name,
      kind: "trigger",
      line: startLine,
      offset: startOffset,
      isExecutableSubprogram: false,
    };
    this.items.push(item);

    // Scan trigger header until DECLARE, BEGIN, dollar-quote, or `;`
    while (cursor < this.tokens.length) {
      const t = this.tokens[cursor];
      if (t.text === ";") {
        item.endLine = t.endLine;
        return cursor + 1;
      }
      if (t.kind === "dollar") {
        this.scanDollarBody(t, "routine");
        cursor++;
        let endLine = t.endLine;
        while (cursor < this.tokens.length && this.tokens[cursor].text !== ";") {
          endLine = this.tokens[cursor].endLine;
          cursor++;
        }
        if (this.tokens[cursor]?.text === ";") {
          endLine = this.tokens[cursor].endLine;
          cursor++;
        }
        item.endLine = endLine;
        return cursor;
      }
      if (isKeyword(t, "DECLARE")) {
        cursor = this.parseDeclarationSection(cursor + 1, "routine");
        if (isKeyword(this.tokens[cursor], "BEGIN") && !this.isTransactionBegin(cursor)) {
          cursor = this.consumeBeginEndBlock(cursor);
        }
        let endLine = this.tokens[Math.max(triggerKwIdx, cursor - 1)].endLine;
        if (this.tokens[cursor]?.text === ";") {
          endLine = this.tokens[cursor].endLine;
          cursor++;
        }
        item.endLine = endLine;
        return cursor;
      }
      if (isKeyword(t, "BEGIN") && !this.isTransactionBegin(cursor)) {
        cursor = this.consumeBeginEndBlock(cursor);
        let endLine = this.tokens[Math.max(triggerKwIdx, cursor - 1)].endLine;
        if (this.tokens[cursor]?.text === ";") {
          endLine = this.tokens[cursor].endLine;
          cursor++;
        }
        item.endLine = endLine;
        return cursor;
      }
      cursor++;
    }

    item.endLine = this.tokens[this.tokens.length - 1]?.endLine ?? startLine;
    return cursor;
  }

  private parseTopLevelTypeUnit(typeKwIdx: number, startLine: number, startOffset: number): number {
    let cursor = typeKwIdx + 1;
    if (isKeyword(this.tokens[cursor], "BODY")) {
      cursor++;
    }
    const qName = this.readQualifiedName(cursor);
    if (!qName) return cursor;
    cursor = qName.nextIdx;

    const item: PlSqlOutlineItem = {
      id: this.nextId("type", qName.name, startLine),
      name: qName.name,
      kind: "type",
      line: startLine,
      offset: startOffset,
      isExecutableSubprogram: false,
    };
    this.items.push(item);

    let depth = 0;
    let endLine = startLine;
    while (cursor < this.tokens.length) {
      const t = this.tokens[cursor];
      endLine = t.endLine;
      if (t.text === "(") depth++;
      else if (t.text === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && t.text === ";") {
        cursor++;
        break;
      }
      cursor++;
    }
    item.endLine = endLine;
    return cursor;
  }

  private parseAnonymousBlock(declareIdx: number): number {
    let cursor = this.parseDeclarationSection(declareIdx + 1, "block");
    if (isKeyword(this.tokens[cursor], "BEGIN") && !this.isTransactionBegin(cursor)) {
      cursor = this.consumeBeginEndBlock(cursor);
    }
    if (this.tokens[cursor]?.text === ";") cursor++;
    return cursor;
  }

  private parseParameterList(openParenIdx: number): { parameters: PlSqlOutlineParameter[]; nextIdx: number } {
    const parameters: PlSqlOutlineParameter[] = [];
    let cursor = openParenIdx + 1;
    let depth = 1;
    let segStart = cursor;
    let posIndex = 1;

    while (cursor < this.tokens.length && depth > 0) {
      const t = this.tokens[cursor];
      if (t.text === "(") {
        depth++;
      } else if (t.text === ")") {
        depth--;
        if (depth === 0) {
          const slice = this.tokens.slice(segStart, cursor);
          const param = parseParameterSlice(slice, posIndex);
          if (param) {
            parameters.push(param);
            posIndex++;
          }
          cursor++;
          break;
        }
      } else if (depth === 1 && t.text === ",") {
        const slice = this.tokens.slice(segStart, cursor);
        const param = parseParameterSlice(slice, posIndex);
        if (param) {
          parameters.push(param);
          posIndex++;
        }
        segStart = cursor + 1;
      }
      cursor++;
    }

    return { parameters, nextIdx: cursor };
  }

  private readDataTypeTokens(startIdx: number, inRoutineHeader = false): { tokens: LexToken[]; nextIdx: number } {
    const result: LexToken[] = [];
    let cursor = startIdx;
    let depth = 0;

    while (cursor < this.tokens.length) {
      const t = this.tokens[cursor];
      if (depth === 0) {
        if (t.text === ";" || t.text === ":=" || t.text === "," || t.kind === "dollar") break;
        if (isKeyword(t, "DEFAULT") || isKeyword(t, "COLLATE")) break;
        if (isKeyword(t, "NOT") && isKeyword(this.tokens[cursor + 1], "NULL")) break;
        if (isKeyword(t, "NOT") && isKeyword(this.tokens[cursor + 1], "LEAKPROOF")) break;
        if (inRoutineHeader && t.kind === "word" && ROUTINE_MODIFIER_STOP_WORDS.has(t.upper)) break;
        if (inRoutineHeader && isKeyword(t, "RETURNS") && isKeyword(this.tokens[cursor + 1], "NULL")) break;
      }
      if (t.text === "(" || t.text === "[") depth++;
      else if (t.text === ")" || t.text === "]") {
        if (depth === 0) break;
        depth--;
      }
      result.push(t);
      cursor++;
    }

    return { tokens: result, nextIdx: cursor };
  }

  private parseDeclarationSection(startIdx: number, scope: ScopeKind): number {
    let cursor = startIdx;

    while (cursor < this.tokens.length) {
      const tok = this.tokens[cursor];

      if (tok.text === ";") {
        cursor++;
        continue;
      }

      if (tok.text === "<<" && isIdentifierToken(this.tokens[cursor + 1]) && this.tokens[cursor + 2]?.text === ">>") {
        cursor += 3;
        continue;
      }

      // End of declaration section
      if (isKeyword(tok, "BEGIN") && !this.isTransactionBegin(cursor)) {
        return cursor;
      }
      if (isKeyword(tok, "END") && !END_COMPOUND_SUFFIXES.has(this.tokens[cursor + 1]?.upper ?? "")) {
        return cursor;
      }

      // PRAGMA ...;
      if (isKeyword(tok, "PRAGMA")) {
        cursor = this.skipToSemicolonOrBoundary(cursor + 1);
        continue;
      }

      // Member or nested PROCEDURE / FUNCTION
      if (isKeyword(tok, "PROCEDURE") || isKeyword(tok, "FUNCTION")) {
        cursor = this.parseRoutineUnit(cursor, tok.line, tok.offset, scope);
        continue;
      }

      // Oracle-style CURSOR: `CURSOR cur_name [(params)] [RETURN type] [IS select...];`
      if (isKeyword(tok, "CURSOR")) {
        cursor = this.parseOracleCursorDecl(cursor);
        continue;
      }

      // TYPE / SUBTYPE declaration
      if (isKeyword(tok, "TYPE") || isKeyword(tok, "SUBTYPE")) {
        cursor = this.parseTypeDecl(cursor);
        continue;
      }

      // Identifier-led declaration: cursor, exception, constant, or variable
      if (isIdentifierToken(tok) && !NON_DECLARATION_LEADING_WORDS.has(tok.upper)) {
        cursor = this.parseIdentifierLedDeclaration(cursor);
        continue;
      }

      cursor = this.skipToSemicolonOrBoundary(cursor + 1);
    }

    return cursor;
  }

  private parseOracleCursorDecl(cursorKwIdx: number): number {
    const startToken = this.tokens[cursorKwIdx];
    let cursor = cursorKwIdx + 1;
    if (!isIdentifierToken(this.tokens[cursor])) {
      return this.skipToSemicolonOrBoundary(cursor);
    }
    const nameTok = this.tokens[cursor];
    cursor++;

    let parameters: PlSqlOutlineParameter[] | undefined;
    if (this.tokens[cursor]?.text === "(") {
      const parsed = this.parseParameterList(cursor);
      parameters = parsed.parameters;
      cursor = parsed.nextIdx;
    }

    let returnType: string | undefined;
    if (isKeyword(this.tokens[cursor], "RETURN")) {
      const rt = this.readDataTypeTokens(cursor + 1, true);
      if (rt.tokens.length > 0) {
        returnType = formatTokenSequenceCompact(rt.tokens);
        cursor = rt.nextIdx;
      }
    }

    const endIdx = this.skipToSemicolonOrBoundary(cursor);
    const endLine = this.tokens[Math.max(cursorKwIdx, endIdx - 1)]?.endLine ?? startToken.endLine;
    const signature = parameters ? formatSignatureFromParams(parameters, returnType) : returnType ? `RETURN ${returnType}` : undefined;

    this.items.push({
      id: this.nextId("cursor", nameTok.value, startToken.line),
      name: nameTok.value,
      kind: "cursor",
      ...(signature ? { signature } : {}),
      ...(parameters ? { parameters } : {}),
      line: startToken.line,
      endLine,
      offset: startToken.offset,
      isExecutableSubprogram: false,
    });
    return endIdx;
  }

  private parseTypeDecl(typeKwIdx: number): number {
    const startToken = this.tokens[typeKwIdx];
    const isSubtype = isKeyword(startToken, "SUBTYPE");
    let cursor = typeKwIdx + 1;

    if (!isIdentifierToken(this.tokens[cursor])) {
      return this.skipToSemicolonOrBoundary(cursor);
    }
    const nameTok = this.tokens[cursor];
    cursor++;

    let signature: string | undefined;
    if (isKeyword(this.tokens[cursor], "IS") || isKeyword(this.tokens[cursor], "AS")) {
      cursor++;
      const previewTokens: LexToken[] = [];
      let scan = cursor;
      while (scan < this.tokens.length && this.tokens[scan].text !== ";" && previewTokens.length < 6) {
        if (this.tokens[scan].text === "(" && isKeyword(this.tokens[cursor], "RECORD")) {
          break;
        }
        previewTokens.push(this.tokens[scan]);
        scan++;
      }
      const compact = formatTokenSequenceCompact(previewTokens);
      if (compact) {
        signature = isSubtype ? `SUBTYPE ${compact}` : compact;
      }
    }

    const endIdx = this.skipToSemicolonOrBoundary(cursor);
    const endLine = this.tokens[Math.max(typeKwIdx, endIdx - 1)]?.endLine ?? startToken.endLine;

    this.items.push({
      id: this.nextId("type", nameTok.value, startToken.line),
      name: nameTok.value,
      kind: "type",
      ...(signature ? { signature } : {}),
      line: startToken.line,
      endLine,
      offset: startToken.offset,
      isExecutableSubprogram: false,
    });
    return endIdx;
  }

  private parseIdentifierLedDeclaration(identIdx: number): number {
    const identTok = this.tokens[identIdx];
    let cursor = identIdx + 1;
    const next = this.tokens[cursor];

    if (!next || next.text === ";" || next.text === "(" || next.text === ":=" || next.text === ".") {
      return this.skipToSemicolonOrBoundary(cursor);
    }

    // PL/pgSQL cursor declaration: `cur_name [[NO] SCROLL] CURSOR [(params)] FOR ...;`
    let cursorCheckIdx = cursor;
    if (isKeyword(this.tokens[cursorCheckIdx], "NO") && isKeyword(this.tokens[cursorCheckIdx + 1], "SCROLL")) {
      cursorCheckIdx += 2;
    } else if (isKeyword(this.tokens[cursorCheckIdx], "SCROLL")) {
      cursorCheckIdx += 1;
    }
    if (isKeyword(this.tokens[cursorCheckIdx], "CURSOR")) {
      cursor = cursorCheckIdx + 1;
      let parameters: PlSqlOutlineParameter[] | undefined;
      if (this.tokens[cursor]?.text === "(") {
        const parsed = this.parseParameterList(cursor);
        parameters = parsed.parameters;
        cursor = parsed.nextIdx;
      }
      const endIdx = this.skipToSemicolonOrBoundary(cursor);
      const endLine = this.tokens[Math.max(identIdx, endIdx - 1)]?.endLine ?? identTok.endLine;
      const signature = parameters ? formatSignatureFromParams(parameters) : undefined;
      this.items.push({
        id: this.nextId("cursor", identTok.value, identTok.line),
        name: identTok.value,
        kind: "cursor",
        ...(signature ? { signature } : {}),
        ...(parameters ? { parameters } : {}),
        line: identTok.line,
        endLine,
        offset: identTok.offset,
        isExecutableSubprogram: false,
      });
      return endIdx;
    }

    // Exception declaration: `e_invalid EXCEPTION;`
    if (isKeyword(next, "EXCEPTION") && this.tokens[cursor + 1]?.text === ";") {
      const semi = this.tokens[cursor + 1];
      this.items.push({
        id: this.nextId("exception", identTok.value, identTok.line),
        name: identTok.value,
        kind: "exception",
        line: identTok.line,
        endLine: semi.endLine,
        offset: identTok.offset,
        isExecutableSubprogram: false,
      });
      return cursor + 2;
    }

    // ALIAS FOR $1 -> skip cleanly
    if (isKeyword(next, "ALIAS") && isKeyword(this.tokens[cursor + 1], "FOR")) {
      return this.skipToSemicolonOrBoundary(cursor + 2);
    }

    // Constant declaration: `c_tax CONSTANT NUMERIC(5,2) := 0.13;`
    let isConstant = false;
    if (isKeyword(next, "CONSTANT")) {
      isConstant = true;
      cursor++;
    }

    const dataTypeParsed = this.readDataTypeTokens(cursor, false);
    const dataType = formatTokenSequenceCompact(dataTypeParsed.tokens);
    const endIdx = this.skipToSemicolonOrBoundary(dataTypeParsed.nextIdx);
    const endLine = this.tokens[Math.max(identIdx, endIdx - 1)]?.endLine ?? identTok.endLine;

    if (dataType) {
      const kind: PlSqlOutlineKind = isConstant ? "constant" : "variable";
      this.items.push({
        id: this.nextId(kind, identTok.value, identTok.line),
        name: identTok.value,
        kind,
        signature: dataType,
        line: identTok.line,
        endLine,
        offset: identTok.offset,
        isExecutableSubprogram: false,
      });
    }

    return endIdx;
  }

  private skipToSemicolonOrBoundary(startIdx: number): number {
    let cursor = startIdx;
    let depth = 0;
    while (cursor < this.tokens.length) {
      const t = this.tokens[cursor];
      if (t.text === "(") depth++;
      else if (t.text === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0) {
        if (t.text === ";") return cursor + 1;
        if (isKeyword(t, "BEGIN") && !this.isTransactionBegin(cursor)) return cursor;
        if (isKeyword(t, "END") && !END_COMPOUND_SUFFIXES.has(this.tokens[cursor + 1]?.upper ?? "")) return cursor;
      }
      cursor++;
    }
    return cursor;
  }

  private consumeBeginEndBlock(beginIdx: number): number {
    const stack: Array<"begin" | "case"> = ["begin"];
    let cursor = beginIdx + 1;

    while (cursor < this.tokens.length && stack.length > 0) {
      const tok = this.tokens[cursor];
      const prev = this.tokens[cursor - 1];
      const next = this.tokens[cursor + 1];

      if (prev?.text === "." || next?.text === ".") {
        cursor++;
        continue;
      }

      // Nested `DECLARE ... BEGIN ... END;` inside statements
      if (isKeyword(tok, "DECLARE") && this.hasMatchingBeginAfterDeclare(cursor)) {
        cursor = this.parseDeclarationSection(cursor + 1, "block");
        continue;
      }

      if (isKeyword(tok, "CASE")) {
        stack.push("case");
        cursor++;
        continue;
      }

      if (isKeyword(tok, "BEGIN") && !this.isTransactionBegin(cursor)) {
        stack.push("begin");
        cursor++;
        continue;
      }

      if (isKeyword(tok, "END")) {
        const suffix = next?.kind === "word" ? next.upper : undefined;
        if (suffix && END_COMPOUND_SUFFIXES.has(suffix)) {
          if (suffix === "CASE" && stack[stack.length - 1] === "case") {
            stack.pop();
          }
          cursor += 2;
          continue;
        }

        const top = stack.pop();
        cursor++;
        if (top === "begin") {
          // Optional label after `END <label>`
          if (isIdentifierToken(this.tokens[cursor]) && !END_COMPOUND_SUFFIXES.has(this.tokens[cursor].upper) && this.tokens[cursor + 1]?.text === ";") {
            cursor++;
          }
          if (stack.length === 0) {
            return cursor;
          }
        }
        continue;
      }

      cursor++;
    }

    return cursor;
  }
}

export function parsePlSqlOutline(source: string): PlSqlOutlineItem[] {
  if (!source.trim()) return [];
  const tokens = lexPlSql(source, 0, 1);
  if (tokens.length === 0) return [];
  const parser = new OutlineParser(tokens);
  return parser.parseTopLevel();
}

function formatPlSqlIdentifier(ident: string): string {
  if (!ident) return ident;
  if (/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(ident)) {
    return ident;
  }
  return `"${ident.replace(/"/g, '""')}"`;
}

function normalizePlSqlDeclarationType(rawType: string): string {
  const trimmed = rawType.trim();
  const upper = trimmed.toUpperCase();
  if (upper === "VARCHAR2" || upper === "NVARCHAR2" || upper === "VARCHAR") {
    return `${trimmed}(4000)`;
  }
  if (upper === "CHAR" || upper === "NCHAR") {
    return `${trimmed}(255)`;
  }
  return trimmed || "TEXT";
}

export function buildPackageMemberCallSql(options: { schema?: string; packageName: string; item: PlSqlOutlineItem }): string {
  const { schema, packageName, item } = options;
  const parts = [...(schema ? [formatPlSqlIdentifier(schema)] : []), formatPlSqlIdentifier(packageName), formatPlSqlIdentifier(item.name)];
  const qualifiedTarget = parts.join(".");
  const params = item.parameters ?? [];
  const hasOutParam = params.some((p) => p.mode === "OUT" || p.mode === "INOUT");
  const isFunction = item.kind === "function";
  const headerComment = `-- ${qualifiedTarget}${item.signature ?? "()"}`;

  if (params.length === 0) {
    return isFunction ? `${headerComment}\nSELECT ${qualifiedTarget}();` : `${headerComment}\nCALL ${qualifiedTarget}();`;
  }

  if (!hasOutParam) {
    const argLines = params.map((p, idx) => {
      const comma = idx < params.length - 1 ? "," : "";
      return `  NULL${comma} /* ${p.name}: ${p.dataType} */`;
    });
    const callExpr = `${qualifiedTarget}(\n${argLines.join("\n")}\n)`;
    return isFunction ? `${headerComment}\nSELECT ${callExpr};` : `${headerComment}\nCALL ${callExpr};`;
  }

  // Has OUT or INOUT parameters -> generate executable anonymous block
  const declLines: string[] = [];
  const callArgs: string[] = [];
  const outVars: Array<{ paramName: string; varName: string }> = [];

  params.forEach((p, idx) => {
    const comma = idx < params.length - 1 ? "," : "";
    if (p.mode === "OUT" || p.mode === "INOUT") {
      const cleanParam = p.name.replace(/^\$/, "p_");
      const varName = `v_${cleanParam}`;
      const declType = normalizePlSqlDeclarationType(p.dataType);
      const initPart = p.mode === "INOUT" ? " := NULL" : "";
      declLines.push(`  ${varName} ${declType}${initPart};`);
      callArgs.push(`    ${varName}${comma} /* ${p.mode} ${p.dataType} */`);
      outVars.push({ paramName: p.name, varName });
    } else {
      callArgs.push(`    NULL${comma} /* ${p.name}: ${p.dataType} */`);
    }
  });

  if (isFunction) {
    declLines.unshift("  v_result TEXT;");
  }

  const invokeStmt = isFunction ? `  v_result := ${qualifiedTarget}(\n${callArgs.join("\n")}\n  );` : `  ${qualifiedTarget}(\n${callArgs.join("\n")}\n  );`;

  const noticePlaceholders = [...(isFunction ? ["result = %"] : []), ...outVars.map((o) => `${o.paramName} = %`)].join(", ");
  const noticeArgs = [...(isFunction ? ["v_result"] : []), ...outVars.map((o) => o.varName)].join(", ");

  return [headerComment, "DECLARE", ...declLines, "BEGIN", invokeStmt, `  RAISE NOTICE '${noticePlaceholders}', ${noticeArgs};`, "END;"].join("\n");
}
