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
  return character !== undefined && /[\w$]/.test(character);
}

/** PostgreSQL/openGauss lexer for layout decisions only. Dollar-quoted routine
 * bodies are opaque literals here: formatting must never rewrite their bytes. */
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
    } else if (/[A-Za-z_]/.test(character)) {
      kind = "word";
      index++;
      while (index < sql.length && /[\w$]/.test(sql[index])) index++;
    } else {
      index++;
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
  let result = sql;
  const sorted = [...edits].sort((left, right) => right.from - left.from);
  for (const edit of sorted) result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
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
