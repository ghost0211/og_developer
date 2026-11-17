import type { SqlFormatDialect } from "./sqlFormatter";

interface ProceduralToken {
  text: string;
  kind: "word" | "symbol" | "literal" | "comment";
  from: number;
  to: number;
  line: number;
}

interface ProceduralBlock {
  beginIndex: number;
  endIndex: number;
  beginLine: number;
  endLine: number;
}

interface DeclarationSection {
  declareIndex: number;
  beginIndex: number;
  declareLine: number;
  beginLine: number;
}

interface ProceduralAnalysis {
  tokens: ProceduralToken[];
  blocks: ProceduralBlock[];
  sections: DeclarationSection[];
  bodyAsIndexes: Set<number>;
}

interface TextEdit {
  from: number;
  to: number;
  text: string;
}

const TRANSACTION_BEGIN_WORDS = new Set([";", "TRAN", "TRANSACTION", "WORK", "CONCURRENTLY", "DEFERRED", "EXCLUSIVE", "IMMEDIATE", "ISOLATION", "TRY", "CATCH"]);
const END_SUFFIXES = new Set(["IF", "LOOP", "CASE"]);

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[\w$#]/.test(character);
}

function matchingOracleQuoteClose(openChar: string): string {
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

/** PostgreSQL/openGauss lexer for layout decisions only. Dollar-quoted routine
 * bodies are single literal tokens at the outer level and can be inspected
 * explicitly by `formatDollarQuotedProceduralBodies`. */
function lexProceduralSql(sql: string): ProceduralToken[] {
  const tokens: ProceduralToken[] = [];
  let index = 0;
  let line = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (/\s/.test(character)) {
      if (character === "\n") line++;
      index++;
      continue;
    }

    const from = index;
    const tokenLine = line;
    const next = sql[index + 1];
    let kind: ProceduralToken["kind"] = "symbol";

    if (character === "-" && next === "-") {
      kind = "comment";
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index++;
    } else if (character === "/" && next === "*") {
      kind = "comment";
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth++;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
    } else if ((character === "q" || character === "Q") && next === "'" && index + 2 < sql.length && !isIdentifierPart(sql[from - 1])) {
      kind = "literal";
      const closeDelim = matchingOracleQuoteClose(sql[index + 2]);
      index += 3;
      while (index < sql.length) {
        if (sql[index] === closeDelim && sql[index + 1] === "'") {
          index += 2;
          break;
        }
        index++;
      }
    } else if (character === "'" || character === '"' || character === "`") {
      kind = "literal";
      const escaped = character === "'" && /[eE]/.test(sql[from - 1] ?? "") && !isIdentifierPart(sql[from - 2]);
      index++;
      while (index < sql.length) {
        if (escaped && sql[index] === "\\") {
          index = Math.min(sql.length, index + 2);
        } else if (sql[index] === character) {
          index++;
          if (sql[index] === character) index++;
          else break;
        } else {
          index++;
        }
      }
    } else if (character === "$" && !isIdentifierPart(sql[from - 1])) {
      const marker = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(index))?.[0];
      if (marker) {
        kind = "literal";
        const close = sql.indexOf(marker, index + marker.length);
        index = close < 0 ? sql.length : close + marker.length;
      } else {
        index++;
      }
    } else if (/[A-Za-z_\u0080-\uffff]/.test(character)) {
      kind = "word";
      index++;
      while (index < sql.length && /[\w$#\u0080-\uffff]/.test(sql[index])) index++;
    } else {
      const twoChar = sql.slice(index, index + 2);
      if (twoChar === ":=" || twoChar === "=>" || twoChar === ".." || twoChar === "<<" || twoChar === ">>" || twoChar === "<>" || twoChar === "!=" || twoChar === "<=" || twoChar === ">=" || twoChar === "||" || twoChar === "::") {
        index += 2;
      } else {
        index++;
      }
    }

    const text = sql.slice(from, index);
    tokens.push({ text, kind, from, to: index, line: tokenLine });
    for (const textCharacter of text) if (textCharacter === "\n") line++;
  }
  return tokens;
}

function word(token: ProceduralToken | undefined): string | undefined {
  return token?.kind === "word" ? token.text.toUpperCase() : undefined;
}

function isIdentOrWord(token: ProceduralToken | undefined): boolean {
  if (!token) return false;
  if (token.kind === "word") return true;
  return token.kind === "literal" && token.text.startsWith('"');
}

function nextSignificant(tokens: readonly ProceduralToken[], index: number): number | undefined {
  for (let cursor = index + 1; cursor < tokens.length; cursor++) {
    if (tokens[cursor].kind !== "comment") return cursor;
  }
  return undefined;
}

function previousSignificant(tokens: readonly ProceduralToken[], index: number): number | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (tokens[cursor].kind !== "comment") return cursor;
  }
  return undefined;
}

function isTransactionBeginAt(tokens: readonly ProceduralToken[], index: number): boolean {
  const nextIdx = nextSignificant(tokens, index);
  const next = nextIdx === undefined ? undefined : tokens[nextIdx];
  const follower = next?.kind === "symbol" ? next.text : word(next);
  return TRANSACTION_BEGIN_WORDS.has(follower ?? "");
}

/** Pair procedural BEGIN/END while ignoring transactions. CASE uses the same
 * lexical stack so a BEGIN block nested inside a CASE branch cannot be closed
 * by the CASE's END (or vice versa). */
function findProceduralBlocks(tokens: readonly ProceduralToken[]): ProceduralBlock[] | null {
  const stack: Array<{ type: "begin" | "case"; index: number }> = [];
  const blocks: ProceduralBlock[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const name = word(token);
    if (!name) continue;
    const previousIndex = previousSignificant(tokens, index);
    const nextIndex = nextSignificant(tokens, index);
    const previous = previousIndex === undefined ? undefined : tokens[previousIndex];
    const next = nextIndex === undefined ? undefined : tokens[nextIndex];
    if (previous?.text === "." || next?.text === ".") continue;

    if (name === "CASE") {
      stack.push({ type: "case", index });
      continue;
    }

    if (name === "BEGIN") {
      const follower = next?.kind === "symbol" ? next.text : word(next);
      if (!TRANSACTION_BEGIN_WORDS.has(follower ?? "")) stack.push({ type: "begin", index });
      continue;
    }

    if (name !== "END") continue;
    const suffix = word(next);
    if (suffix && END_SUFFIXES.has(suffix)) {
      if (suffix === "CASE") {
        const open = stack.pop();
        if (open?.type !== "case") return null;
      }
      index = nextIndex!; // consume END IF / END LOOP / END CASE as one token pair
      continue;
    }
    const open = stack.pop();
    if (!open) return null;
    if (open.type === "case") continue;
    blocks.push({ beginIndex: open.index, endIndex: index, beginLine: tokens[open.index].line, endLine: token.line });
  }

  return stack.length === 0 ? blocks : null;
}

function findDeclarationSections(tokens: readonly ProceduralToken[], blockBeginIndexes: ReadonlySet<number>): DeclarationSection[] {
  const sections: DeclarationSection[] = [];
  const claimedBeginIndexes = new Set<number>();

  for (let declareIndex = 0; declareIndex < tokens.length; declareIndex++) {
    if (word(tokens[declareIndex]) !== "DECLARE") continue;
    let depth = 0;
    let sawSemicolon = false;
    let beginIndex: number | undefined;

    for (let cursor = declareIndex + 1; cursor < tokens.length; cursor++) {
      const token = tokens[cursor];
      if (token.kind === "comment") continue;
      if (token.text === "(") depth++;
      else if (token.text === ")") depth = Math.max(0, depth - 1);

      if (depth === 0 && word(token) === "BEGIN") {
        if (sawSemicolon && blockBeginIndexes.has(cursor) && !claimedBeginIndexes.has(cursor)) beginIndex = cursor;
        break;
      }
      if (depth !== 0 || token.text !== ";") continue;
      sawSemicolon = true;
    }

    if (beginIndex === undefined) continue;
    claimedBeginIndexes.add(beginIndex);
    sections.push({ declareIndex, beginIndex, declareLine: tokens[declareIndex].line, beginLine: tokens[beginIndex].line });
  }
  return sections;
}

function hasRoutineCreateBefore(tokens: readonly ProceduralToken[], index: number): boolean {
  let sawCreate = false;
  let sawRoutine = false;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const token = tokens[cursor];
    if (token.text === ";") break;
    const name = word(token);
    if (name === "PROCEDURE" || name === "FUNCTION") sawRoutine = true;
    if (name === "CREATE") {
      sawCreate = true;
      break;
    }
  }
  return sawCreate && sawRoutine;
}

function findBodyAsIndexes(tokens: readonly ProceduralToken[], blocks: readonly ProceduralBlock[], sections: readonly DeclarationSection[]): Set<number> {
  const blockBeginIndexes = new Set(blocks.map((block) => block.beginIndex));
  const sectionDeclareIndexes = new Set(sections.map((section) => section.declareIndex));
  const result = new Set<number>();
  for (let index = 0; index < tokens.length; index++) {
    if (word(tokens[index]) !== "AS" || !hasRoutineCreateBefore(tokens, index)) continue;
    const nextIndex = nextSignificant(tokens, index);
    const nextWord = word(nextIndex === undefined ? undefined : tokens[nextIndex]);
    if ((nextWord === "DECLARE" && sectionDeclareIndexes.has(nextIndex!)) || (nextWord === "BEGIN" && blockBeginIndexes.has(nextIndex!))) result.add(index);
  }
  return result;
}

function analyze(sql: string): ProceduralAnalysis | null {
  const tokens = lexProceduralSql(sql);
  const blocks = findProceduralBlocks(tokens);
  if (!blocks?.length) return null;
  const blockBeginIndexes = new Set(blocks.map((block) => block.beginIndex));
  const sections = findDeclarationSections(tokens, blockBeginIndexes);
  const bodyAsIndexes = findBodyAsIndexes(tokens, blocks, sections);
  return { tokens, blocks, sections, bodyAsIndexes };
}

function addSplitEdit(sql: string, edits: TextEdit[], left: ProceduralToken, right: ProceduralToken, newline: string): void {
  if (left.line !== right.line || left.to > right.from) return;
  const between = sql.slice(left.to, right.from);
  if (between.includes("\n") || between.includes("\r")) return;
  edits.push({ from: left.to, to: right.from, text: newline });
}

function applyEdits(sql: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return sql;
  let result = sql;
  const dedup = new Map<string, TextEdit>();
  for (const edit of edits) {
    dedup.set(`${edit.from}:${edit.to}`, edit);
  }
  const sorted = [...dedup.values()].sort((left, right) => right.from - left.from);
  let lastFrom = Infinity;
  for (const edit of sorted) {
    if (edit.to > lastFrom) continue;
    result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
    lastFrom = edit.from;
  }
  return result;
}

function splitStructuralLines(sql: string, analysis: ProceduralAnalysis): string {
  const edits: TextEdit[] = [];
  const { tokens, blocks, sections, bodyAsIndexes } = analysis;
  const newline = sql.includes("\r\n") ? "\r\n" : "\n";

  for (const asIndex of bodyAsIndexes) {
    const asToken = tokens[asIndex];
    const previousIndex = asIndex > 0 ? asIndex - 1 : undefined;
    const nextIndex = asIndex + 1 < tokens.length ? asIndex + 1 : undefined;
    if (previousIndex !== undefined && tokens[previousIndex].kind !== "comment") addSplitEdit(sql, edits, tokens[previousIndex], asToken, newline);
    if (nextIndex !== undefined && tokens[nextIndex].kind !== "comment") {
      if (word(tokens[nextIndex]) === "DECLARE") {
        // openGauss examples conventionally write the routine body introducer as
        // `AS DECLARE`; keep that compound header and break after DECLARE.
        edits.push({ from: asToken.to, to: tokens[nextIndex].from, text: " " });
      } else {
        addSplitEdit(sql, edits, asToken, tokens[nextIndex], newline);
      }
    }
  }

  for (const section of sections) {
    const declareToken = tokens[section.declareIndex];
    const beginToken = tokens[section.beginIndex];
    const declarationIndex = section.declareIndex + 1 < tokens.length ? section.declareIndex + 1 : undefined;
    const beforeBeginIndex = section.beginIndex > 0 ? section.beginIndex - 1 : undefined;
    if (declarationIndex !== undefined && tokens[declarationIndex].kind !== "comment") addSplitEdit(sql, edits, declareToken, tokens[declarationIndex], newline);
    if (beforeBeginIndex !== undefined && tokens[beforeBeginIndex].kind !== "comment") addSplitEdit(sql, edits, tokens[beforeBeginIndex], beginToken, newline);
  }

  for (const block of blocks) {
    const beginToken = tokens[block.beginIndex];
    const endToken = tokens[block.endIndex];
    const bodyIndex = block.beginIndex + 1 < tokens.length ? block.beginIndex + 1 : undefined;
    const beforeEndIndex = block.endIndex > 0 ? block.endIndex - 1 : undefined;
    if (bodyIndex !== undefined && bodyIndex !== block.endIndex && tokens[bodyIndex].kind !== "comment") addSplitEdit(sql, edits, beginToken, tokens[bodyIndex], newline);
    if (beforeEndIndex !== undefined && beforeEndIndex !== block.beginIndex && tokens[beforeEndIndex].kind !== "comment") addSplitEdit(sql, edits, tokens[beforeEndIndex], endToken, newline);
  }

  return applyEdits(sql, edits);
}

function lineLevel(line: number, blocks: readonly ProceduralBlock[], sections: readonly DeclarationSection[]): number {
  let level = 0;
  for (const block of blocks) if (block.beginLine < line && block.endLine > line) level++;
  for (const section of sections) if (section.declareLine < line && section.beginLine > line) level++;
  return level;
}

function indentProceduralLines(sql: string, analysis: ProceduralAnalysis, unit: string): string {
  const rawLines = sql.split("\n");
  const frozen = Array.from({ length: rawLines.length }, () => false);
  for (const token of analysis.tokens) {
    if ((token.kind !== "literal" && token.kind !== "comment") || !token.text.includes("\n")) continue;
    const lineCount = token.text.split("\n").length;
    for (let offset = 0; offset < lineCount && token.line + offset < frozen.length; offset++) frozen[token.line + offset] = true;
  }

  let result = "";
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index];
    const hasCarriageReturn = raw.endsWith("\r");
    const text = hasCarriageReturn ? raw.slice(0, -1) : raw;
    const ending = index === rawLines.length - 1 ? "" : hasCarriageReturn ? "\r\n" : "\n";
    const level = lineLevel(index, analysis.blocks, analysis.sections);
    if (!text.trim() && level > 0 && !frozen[index]) continue;
    const prefix = level > 0 && text && !frozen[index] ? unit.repeat(level) : "";
    result += prefix + text + ending;
  }
  return result;
}

function sameTokenBytes(before: readonly ProceduralToken[], after: readonly ProceduralToken[]): boolean {
  return before.length === after.length && before.every((token, index) => token.kind === after[index].kind && token.text === after[index].text);
}

/**
 * sql-formatter's PostgreSQL grammar formats procedural statements as separate
 * top-level commands. It therefore puts the first variable after DECLARE and
 * leaves BEGIN...END bodies at column zero. This pass restores only the block
 * skeleton and indentation; all literal/comment/token bytes are verified before
 * the result is accepted.
 */
export function formatProceduralSqlBlocks(sql: string, options: { useTabs?: boolean; tabWidth?: number } = {}, dialect: SqlFormatDialect = "generic"): string {
  if (dialect !== "postgres" || /\/\*\s*sql-formatter-disable\s*\*\//i.test(sql)) return sql;
  const initial = analyze(sql);
  if (!initial) return sql;
  const split = splitStructuralLines(sql, initial);
  const splitAnalysis = analyze(split);
  if (!splitAnalysis) return sql;
  const unit = options.useTabs ? "\t" : " ".repeat(options.tabWidth === 4 ? 4 : 2);
  const result = indentProceduralLines(split, splitAnalysis, unit);
  return sameTokenBytes(initial.tokens, lexProceduralSql(result)) ? result : sql;
}

// ============================================================================
// Enhanced PL/SQL & Package Formatter (Oracle-compatible openGauss + $tag$ bodies)
// ============================================================================

type PlSqlFrame =
  | { kind: "package"; phase: "decl" | "body" | "exception"; inWhen: boolean; baseLevel: number }
  | { kind: "routine"; phase: "decl" | "body" | "exception"; inWhen: boolean; baseLevel: number }
  | { kind: "block"; phase: "decl" | "body" | "exception"; inWhen: boolean; baseLevel: number }
  | { kind: "if"; baseLevel: number }
  | { kind: "loop"; baseLevel: number }
  | { kind: "case-stmt"; inBranch: boolean; baseLevel: number }
  | { kind: "case-expr"; baseLevel: number };

function isDeclarationPhaseFrame(frame: PlSqlFrame | undefined): boolean {
  return frame !== undefined && (frame.kind === "package" || frame.kind === "routine" || frame.kind === "block") && frame.phase === "decl";
}

function activeLevel(stack: readonly PlSqlFrame[]): number {
  const top = stack[stack.length - 1];
  if (!top) return 0;
  switch (top.kind) {
    case "package":
    case "routine":
    case "block":
      if (top.phase === "exception") {
        return top.inWhen ? top.baseLevel + 2 : top.baseLevel + 1;
      }
      return top.baseLevel + 1;
    case "if":
    case "loop":
    case "case-expr":
      return top.baseLevel + 1;
    case "case-stmt":
      return top.inBranch ? top.baseLevel + 2 : top.baseLevel + 1;
  }
}

function isStatementBoundaryPrev(tokens: readonly ProceduralToken[], index: number): boolean {
  const prevIdx = previousSignificant(tokens, index);
  if (prevIdx === undefined) return true;
  const prev = tokens[prevIdx];
  if (prev.text === ";" || prev.text === ">>") return true;
  const pw = word(prev);
  return pw === "BEGIN" || pw === "THEN" || pw === "ELSE" || pw === "LOOP" || pw === "DECLARE" || pw === "IS" || pw === "AS" || pw === "EXCEPTION";
}

function isCreateHeaderPrefix(tokens: readonly ProceduralToken[], targetIdx: number): boolean {
  let cursor = targetIdx - 1;
  while (cursor >= 0) {
    const t = tokens[cursor];
    if (t.kind === "comment") {
      cursor--;
      continue;
    }
    const w = word(t);
    if (w === "REPLACE" || w === "OR" || w === "EDITIONABLE" || w === "NONEDITIONABLE" || w === "CONSTRAINT") {
      cursor--;
      continue;
    }
    if (w === "CREATE") return true;
    return false;
  }
  return false;
}

function findCreateStartBefore(tokens: readonly ProceduralToken[], targetIdx: number): number {
  let cursor = targetIdx - 1;
  let createIdx = targetIdx;
  while (cursor >= 0) {
    const t = tokens[cursor];
    if (t.kind === "comment") {
      cursor--;
      continue;
    }
    const w = word(t);
    if (w === "REPLACE" || w === "OR" || w === "EDITIONABLE" || w === "NONEDITIONABLE" || w === "CONSTRAINT") {
      cursor--;
      continue;
    }
    if (w === "CREATE") {
      createIdx = cursor;
    }
    break;
  }
  return createIdx;
}

function hasDeclareBeginAt(tokens: readonly ProceduralToken[], declareIdx: number): boolean {
  let depth = 0;
  let sawSemi = false;
  for (let i = declareIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "comment") continue;
    if (t.text === "(") depth++;
    else if (t.text === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && t.text === ";") sawSemi = true;
    else if (depth === 0 && word(t) === "BEGIN" && !isTransactionBeginAt(tokens, i)) {
      return sawSemi || nextSignificant(tokens, declareIdx) === i;
    }
    if (!sawSemi && depth === 0 && word(t) === "SELECT") return false;
  }
  return false;
}

function isExceptionSectionAt(tokens: readonly ProceduralToken[], index: number, stack: readonly PlSqlFrame[]): boolean {
  const top = stack[stack.length - 1];
  if (!top || (top.kind !== "routine" && top.kind !== "block" && top.kind !== "package")) return false;
  if (top.phase !== "body") return false;
  const prevIdx = previousSignificant(tokens, index);
  if (prevIdx !== undefined && word(tokens[prevIdx]) === "RAISE") return false;
  const nextIdx = nextSignificant(tokens, index);
  return nextIdx !== undefined && word(tokens[nextIdx]) === "WHEN";
}

interface PlSqlLayoutPlan {
  splitBefore: Set<number>;
  splitAfter: Set<number>;
  lineIndents: number[];
}

function buildPlSqlLayoutPlan(tokens: readonly ProceduralToken[], totalLines: number, initialFrames: readonly PlSqlFrame[] = []): PlSqlLayoutPlan {
  const splitBefore = new Set<number>();
  const splitAfter = new Set<number>();
  const lineIndents = Array.from({ length: totalLines }, () => -1);
  const stack: PlSqlFrame[] = initialFrames.map((f) => ({ ...f }));

  let parenDepth = 0;
  let inStatement = false;
  let statementBaseLevel = 0;

  const recordLineIndent = (line: number, level: number) => {
    if (line >= 0 && line < lineIndents.length && lineIndents[line] < 0) {
      lineIndents[line] = Math.max(0, level);
    }
  };

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok.kind === "comment") {
      recordLineIndent(tok.line, activeLevel(stack) + parenDepth);
      i++;
      continue;
    }

    const w = word(tok);
    const prevIdx = previousSignificant(tokens, i);
    const nextIdx = nextSignificant(tokens, i);
    const prev = prevIdx === undefined ? undefined : tokens[prevIdx];
    const next = nextIdx === undefined ? undefined : tokens[nextIdx];
    const isDotQualified = prev?.text === "." || next?.text === ".";

    // Handle parentheses first for multi-line parameter lists / expressions
    if (tok.text === "(") {
      if (!inStatement) {
        statementBaseLevel = activeLevel(stack);
        inStatement = true;
      }
      recordLineIndent(tok.line, activeLevel(stack) + parenDepth);
      parenDepth++;
      i++;
      continue;
    }
    if (tok.text === ")") {
      const closeLevel = activeLevel(stack) + Math.max(0, parenDepth - 1);
      recordLineIndent(tok.line, closeLevel);
      parenDepth = Math.max(0, parenDepth - 1);
      i++;
      continue;
    }

    // Semicolon at depth 0 ends a statement
    if (parenDepth === 0 && tok.text === ";") {
      recordLineIndent(tok.line, inStatement ? statementBaseLevel : activeLevel(stack));
      splitAfter.add(i);
      inStatement = false;
      i++;
      continue;
    }

    // Labels `<<label>>`
    if (parenDepth === 0 && tok.text === "<<" && isIdentOrWord(tokens[i + 1]) && tokens[i + 2]?.text === ">>") {
      const lvl = activeLevel(stack);
      recordLineIndent(tok.line, lvl);
      splitBefore.add(i);
      splitAfter.add(i + 2);
      inStatement = false;
      i += 3;
      continue;
    }

    if (parenDepth === 0 && !isDotQualified && w) {
      // 1. PACKAGE / PACKAGE BODY header
      if (w === "PACKAGE" && (isCreateHeaderPrefix(tokens, i) || isStatementBoundaryPrev(tokens, i))) {
        const headerStart = findCreateStartBefore(tokens, i);
        const headerLevel = activeLevel(stack);
        recordLineIndent(tokens[headerStart].line, headerLevel);
        recordLineIndent(tok.line, headerLevel);
        if (headerStart === i) splitBefore.add(i);

        let scan = i + 1;
        while (scan < tokens.length) {
          const st = tokens[scan];
          if (st.kind === "comment") {
            recordLineIndent(st.line, headerLevel);
            scan++;
            continue;
          }
          recordLineIndent(st.line, headerLevel);
          const sw = word(st);
          if (st.text === ";") {
            splitAfter.add(scan);
            inStatement = false;
            i = scan + 1;
            break;
          }
          if (sw === "IS" || sw === "AS") {
            const afterIsIdx = nextSignificant(tokens, scan);
            const afterIs = afterIsIdx === undefined ? undefined : tokens[afterIsIdx];
            if (afterIs?.kind === "literal") {
              // Dollar-quoted package body (`AS $pkg$ ... $pkg$;`)
              scan = afterIsIdx! + 1;
              while (scan < tokens.length && tokens[scan].text !== ";") {
                recordLineIndent(tokens[scan].line, headerLevel);
                scan++;
              }
              if (tokens[scan]?.text === ";") {
                recordLineIndent(tokens[scan].line, headerLevel);
                splitAfter.add(scan);
                scan++;
              }
              inStatement = false;
              i = scan;
              break;
            }
            splitAfter.add(scan);
            stack.push({ kind: "package", phase: "decl", inWhen: false, baseLevel: headerLevel });
            inStatement = false;
            i = scan + 1;
            break;
          }
          scan++;
        }
        if (scan >= tokens.length) break;
        continue;
      }

      // 2. PROCEDURE / FUNCTION header (top-level, package member, or nested routine)
      if ((w === "PROCEDURE" || w === "FUNCTION") && (isCreateHeaderPrefix(tokens, i) || (isStatementBoundaryPrev(tokens, i) && (stack.length === 0 || stack[stack.length - 1].kind === "package" || isDeclarationPhaseFrame(stack[stack.length - 1]))))) {
        const headerStart = findCreateStartBefore(tokens, i);
        const headerLevel = activeLevel(stack);
        recordLineIndent(tokens[headerStart].line, headerLevel);
        recordLineIndent(tok.line, headerLevel);
        if (headerStart === i) splitBefore.add(i);

        let scan = i + 1;
        let pDepth = 0;
        while (scan < tokens.length) {
          const st = tokens[scan];
          if (st.kind === "comment") {
            recordLineIndent(st.line, headerLevel + pDepth);
            scan++;
            continue;
          }
          if (st.text === "(") {
            recordLineIndent(st.line, headerLevel + pDepth);
            pDepth++;
            scan++;
            continue;
          }
          if (st.text === ")") {
            recordLineIndent(st.line, headerLevel + Math.max(0, pDepth - 1));
            pDepth = Math.max(0, pDepth - 1);
            scan++;
            continue;
          }
          recordLineIndent(st.line, headerLevel + pDepth);

          if (pDepth === 0) {
            const sw = word(st);
            if (st.text === ";") {
              // Forward declaration or package spec signature
              splitAfter.add(scan);
              inStatement = false;
              i = scan + 1;
              break;
            }
            if (sw === "IS" || sw === "AS") {
              const afterIdx = nextSignificant(tokens, scan);
              const afterTok = afterIdx === undefined ? undefined : tokens[afterIdx];
              if (afterTok?.kind === "literal") {
                // Dollar-quoted or string-quoted routine body
                scan = afterIdx! + 1;
                while (scan < tokens.length && tokens[scan].text !== ";") {
                  recordLineIndent(tokens[scan].line, headerLevel);
                  scan++;
                }
                if (tokens[scan]?.text === ";") {
                  recordLineIndent(tokens[scan].line, headerLevel);
                  splitAfter.add(scan);
                  scan++;
                }
                inStatement = false;
                i = scan;
                break;
              }
              if (word(afterTok) === "DECLARE") {
                recordLineIndent(afterTok!.line, headerLevel);
                splitAfter.add(afterIdx!);
                stack.push({ kind: "routine", phase: "decl", inWhen: false, baseLevel: headerLevel });
                inStatement = false;
                i = afterIdx! + 1;
                break;
              }
              splitAfter.add(scan);
              stack.push({ kind: "routine", phase: "decl", inWhen: false, baseLevel: headerLevel });
              inStatement = false;
              i = scan + 1;
              break;
            }
          }
          scan++;
        }
        if (scan >= tokens.length) break;
        continue;
      }

      // 3. DECLARE block opener
      if (w === "DECLARE" && isStatementBoundaryPrev(tokens, i) && hasDeclareBeginAt(tokens, i)) {
        const top = stack[stack.length - 1];
        if (top && (top.kind === "routine" || top.kind === "block") && top.phase === "decl") {
          recordLineIndent(tok.line, top.baseLevel);
          splitAfter.add(i);
        } else {
          const baseLevel = activeLevel(stack);
          recordLineIndent(tok.line, baseLevel);
          splitBefore.add(i);
          splitAfter.add(i);
          stack.push({ kind: "block", phase: "decl", inWhen: false, baseLevel });
        }
        inStatement = false;
        i++;
        continue;
      }

      // 4. BEGIN procedural block opener
      if (w === "BEGIN" && !isTransactionBeginAt(tokens, i)) {
        const top = stack[stack.length - 1];
        splitBefore.add(i);
        splitAfter.add(i);
        if (top && (top.kind === "routine" || top.kind === "block" || top.kind === "package") && top.phase === "decl") {
          recordLineIndent(tok.line, top.baseLevel);
          top.phase = "body";
        } else {
          const baseLevel = activeLevel(stack);
          recordLineIndent(tok.line, baseLevel);
          stack.push({ kind: "block", phase: "body", inWhen: false, baseLevel });
        }
        inStatement = false;
        i++;
        continue;
      }

      // 5. EXCEPTION handler section
      if (w === "EXCEPTION" && isExceptionSectionAt(tokens, i, stack)) {
        const top = stack[stack.length - 1] as Extract<PlSqlFrame, { kind: "routine" | "block" | "package" }>;
        recordLineIndent(tok.line, top.baseLevel);
        splitBefore.add(i);
        splitAfter.add(i);
        top.phase = "exception";
        top.inWhen = false;
        inStatement = false;
        i++;
        continue;
      }

      // 6. WHEN ... THEN inside EXCEPTION or CASE statement
      if (w === "WHEN") {
        const top = stack[stack.length - 1];
        if (top && (top.kind === "routine" || top.kind === "block" || top.kind === "package") && top.phase === "exception") {
          top.inWhen = false;
          const whenLevel = top.baseLevel + 1;
          recordLineIndent(tok.line, whenLevel);
          splitBefore.add(i);
          let scan = i + 1;
          while (scan < tokens.length) {
            const st = tokens[scan];
            recordLineIndent(st.line, whenLevel);
            if (word(st) === "THEN") {
              splitAfter.add(scan);
              top.inWhen = true;
              inStatement = false;
              i = scan + 1;
              break;
            }
            scan++;
          }
          if (scan >= tokens.length) break;
          continue;
        }
        if (top && top.kind === "case-stmt") {
          top.inBranch = false;
          const whenLevel = top.baseLevel + 1;
          recordLineIndent(tok.line, whenLevel);
          splitBefore.add(i);
          let scan = i + 1;
          let inlineCase = 0;
          let pDepth = 0;
          while (scan < tokens.length) {
            const st = tokens[scan];
            if (st.text === "(") pDepth++;
            else if (st.text === ")") pDepth = Math.max(0, pDepth - 1);
            const sw = word(st);
            if (sw === "CASE") inlineCase++;
            else if (sw === "END") inlineCase = Math.max(0, inlineCase - 1);
            recordLineIndent(st.line, whenLevel + pDepth);
            if (pDepth === 0 && inlineCase === 0 && sw === "THEN") {
              splitAfter.add(scan);
              top.inBranch = true;
              inStatement = false;
              i = scan + 1;
              break;
            }
            scan++;
          }
          if (scan >= tokens.length) break;
          continue;
        }
      }

      // 7. IF ... THEN / ELSIF ... THEN / ELSE
      if ((w === "IF" && isStatementBoundaryPrev(tokens, i)) || w === "ELSIF" || w === "ELSEIF") {
        const isElsif = w === "ELSIF" || w === "ELSEIF";
        let headerLevel = activeLevel(stack);
        if (isElsif) {
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].kind === "if") {
              stack.length = s + 1;
              headerLevel = stack[s].baseLevel;
              break;
            }
          }
        }
        recordLineIndent(tok.line, headerLevel);
        splitBefore.add(i);

        let scan = i + 1;
        let inlineCase = 0;
        let pDepth = 0;
        let foundThen = false;
        while (scan < tokens.length) {
          const st = tokens[scan];
          if (st.kind === "comment") {
            recordLineIndent(st.line, headerLevel + (pDepth > 0 ? pDepth : 1));
            scan++;
            continue;
          }
          if (st.text === "(") pDepth++;
          else if (st.text === ")") pDepth = Math.max(0, pDepth - 1);
          const sw = word(st);
          if (sw === "CASE") inlineCase++;
          else if (sw === "END") inlineCase = Math.max(0, inlineCase - 1);

          if (pDepth === 0 && inlineCase === 0 && sw === "THEN") {
            recordLineIndent(st.line, headerLevel);
            splitAfter.add(scan);
            if (!isElsif) {
              stack.push({ kind: "if", baseLevel: headerLevel });
            }
            inStatement = false;
            foundThen = true;
            i = scan + 1;
            break;
          }
          if (pDepth === 0 && st.text === ";") {
            break;
          }
          recordLineIndent(st.line, headerLevel + (pDepth > 0 ? pDepth : 1));
          scan++;
        }
        if (foundThen) continue;
      }

      if (w === "ELSE") {
        const top = stack[stack.length - 1];
        if (top?.kind === "if") {
          recordLineIndent(tok.line, top.baseLevel);
          splitBefore.add(i);
          splitAfter.add(i);
          inStatement = false;
          i++;
          continue;
        }
        if (top?.kind === "case-stmt") {
          top.inBranch = false;
          recordLineIndent(tok.line, top.baseLevel + 1);
          splitBefore.add(i);
          splitAfter.add(i);
          top.inBranch = true;
          inStatement = false;
          i++;
          continue;
        }
      }

      // 8. FOR / WHILE / LOOP
      if ((w === "FOR" || w === "WHILE") && isStatementBoundaryPrev(tokens, i)) {
        const headerLevel = activeLevel(stack);
        recordLineIndent(tok.line, headerLevel);
        splitBefore.add(i);
        let scan = i + 1;
        let pDepth = 0;
        let foundLoop = false;
        while (scan < tokens.length) {
          const st = tokens[scan];
          if (st.text === "(") pDepth++;
          else if (st.text === ")") pDepth = Math.max(0, pDepth - 1);
          const sw = word(st);
          if (pDepth === 0 && sw === "LOOP") {
            recordLineIndent(st.line, headerLevel);
            splitAfter.add(scan);
            stack.push({ kind: "loop", baseLevel: headerLevel });
            inStatement = false;
            foundLoop = true;
            i = scan + 1;
            break;
          }
          if (pDepth === 0 && st.text === ";") {
            break;
          }
          recordLineIndent(st.line, headerLevel + (pDepth > 0 ? pDepth : 1));
          scan++;
        }
        if (foundLoop) continue;
      }

      if (w === "LOOP" && word(prev) !== "END") {
        const loopLevel = activeLevel(stack);
        recordLineIndent(tok.line, loopLevel);
        if (isStatementBoundaryPrev(tokens, i)) splitBefore.add(i);
        splitAfter.add(i);
        stack.push({ kind: "loop", baseLevel: loopLevel });
        inStatement = false;
        i++;
        continue;
      }

      // 9. CASE statement vs CASE expression
      if (w === "CASE" && word(prev) !== "END") {
        const caseLevel = activeLevel(stack);
        if (isStatementBoundaryPrev(tokens, i)) {
          recordLineIndent(tok.line, caseLevel);
          splitBefore.add(i);
          stack.push({ kind: "case-stmt", inBranch: false, baseLevel: caseLevel });
          inStatement = false;
        } else {
          if (!inStatement) {
            statementBaseLevel = caseLevel;
            inStatement = true;
          }
          recordLineIndent(tok.line, caseLevel);
          stack.push({ kind: "case-expr", baseLevel: caseLevel });
        }
        i++;
        continue;
      }

      // 10. END [IF | LOOP | CASE | label]
      if (w === "END") {
        const suffix = word(next);
        if (suffix === "IF") {
          let endLevel = Math.max(0, activeLevel(stack) - 1);
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].kind === "if") {
              endLevel = stack[s].baseLevel;
              stack.length = s;
              break;
            }
          }
          recordLineIndent(tok.line, endLevel);
          recordLineIndent(next!.line, endLevel);
          splitBefore.add(i);
          i = nextIdx! + 1;
          if (tokens[i]?.text === ";") {
            recordLineIndent(tokens[i].line, endLevel);
            splitAfter.add(i);
            i++;
          }
          inStatement = false;
          continue;
        }

        if (suffix === "LOOP") {
          let endLevel = Math.max(0, activeLevel(stack) - 1);
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].kind === "loop") {
              endLevel = stack[s].baseLevel;
              stack.length = s;
              break;
            }
          }
          recordLineIndent(tok.line, endLevel);
          recordLineIndent(next!.line, endLevel);
          splitBefore.add(i);
          i = nextIdx! + 1;
          if (isIdentOrWord(tokens[i]) && tokens[i + 1]?.text === ";") {
            recordLineIndent(tokens[i].line, endLevel);
            i++;
          }
          if (tokens[i]?.text === ";") {
            recordLineIndent(tokens[i].line, endLevel);
            splitAfter.add(i);
            i++;
          }
          inStatement = false;
          continue;
        }

        if (suffix === "CASE") {
          let endLevel = Math.max(0, activeLevel(stack) - 1);
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].kind === "case-stmt" || stack[s].kind === "case-expr") {
              endLevel = stack[s].baseLevel;
              stack.length = s;
              break;
            }
          }
          recordLineIndent(tok.line, endLevel);
          recordLineIndent(next!.line, endLevel);
          splitBefore.add(i);
          i = nextIdx! + 1;
          if (isIdentOrWord(tokens[i]) && tokens[i + 1]?.text === ";") {
            recordLineIndent(tokens[i].line, endLevel);
            i++;
          }
          if (tokens[i]?.text === ";") {
            recordLineIndent(tokens[i].line, endLevel);
            splitAfter.add(i);
            i++;
          }
          inStatement = false;
          continue;
        }

        // Bare END: either closes an inline `case-expr` OR closes `routine` / `block` / `package`
        const top = stack[stack.length - 1];
        if (top?.kind === "case-expr") {
          stack.pop();
          recordLineIndent(tok.line, top.baseLevel);
          i++;
          continue;
        }

        let endLevel = 0;
        for (let s = stack.length - 1; s >= 0; s--) {
          const frame = stack[s];
          if (frame.kind === "routine" || frame.kind === "block" || frame.kind === "package") {
            endLevel = frame.baseLevel;
            stack.length = s;
            break;
          }
        }
        recordLineIndent(tok.line, endLevel);
        splitBefore.add(i);
        i++;
        if (isIdentOrWord(tokens[i]) && !END_SUFFIXES.has(word(tokens[i]) ?? "") && tokens[i + 1]?.text === ";") {
          recordLineIndent(tokens[i].line, endLevel);
          i++;
        }
        if (tokens[i]?.text === ";") {
          recordLineIndent(tokens[i].line, endLevel);
          splitAfter.add(i);
          i++;
        }
        inStatement = false;
        continue;
      }
    }

    // Ordinary statement token
    if (!inStatement) {
      statementBaseLevel = activeLevel(stack);
      inStatement = true;
      recordLineIndent(tok.line, statementBaseLevel + parenDepth);
    } else {
      const contLevel = parenDepth > 0 ? activeLevel(stack) + parenDepth : statementBaseLevel + 1;
      recordLineIndent(tok.line, contLevel);
    }

    i++;
  }

  return { splitBefore, splitAfter, lineIndents };
}

function splitPlSqlLines(sql: string, tokens: readonly ProceduralToken[], plan: PlSqlLayoutPlan, newline: string): string {
  const edits: TextEdit[] = [];

  for (const idx of plan.splitBefore) {
    if (idx <= 0) continue;
    const prev = tokens[idx - 1];
    const cur = tokens[idx];
    addSplitEdit(sql, edits, prev, cur, newline);
  }

  for (const idx of plan.splitAfter) {
    let leftIdx = idx;
    // Keep same-line trailing comments attached to the token before the split
    while (leftIdx + 1 < tokens.length && tokens[leftIdx + 1].kind === "comment" && tokens[leftIdx + 1].line === tokens[idx].line) {
      leftIdx++;
    }
    if (leftIdx + 1 < tokens.length) {
      addSplitEdit(sql, edits, tokens[leftIdx], tokens[leftIdx + 1], newline);
    }
  }

  return applyEdits(sql, edits);
}

function renderIndentedPlSqlLines(sql: string, tokens: readonly ProceduralToken[], lineIndents: readonly number[], unit: string): string {
  const rawLines = sql.split("\n");
  const frozenContinuation = Array.from({ length: rawLines.length }, () => false);

  for (const token of tokens) {
    if ((token.kind !== "literal" && token.kind !== "comment") || !token.text.includes("\n")) continue;
    const span = token.text.split("\n").length;
    // Freeze continuation lines (offset >= 1) of multi-line literals/comments so their internal bytes NEVER change!
    for (let offset = 1; offset < span && token.line + offset < frozenContinuation.length; offset++) {
      frozenContinuation[token.line + offset] = true;
    }
  }

  const outLines: string[] = [];
  let consecutiveBlankCount = 0;

  for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
    const raw = rawLines[lineIdx];
    const hasCr = raw.endsWith("\r");
    const content = hasCr ? raw.slice(0, -1) : raw;
    const ending = lineIdx === rawLines.length - 1 ? "" : hasCr ? "\r\n" : "\n";

    if (frozenContinuation[lineIdx]) {
      consecutiveBlankCount = 0;
      outLines.push(content + ending);
      continue;
    }

    const trimmed = content.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    if (!trimmed) {
      consecutiveBlankCount++;
      if (consecutiveBlankCount <= 1 && outLines.length > 0 && lineIdx < rawLines.length - 1) {
        outLines.push(ending);
      }
      continue;
    }

    consecutiveBlankCount = 0;
    const indentLevel = Math.max(0, lineIndents[lineIdx] ?? 0);
    const prefix = indentLevel > 0 ? unit.repeat(indentLevel) : "";
    outLines.push(prefix + trimmed + ending);
  }

  return outLines.join("");
}

function formatPlSqlCore(sql: string, options: { useTabs?: boolean; tabWidth?: number } = {}, initialFrames: readonly PlSqlFrame[] = []): string {
  const initialTokens = lexProceduralSql(sql);
  if (initialTokens.length === 0) return sql;

  const newline = sql.includes("\r\n") ? "\r\n" : "\n";
  const unit = options.useTabs ? "\t" : " ".repeat(options.tabWidth === 4 ? 4 : 2);

  const initialLineCount = sql.split("\n").length;
  const pass1Plan = buildPlSqlLayoutPlan(initialTokens, initialLineCount, initialFrames);
  const splitSql = splitPlSqlLines(sql, initialTokens, pass1Plan, newline);

  const splitTokens = lexProceduralSql(splitSql);
  const splitLineCount = splitSql.split("\n").length;
  const pass2Plan = buildPlSqlLayoutPlan(splitTokens, splitLineCount, initialFrames);
  const indented = renderIndentedPlSqlLines(splitSql, splitTokens, pass2Plan.lineIndents, unit);

  return sameTokenBytes(initialTokens, lexProceduralSql(indented)) ? indented : sql;
}

/**
 * Formats `$tag$ ... $tag$` procedural bodies inside `CREATE FUNCTION / PROCEDURE / PACKAGE / TRIGGER`
 * or `DO` blocks, preserving exact `$tag$` delimiters and all string/comment/identifier bytes.
 */
export function formatDollarQuotedProceduralBodies(sql: string, options: { useTabs?: boolean; tabWidth?: number } = {}, dialect: SqlFormatDialect = "generic"): string {
  if ((dialect !== "postgres" && dialect !== "generic") || /\/\*\s*sql-formatter-disable\s*\*\//i.test(sql)) {
    return sql;
  }

  const tokens = lexProceduralSql(sql);
  const edits: TextEdit[] = [];
  const newline = sql.includes("\r\n") ? "\r\n" : "\n";

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind !== "literal" || !tok.text.startsWith("$")) continue;

    const tagMatch = /^\$(?:[A-Za-z_]\w*)?\$/.exec(tok.text);
    if (!tagMatch) continue;
    const tag = tagMatch[0];
    if (tok.text.length < tag.length * 2 || !tok.text.endsWith(tag)) continue;

    // Determine if this dollar-quoted literal is a routine/package/trigger/DO body
    let isDoBlock = false;
    let sawCreate = false;
    let unitKind: "PACKAGE" | "PACKAGE_BODY" | "ROUTINE" | null = null;
    for (let cursor = i - 1; cursor >= 0; cursor--) {
      const prev = tokens[cursor];
      if (prev.text === ";" || prev.text === ":=") break;
      const pw = word(prev);
      if (pw === "SELECT" || pw === "INSERT" || pw === "UPDATE" || pw === "DELETE" || pw === "VALUES" || pw === "EXECUTE") {
        unitKind = null;
        isDoBlock = false;
        break;
      }
      if (pw === "DO") {
        isDoBlock = true;
        break;
      }
      if (pw === "PACKAGE") {
        const nextIdx = nextSignificant(tokens, cursor);
        unitKind = nextIdx !== undefined && word(tokens[nextIdx]) === "BODY" ? "PACKAGE_BODY" : "PACKAGE";
      } else if ((pw === "FUNCTION" || pw === "PROCEDURE" || pw === "TRIGGER") && !unitKind) {
        unitKind = "ROUTINE";
      } else if (pw === "CREATE") {
        sawCreate = true;
        break;
      }
    }

    if (!isDoBlock && !(sawCreate && unitKind !== null)) continue;

    const inner = tok.text.slice(tag.length, tok.text.length - tag.length);
    const innerTokens = lexProceduralSql(inner);
    if (innerTokens.length === 0) continue;

    const isPackageUnit = sawCreate && (unitKind === "PACKAGE" || unitKind === "PACKAGE_BODY");
    const hasProceduralBegin = innerTokens.some((t, idx) => word(t) === "BEGIN" && !isTransactionBeginAt(innerTokens, idx));
    if (!isPackageUnit && !hasProceduralBegin) continue;

    const initialFrames: PlSqlFrame[] = isPackageUnit ? [{ kind: "package", phase: "decl", inWhen: false, baseLevel: 0 }] : [];

    const formattedInner = formatPlSqlCore(inner.trim(), options, initialFrames);
    if (!sameTokenBytes(innerTokens, lexProceduralSql(formattedInner))) continue;

    const shouldWrapMultiline = inner.includes("\n") || formattedInner.includes("\n");
    const replacement = shouldWrapMultiline ? `${tag}${newline}${formattedInner.trim()}${newline}${tag}` : `${tag} ${formattedInner.trim()} ${tag}`;

    if (replacement !== tok.text) {
      edits.push({ from: tok.from, to: tok.to, text: replacement });
    }
  }

  return applyEdits(sql, edits);
}

/**
 * Returns true when `sql` is an Oracle-compatible openGauss PL/SQL unit that
 * `sql-formatter` (PostgreSQL grammar) would either reject or mangle, such as
 * `CREATE [OR REPLACE] PACKAGE [BODY] ...`, Oracle-style `IS` procedures/functions,
 * or PL/SQL blocks with `EXCEPTION WHEN`, `ELSIF`, `..` ranges, or `END <label>;`.
 */
export function shouldFormatAsPlSqlUnit(sql: string, dialect: SqlFormatDialect = "generic"): boolean {
  if ((dialect !== "postgres" && dialect !== "generic") || /\/\*\s*sql-formatter-disable\s*\*\//i.test(sql)) {
    return false;
  }
  const tokens = lexProceduralSql(sql);
  if (tokens.length === 0) return false;

  // Check first statement kind
  let idx = 0;
  while (idx < tokens.length && tokens[idx].kind === "comment") idx++;
  if (idx >= tokens.length) return false;

  let cursor = idx;
  let sawCreate = false;
  if (word(tokens[cursor]) === "CREATE") {
    sawCreate = true;
    cursor++;
    while (cursor < tokens.length) {
      if (tokens[cursor].kind === "comment") {
        cursor++;
        continue;
      }
      const kw = word(tokens[cursor]);
      if (kw === "OR" || kw === "REPLACE" || kw === "EDITIONABLE" || kw === "NONEDITIONABLE") {
        cursor++;
        continue;
      }
      break;
    }
  }

  const unitWord = word(tokens[cursor]);

  // 1. Any PACKAGE / PACKAGE BODY unit
  if (unitWord === "PACKAGE") {
    return true;
  }

  // 2. Oracle-style CREATE PROCEDURE / FUNCTION / TRIGGER without dollar-quoted body
  if (sawCreate && (unitWord === "PROCEDURE" || unitWord === "FUNCTION" || unitWord === "TRIGGER")) {
    let pDepth = 0;
    let hasDollarBody = false;
    let sawOracleIs = false;
    let sawOracleReturn = false;
    let sawAsWithoutDeclare = false;

    for (let j = cursor + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.kind === "comment") continue;
      if (t.text === "(") pDepth++;
      else if (t.text === ")") pDepth = Math.max(0, pDepth - 1);
      if (pDepth > 0) continue;

      if (t.kind === "literal" && t.text.startsWith("$")) {
        hasDollarBody = true;
        break;
      }
      const jw = word(t);
      if (jw === "RETURN") {
        sawOracleReturn = true;
      }
      if (jw === "IS") {
        sawOracleIs = true;
        break;
      }
      if (jw === "AS") {
        const afterAsIdx = nextSignificant(tokens, j);
        const afterAs = afterAsIdx === undefined ? undefined : tokens[afterAsIdx];
        if (afterAs?.kind === "literal") {
          hasDollarBody = afterAs.text.startsWith("$");
          break;
        }
        if (word(afterAs) !== "DECLARE") {
          sawAsWithoutDeclare = true;
        }
        break;
      }
      if (jw === "BEGIN" && unitWord === "TRIGGER") {
        return true;
      }
      if (t.text === ";") break;
    }

    if (!hasDollarBody && (sawOracleIs || sawOracleReturn || sawAsWithoutDeclare)) {
      return true;
    }
  }

  // 3. Any procedural unit containing PL/SQL-specific constructs that sql-formatter mangles
  const hasProceduralBegin = tokens.some((t, i) => word(t) === "BEGIN" && !isTransactionBeginAt(tokens, i));
  if (!hasProceduralBegin) return false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.text === ".." || t.text === "<<") return true;
    const tw = word(t);
    if (tw === "ELSIF" || tw === "ELSEIF") return true;
    if (tw === "EXCEPTION") {
      const nextIdx = nextSignificant(tokens, i);
      const prevIdx = previousSignificant(tokens, i);
      if (prevIdx !== undefined && word(tokens[prevIdx]) === "RAISE") continue;
      if (nextIdx !== undefined && word(tokens[nextIdx]) === "WHEN") return true;
    }
    if (tw === "END") {
      const nextIdx = nextSignificant(tokens, i);
      const nw = nextIdx === undefined ? undefined : word(tokens[nextIdx]);
      if (nextIdx !== undefined && isIdentOrWord(tokens[nextIdx]) && !END_SUFFIXES.has(nw ?? "")) {
        const afterLabelIdx = nextSignificant(tokens, nextIdx);
        if (afterLabelIdx !== undefined && tokens[afterLabelIdx].text === ";") {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Checks whether `sql` has procedural structure (`PACKAGE`, `PROCEDURE`, `FUNCTION`, `TRIGGER`, `DECLARE`, `BEGIN`)
 * so `formatSqlText` can fall back to `formatPlSqlProceduralUnit` when `sql-formatter` throws a parse error.
 */
export function canFormatAsProceduralFallback(sql: string, dialect: SqlFormatDialect = "generic"): boolean {
  if ((dialect !== "postgres" && dialect !== "generic") || /\/\*\s*sql-formatter-disable\s*\*\//i.test(sql)) {
    return false;
  }
  const tokens = lexProceduralSql(sql);
  return tokens.some((t, idx) => {
    const w = word(t);
    return w === "PACKAGE" || (w === "BEGIN" && !isTransactionBeginAt(tokens, idx));
  });
}

/**
 * Formats an Oracle/openGauss PL/SQL unit (Package Spec, Package Body, Procedure, Function, Trigger, or Block)
 * as well as any inner `$tag$ ... $tag$` procedural bodies.
 */
export function formatPlSqlProceduralUnit(sql: string, options: { useTabs?: boolean; tabWidth?: number } = {}, dialect: SqlFormatDialect = "generic"): string {
  if ((dialect !== "postgres" && dialect !== "generic") || /\/\*\s*sql-formatter-disable\s*\*\//i.test(sql)) {
    return sql;
  }
  const formattedOuter = formatPlSqlCore(sql, options);
  return formatDollarQuotedProceduralBodies(formattedOuter, options, dialect);
}
