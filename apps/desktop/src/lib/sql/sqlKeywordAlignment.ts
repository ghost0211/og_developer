import type { SqlFormatDialect } from "./sqlFormatter";

interface Token {
  text: string;
  kind: "word" | "symbol" | "literal" | "comment";
  line: number;
  frame?: Frame;
  closed?: Frame;
}
interface Frame {
  parent?: Frame;
  query?: Query;
  condition: boolean;
  parentQuery?: Query;
  open?: Token;
}
interface Query {
  parent?: Query;
  oldIndent: string;
  base: string;
  width: number;
  section: string;
  selected: boolean;
  caseDepth: number;
  open?: Token;
  closeBase: string;
}
interface Row {
  text: string;
  indent: string;
  tokens: Token[];
  owner?: Query;
  keyword?: string;
  frozen: boolean;
  ending: string;
}

// Composite keywords are indivisible alignment units, including long JOINs.
const CLAUSE_RE = /^(select(?:\s+(?:distinct(?:\s+on)?|all))?|from|where|group\s+by|having|order\s+by|limit|offset|fetch\s+(?:first|next)|for\s+(?:update|share)|union(?:\s+(?:all|distinct))?|intersect(?:\s+all)?|except(?:\s+all)?|with(?:\s+recursive)?)\b/i;
const JOIN_RE = /^(?:(?:natural\s+)?(?:(?:inner|left|right|full|cross)(?:\s+outer)?\s+)?join|straight_join)\b/i;
const LOGICAL_RE = /^(and|or)\b/i;
const CONDITIONAL_SECTIONS = new Set(["where", "having", "join"]);

/** Tokenize only to protect lexical bytes and recognize query/group boundaries.
 * No dependency on sql-formatter's private parser or dialect AST is required. */
function lex(sql: string, dialect: SqlFormatDialect): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 0;
  const identifierPart = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch);
  while (i < sql.length) {
    if (/\s/.test(sql[i])) {
      if (sql[i] === "\n") line++;
      i++;
      continue;
    }
    const start = i;
    const startLine = line;
    let kind: Token["kind"] = "symbol";
    const ch = sql[i];
    const next = sql[i + 1];
    if ((ch === "-" && next === "-" && (dialect !== "mysql" || !sql[i + 2] || sql.charCodeAt(i + 2) <= 32 || sql.charCodeAt(i + 2) === 127)) || (ch === "#" && dialect === "mysql")) {
      kind = "comment";
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
    } else if (ch === "/" && next === "*") {
      kind = "comment";
      i += 2;
      let depth = 1;
      const nested = dialect === "postgres" || dialect === "sqlserver" || dialect === "clickhouse";
      while (i < sql.length && depth > 0) {
        if (nested && sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (ch === "'" || ch === '"' || ch === "`" || (ch === "[" && dialect === "sqlserver")) {
      kind = "literal";
      const close = ch === "[" ? "]" : ch;
      const escape = dialect === "mysql" || dialect === "clickhouse" || (ch === "'" && dialect === "postgres" && /[eE]/.test(sql[start - 1] ?? "") && !identifierPart(sql[start - 2]));
      i++;
      while (i < sql.length) {
        if (escape && sql[i] === "\\") i = Math.min(sql.length, i + 2);
        else if (sql[i] === close) {
          i++;
          if (sql[i] === close) i++;
          else break;
        } else i++;
      }
    } else if (ch === "$" && dialect === "postgres" && !identifierPart(sql[start - 1]) && /^\$(?:[A-Za-z_]\w*)?\$/.test(sql.slice(i))) {
      kind = "literal";
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
    } else if (/[A-Za-z_]/.test(ch)) {
      kind = "word";
      i++;
      while (i < sql.length && /[\w$]/.test(sql[i])) i++;
    } else i++;
    const text = sql.slice(start, i);
    tokens.push({ text, kind, line: startLine });
    for (const character of text) if (character === "\n") line++;
  }
  return tokens;
}

function nearestQuery(frame: Frame | undefined): Query | undefined {
  while (frame) {
    if (frame.query) return frame.query;
    frame = frame.parent;
  }
  return undefined;
}

function readRows(sql: string, tokens: Token[]): Row[] {
  const lines = sql.split("\n");
  const rows: Row[] = lines.map((line, index) => {
    const crlf = index < lines.length - 1 && line.endsWith("\r");
    const text = crlf ? line.slice(0, -1) : line;
    return { text: text.trimStart(), indent: /^\s*/.exec(text)![0], tokens: [], frozen: false, ending: index === lines.length - 1 ? "" : crlf ? "\r\n" : "\n" };
  });
  for (const token of tokens) {
    rows[token.line].tokens.push(token);
    if ((token.kind === "literal" || token.kind === "comment") && token.text.includes("\n")) {
      const count = token.text.split("\n").length;
      // Even the opening/closing line stays byte-for-byte intact. This is a
      // deliberate conservative fallback for multiline opaque constructs.
      for (let n = 0; n < count; n++) rows[token.line + n].frozen = true;
    }
  }
  return rows;
}

function describeQueries(rows: Row[], tokens: Token[]): Query[] {
  let frame: Frame = { condition: false };
  let caseDepth = 0;
  const queries: Query[] = [];
  let previous: Token | undefined;
  for (const token of tokens) {
    const row = rows[token.line];
    const leading = row.tokens[0] === token && !row.frozen;
    if (token.kind === "symbol" && token.text === ")" && frame.parent) {
      token.closed = frame;
      frame = frame.parent;
    }
    token.frame = frame;
    let query = nearestQuery(frame);
    if (leading && token.kind === "word") {
      const clause = CLAUSE_RE.exec(row.text)?.[1];
      const name = clause?.toLowerCase().replace(/\s+/g, " ");
      if (name?.startsWith("select") || name?.startsWith("with")) {
        if (!frame.query || (name.startsWith("select") && frame.query.selected)) {
          query = {
            parent: frame.parentQuery ?? nearestQuery(frame.parent),
            oldIndent: row.indent,
            base: "",
            width: 0,
            section: name.startsWith("with") ? "with" : "select",
            selected: false,
            caseDepth,
            open: frame.open,
            closeBase: "",
          };
          frame.query = query;
          queries.push(query);
        } else query = frame.query;
        if (name.startsWith("select")) query.selected = true;
      }
      if (query && caseDepth === query.caseDepth) {
        let keyword: string | undefined;
        if (clause && frame.query === query) keyword = clause;
        else if (frame.query === query) keyword = JOIN_RE.exec(row.text)?.[0];
        if (!keyword && CONDITIONAL_SECTIONS.has(query.section)) keyword = LOGICAL_RE.exec(row.text)?.[0];
        if (keyword) {
          row.keyword = keyword;
          query.width = Math.max(query.width, keyword.length);
          if (clause) query.section = name!.split(" ")[0];
          else if (JOIN_RE.test(keyword)) query.section = "join";
        }
      }
    }
    if (leading) {
      row.owner = query;
    }
    if (token.kind === "word") {
      const name = token.text.toLowerCase();
      if (name === "case") caseDepth++;
      else if (name === "end") caseDepth = Math.max(0, caseDepth - 1);
    }
    if (token.kind === "symbol" && token.text === "(") {
      const condition = !!query && CONDITIONAL_SECTIONS.has(query.section) && caseDepth === query.caseDepth && !!previous && (previous.text === "(" || /^(?:where|having|on|and|or|not)$/.test(previous.text.toLowerCase()));
      const child: Frame = { parent: frame, condition, parentQuery: query, open: token };
      token.frame = child;
      frame = child;
    } else if (token.kind === "symbol" && token.text === ";" && !frame.parent) {
      frame = { condition: false };
      caseDepth = 0;
    }
    if (token.kind !== "comment") previous = token;
  }
  return queries;
}

function lastToken(row: Row): Token | undefined {
  return row.tokens[row.tokens.length - 1];
}

function mergeRows(rows: Row[], alignment: "left" | "right"): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = { ...rows[i], tokens: [...rows[i].tokens] };
    const next = rows[i + 1];
    const select = row.keyword?.toLowerCase().startsWith("select");
    if (row.owner?.selected && row.keyword && row.text === row.keyword && (!select || alignment === "right") && next && !row.frozen && !next.frozen && !next.keyword && next.owner === row.owner && next.text && next.tokens[0]?.kind !== "comment") {
      row.text += " " + next.text;
      row.tokens.push(...next.tokens);
      row.ending = next.ending;
      i++;
    }
    // A boolean grouping paren isn't a subquery. Keep the paren, but put its
    // first predicate on the same line (AND (a ...), not AND ( / a ...).
    while (row.owner?.selected && !row.frozen && lastToken(row)?.text === "(" && lastToken(row)?.frame?.condition && !lastToken(row)?.frame?.query) {
      const content = rows[i + 1];
      if (!content || content.frozen || content.keyword || content.owner !== row.owner || !content.text || content.tokens[0]?.kind === "comment") break;
      row.text += content.text;
      row.tokens.push(...content.tokens);
      row.ending = content.ending;
      i++;
    }
    const first = row.tokens[0];
    const prior = out[out.length - 1];
    if (row.owner?.selected && !row.frozen && first?.closed?.condition && !first.closed.query && /^\)+[;,]*$/.test(row.text) && prior && !prior.frozen && prior.owner === row.owner && prior.text && lastToken(prior)?.kind !== "comment") {
      prior.text += row.text;
      prior.tokens.push(...row.tokens);
      prior.ending = row.ending;
    } else out.push(row);
  }
  return out;
}

function rowIndent(row: Row, alignment: "left" | "right", unit: string): string {
  const query = row.owner;
  if (!query?.selected || row.frozen || !row.text) return row.indent;
  if (row.keyword) return query.base + (alignment === "right" ? " ".repeat(query.width - row.keyword.length) : "");
  const childQueryClose = row.tokens[0]?.closed?.query;
  if (childQueryClose) return childQueryClose.closeBase;
  const anchor = alignment === "right" ? " ".repeat(query.width + 1) : unit;
  const prefix = query.oldIndent + unit;
  const extra = row.indent.startsWith(prefix) ? row.indent.slice(prefix.length) : "";
  return query.base + anchor + extra;
}

/** Apply screenshot-style alignment to standard sql-formatter output.
 * Each SELECT/CTE/UNION branch measures its own keywords. Nested SELECTs keep
 * their own structural indent and width, not the parent's keyword padding.
 * Only whitespace outside literal/comment tokens may change. */
export function alignSqlKeywords(sql: string, alignment: "left" | "right", options: { useTabs?: boolean; tabWidth?: number } = {}, dialect: SqlFormatDialect = "generic"): string {
  // Honor library disable regions, including the verbatim SQL between markers.
  if (/\/\*\s*sql-formatter-disable\s*\*\//i.test(sql)) return sql;
  const unit = options.useTabs ? "\t" : " ".repeat(options.tabWidth === 4 ? 4 : 2);
  const tokens = lex(sql, dialect);
  const rows = readRows(sql, tokens);
  const queries = describeQueries(rows, tokens);
  if (!queries.some((query) => query.selected)) return sql;
  const merged = mergeRows(rows, alignment);
  const tokenRows = new Map<Token, Row>();
  for (const row of merged) for (const token of row.tokens) if (token.kind === "symbol" && token.text === "(") tokenRows.set(token, row);
  for (const query of queries) {
    const opener = query.open ? tokenRows.get(query.open) : undefined;
    // Anchor a nested block to the rendered opening line, not the parent's
    // unpadded base. FROM's padding and SELECT/CASE field indentation count.
    query.closeBase = query.parent && opener ? rowIndent(opener, alignment, unit) : query.oldIndent;
    query.base = query.parent ? query.closeBase + unit : query.oldIndent;
  }
  const aligned = merged.map((row) => rowIndent(row, alignment, unit) + row.text + row.ending).join("");
  // Defense-in-depth: if any literal/comment/token bytes changed, abandon the
  // alignment, not the user's SQL. In particular a line comment must never
  // swallow a predicate or closing paren after a merge.
  const after = lex(aligned, dialect);
  if (after.length !== tokens.length || after.some((token, index) => token.kind !== tokens[index].kind || token.text !== tokens[index].text)) return sql;
  return aligned;
}
