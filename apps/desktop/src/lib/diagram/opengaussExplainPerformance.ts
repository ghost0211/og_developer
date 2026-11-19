import type { ExplainPlanNode } from "./explainPlan";
import type { QueryResult } from "@/types/database";

/** Summary timing metrics extracted from an openGauss EXPLAIN PERFORMANCE output. */
export interface OpenGaussExplainPerformanceSummaryMetrics {
  totalRuntimeMs?: number;
  planningTimeMs?: number;
}

/** Parsed openGauss EXPLAIN PERFORMANCE result, including optional tabular view data. */
export interface OpenGaussExplainPerformanceParseResult {
  nodes: ExplainPlanNode[];
  tableResult?: QueryResult;
  summaryMetrics: OpenGaussExplainPerformanceSummaryMetrics;
}

/** Parsed index recommendation returned by openGauss `gs_index_advise(sql)`. */
export interface OpenGaussIndexAdvice {
  schema: string;
  table: string;
  columns: string[];
  indexType?: string;
  indexName: string;
  createSql: string;
  createConcurrentSql: string;
}

export type OpenGaussIndexAdviseErrorKind = "unsupported" | "permission" | "invalid_sql" | "other";

const PLAN_HEADER_RE = /\bid\s*\|\s*operation\b/i;
const PLAN_METRICS_RE = /(?:A-time|E-costs|A-rows)/i;
const TABLE_SEPARATOR_RE = /^\s*[-+:\s]+\s*$/;
const OPERATOR_ROW_RE = /^\s*\d+\s*\|/;
const SECTION_PREDICATE_RE = /^\s*Predicate\s+Information\b/i;
const SECTION_MEMORY_RE = /^\s*Memory\s+Information\b/i;
const GENERIC_SECTION_RE = /^\s*[A-Za-z][A-Za-z0-9\s()_-]+:\s*$/;
const TOTAL_RUNTIME_RE = /^\s*Total\s+runtime\s*:\s*([+-]?[\d,]+(?:\.\d+)?)\s*ms\b/i;
const PLANNING_TIME_RE = /^\s*Plan(?:ning)?\s+time\s*:\s*([+-]?[\d,]+(?:\.\d+)?)\s*ms\b/i;
const SECTION_ID_DETAIL_RE = /^\s*(?:--\s*)?(\d+)\s+-{1,2}\s*(.+)$/;
const SECTION_CONTINUATION_RE = /^\s*--\s*(.+)$/;
const ROW_COUNT_FOOTER_RE = /^\(\d+\s+rows?\)$/i;

/**
 * Returns true when the text appears to be openGauss pipe-delimited
 * `EXPLAIN PERFORMANCE` output (carrying `id | operation` and runtime/cost metrics).
 */
export function isOpenGaussExplainPerformanceText(text: string): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  return PLAN_HEADER_RE.test(text) && PLAN_METRICS_RE.test(text);
}

/**
 * Parses openGauss `EXPLAIN PERFORMANCE` pipe-delimited operator rows plus
 * `Predicate Information`, `Memory Information`, and `Total runtime` sections into
 * an `ExplainPlanNode[]` tree compatible with `planCanvas.ts` and `ExplainPlanViewer.vue`.
 */
export function parseOpenGaussExplainPerformanceText(rawText: string): OpenGaussExplainPerformanceParseResult {
  const lines = String(rawText ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

  let headerColumns: string[] | null = null;
  const columnIndexByName = new Map<string, number>();
  const tableRows: string[][] = [];
  const roots: ExplainPlanNode[] = [];
  const nodesById = new Map<string, ExplainPlanNode>();
  const ancestorStack: Array<{ indent: number; node: ExplainPlanNode }> = [];
  const summaryMetrics: OpenGaussExplainPerformanceSummaryMetrics = {};

  let inPlanTable = false;
  let activeSection: "predicate" | "memory" | "other" | null = null;
  let activeSectionNodeId: string | undefined;
  let totalRuntimeRaw: string | undefined;
  let planningTimeRaw: string | undefined;

  function cellAt(cells: string[], ...candidates: string[]): string {
    for (const candidate of candidates) {
      const idx = columnIndexByName.get(candidate.toLowerCase());
      if (idx !== undefined && idx < cells.length) {
        return cells[idx] ?? "";
      }
    }
    return "";
  }

  for (const line of lines) {
    const runtimeMatch = line.match(TOTAL_RUNTIME_RE);
    if (runtimeMatch) {
      inPlanTable = false;
      activeSection = null;
      activeSectionNodeId = undefined;
      totalRuntimeRaw = runtimeMatch[1].replace(/,/g, "");
      const parsed = Number(totalRuntimeRaw);
      if (Number.isFinite(parsed)) summaryMetrics.totalRuntimeMs = parsed;
      continue;
    }

    const planTimeMatch = line.match(PLANNING_TIME_RE);
    if (planTimeMatch) {
      inPlanTable = false;
      activeSection = null;
      activeSectionNodeId = undefined;
      planningTimeRaw = planTimeMatch[1].replace(/,/g, "");
      const parsed = Number(planningTimeRaw);
      if (Number.isFinite(parsed)) summaryMetrics.planningTimeMs = parsed;
      continue;
    }

    if (!headerColumns && PLAN_HEADER_RE.test(line)) {
      headerColumns = line.split("|").map((col) => col.trim());
      headerColumns.forEach((col, index) => {
        const key = col.toLowerCase();
        if (key && !columnIndexByName.has(key)) {
          columnIndexByName.set(key, index);
        }
      });
      inPlanTable = true;
      continue;
    }

    if (inPlanTable) {
      if (TABLE_SEPARATOR_RE.test(line) && line.includes("-")) {
        continue;
      }

      if (OPERATOR_ROW_RE.test(line) && headerColumns) {
        const rawCells = line.split("|");
        const trimmedCells = headerColumns.map((_, idx) => (rawCells[idx] ?? "").trim());
        tableRows.push(trimmedCells);

        const idIdx = columnIndexByName.get("id") ?? 0;
        const opIdx = columnIndexByName.get("operation") ?? 1;
        const id = trimmedCells[idIdx] || String(tableRows.length);
        const rawOperation = rawCells[opIdx] ?? "";
        const { indent, operatorText } = parseOperationIndentAndText(rawOperation);
        const { nodeType, relation, index } = parseOperatorTitleParts(operatorText);

        const costVal = nonEmptyNonDash(cellAt(trimmedCells, "e-costs", "cost", "costs"));
        const rowsVal = nonEmptyNonDash(cellAt(trimmedCells, "e-rows", "rows"));
        const widthVal = nonEmptyNonDash(cellAt(trimmedCells, "e-width", "width"));
        const aRowsVal = parseActualRowsValue(cellAt(trimmedCells, "a-rows"));
        const aTimeVal = formatOpenGaussActualTime(cellAt(trimmedCells, "a-time"));
        const peakMemoryVal = nonEmptyNonDash(cellAt(trimmedCells, "peak memory", "peak_memory", "memory"));
        const eDistinctVal = nonEmptyNonDash(cellAt(trimmedCells, "e-distinct", "distinct"));

        const details: string[] = [];
        if (aRowsVal !== undefined) details.push(`Actual Rows: ${aRowsVal}`);
        if (aTimeVal !== undefined) details.push(`Actual Time: ${aTimeVal}`);
        if (peakMemoryVal !== undefined) details.push(`Peak Memory: ${peakMemoryVal}`);
        if (eDistinctVal !== undefined) details.push(`Distinct: ${eDistinctVal}`);

        const node: ExplainPlanNode = {
          id,
          title: operatorText || nodeType || "Plan",
          nodeType: nodeType || operatorText || "Plan",
          ...(relation ? { relation } : {}),
          ...(index ? { index } : {}),
          ...(costVal ? { cost: costVal } : {}),
          ...(rowsVal ? { rows: rowsVal } : {}),
          ...(widthVal ? { width: widthVal } : {}),
          details,
          children: [],
        };

        while (ancestorStack.length > 0 && ancestorStack[ancestorStack.length - 1].indent >= indent) {
          ancestorStack.pop();
        }
        if (ancestorStack.length > 0) {
          ancestorStack[ancestorStack.length - 1].node.children.push(node);
        } else {
          roots.push(node);
        }
        ancestorStack.push({ indent, node });
        nodesById.set(id, node);
        continue;
      }

      if (!line.trim()) {
        // Blank line can end the operator table before section blocks.
        if (tableRows.length > 0) inPlanTable = false;
        continue;
      }

      inPlanTable = false;
    }

    if (SECTION_PREDICATE_RE.test(line)) {
      activeSection = "predicate";
      activeSectionNodeId = undefined;
      continue;
    }
    if (SECTION_MEMORY_RE.test(line)) {
      activeSection = "memory";
      activeSectionNodeId = undefined;
      continue;
    }
    if (GENERIC_SECTION_RE.test(line)) {
      activeSection = "other";
      activeSectionNodeId = undefined;
      continue;
    }

    if (activeSection === "predicate" || activeSection === "memory") {
      if (!line.trim()) {
        activeSectionNodeId = undefined;
        continue;
      }
      if (/^\s*-{3,}\s*$/.test(line) || ROW_COUNT_FOOTER_RE.test(line.trim())) {
        continue;
      }

      const idMatch = line.match(SECTION_ID_DETAIL_RE);
      if (idMatch) {
        activeSectionNodeId = idMatch[1];
        const detail = idMatch[2].trim();
        const target = nodesById.get(activeSectionNodeId);
        if (target && detail) appendUniqueDetail(target, detail);
        continue;
      }

      const contMatch = line.match(SECTION_CONTINUATION_RE);
      if (contMatch && activeSectionNodeId) {
        const detail = contMatch[1].trim();
        const target = nodesById.get(activeSectionNodeId);
        if (target && detail) appendUniqueDetail(target, detail);
        continue;
      }

      if (activeSectionNodeId) {
        const trimmed = line.trim();
        const target = nodesById.get(activeSectionNodeId);
        if (target && trimmed) {
          if (target.details.length > 0) {
            target.details[target.details.length - 1] = `${target.details[target.details.length - 1]} ${trimmed}`;
          } else {
            target.details.push(trimmed);
          }
        }
      }
    }
  }

  if (roots.length > 0) {
    if (summaryMetrics.planningTimeMs !== undefined) {
      appendUniqueDetail(roots[0], `Planning Time: ${planningTimeRaw ?? summaryMetrics.planningTimeMs} ms`);
    }
    if (summaryMetrics.totalRuntimeMs !== undefined) {
      appendUniqueDetail(roots[0], `Execution Time: ${totalRuntimeRaw ?? summaryMetrics.totalRuntimeMs} ms`);
    }
  }

  const tableResult: QueryResult | undefined =
    headerColumns && tableRows.length > 0
      ? {
          columns: headerColumns,
          rows: tableRows,
          affected_rows: 0,
          execution_time_ms: summaryMetrics.totalRuntimeMs ?? 0,
        }
      : undefined;

  return {
    nodes: roots,
    tableResult,
    summaryMetrics,
  };
}

/**
 * Builds the `SELECT * FROM gs_index_advise('...')` statement from source SQL,
 * stripping trailing semicolons and escaping single quotes.
 */
export function buildOpenGaussIndexAdviseSql(sql: string): string {
  const normalized = sql
    .trim()
    .replace(/[;\s]+$/, "")
    .trim();
  const escaped = normalized.replace(/'/g, "''");
  return `SELECT * FROM gs_index_advise('${escaped}')`;
}

/**
 * Parses rows returned by `gs_index_advise` into normalized index recommendations
 * and deterministic `CREATE INDEX` / `CREATE INDEX CONCURRENTLY` statements.
 */
export function parseOpenGaussIndexAdviseResult(result: QueryResult): OpenGaussIndexAdvice[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return [];

  const columnIndexMap = new Map<string, number>();
  result.columns.forEach((col, index) => {
    const key = String(col ?? "")
      .trim()
      .toLowerCase();
    if (key && !columnIndexMap.has(key)) {
      columnIndexMap.set(key, index);
    }
  });

  const schemaIdx = findFirstColumnIndex(columnIndexMap, ["schema", "nspname", "schemaname", "schema_name"]);
  const tableIdx = findFirstColumnIndex(columnIndexMap, ["table", "tablename", "table_name", "relname"]);
  const colIdx = findFirstColumnIndex(columnIndexMap, ["column", "columns", "column_name", "attname"]);
  const typeIdx = findFirstColumnIndex(columnIndexMap, ["indextype", "index_type"]);

  if (tableIdx === -1 || colIdx === -1) return [];

  const advices: OpenGaussIndexAdvice[] = [];

  for (const row of result.rows) {
    if (!Array.isArray(row)) continue;

    const columns = parseAdviseColumns(row[colIdx]);
    if (columns.length === 0) continue;

    const rawTable = cleanScalarValue(row[tableIdx]);
    if (!rawTable) continue;

    const rawSchema = schemaIdx >= 0 ? cleanScalarValue(row[schemaIdx]) : undefined;
    const splitTarget = splitSchemaQualifiedIdentifier(rawTable);
    const schema = rawSchema ? unquoteIdentifier(rawSchema) : (splitTarget.schema ?? "");
    const table = splitTarget.table;
    if (!table) continue;

    const rawIndexType = typeIdx >= 0 ? cleanScalarValue(row[typeIdx]) : undefined;
    const indexType = rawIndexType && rawIndexType !== "-" ? rawIndexType : undefined;

    const indexName = buildDeterministicIndexName(table, columns);
    const quotedIndex = quoteIdentifier(indexName);
    const quotedTarget = schema ? `${quoteIdentifier(schema)}.${quoteIdentifier(table)}` : quoteIdentifier(table);
    const quotedCols = columns.map(quoteIdentifier).join(", ");

    advices.push({
      schema,
      table,
      columns,
      ...(indexType ? { indexType } : {}),
      indexName,
      createSql: `CREATE INDEX ${quotedIndex} ON ${quotedTarget} (${quotedCols});`,
      createConcurrentSql: `CREATE INDEX CONCURRENTLY ${quotedIndex} ON ${quotedTarget} (${quotedCols});`,
    });
  }

  return advices;
}

/**
 * Classifies backend/database errors from `gs_index_advise` execution into UI-friendly categories.
 */
export function classifyOpenGaussIndexAdviseError(message: string): OpenGaussIndexAdviseErrorKind {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) return "other";

  const mentionsFunction = text.includes("gs_index_advise") || /function\s+[^\n]*does not exist/.test(text);
  if (
    (mentionsFunction && (text.includes("does not exist") || text.includes("not exist") || text.includes("undefined function") || text.includes("not found") || text.includes("不存在"))) ||
    (text.includes("gs_index_advise") && (text.includes("not supported") || text.includes("unsupported") || text.includes("不支持")))
  ) {
    return "unsupported";
  }

  if (
    text.includes("permission denied") ||
    text.includes("insufficient privilege") ||
    text.includes("must be superuser") ||
    text.includes("must be system admin") ||
    text.includes("access denied") ||
    text.includes("unauthorized") ||
    text.includes("权限不足") ||
    text.includes("没有权限") ||
    text.includes("无权限")
  ) {
    return "permission";
  }

  if (
    text.includes("syntax error") ||
    text.includes("语法错误") ||
    text.includes("parse error") ||
    text.includes("invalid query") ||
    text.includes("unterminated") ||
    text.includes("cannot advise") ||
    text.includes("only select") ||
    text.includes("not a select") ||
    text.includes("unsupported statement") ||
    /does not exist/.test(text) ||
    /does not support/.test(text)
  ) {
    return "invalid_sql";
  }

  return "other";
}

// ── Internal parsing helpers ────────────────────────────────────────────

function parseOperationIndentAndText(rawOperation: string): { indent: number; operatorText: string } {
  const trimmedEnd = rawOperation.trimEnd();
  const leadingSpaces = trimmedEnd.match(/^ */)?.[0].length ?? 0;
  let rest = trimmedEnd.slice(leadingSpaces);
  let arrowCount = 0;
  while (/^->\s*/.test(rest)) {
    arrowCount += 1;
    rest = rest.replace(/^->\s*/, "");
  }
  return {
    indent: leadingSpaces * 10 + arrowCount,
    operatorText: rest.trim(),
  };
}

function parseOperatorTitleParts(operatorText: string): {
  nodeType: string;
  relation?: string;
  index?: string;
} {
  if (!operatorText) return { nodeType: "Plan" };

  // Find top-level (outside parentheses) `using` and `on` clauses.
  let depth = 0;
  let inQuotes = false;
  let firstClauseStart = -1;
  let usingRest: string | undefined;
  let onRest: string | undefined;

  for (let i = 0; i < operatorText.length; i += 1) {
    const ch = operatorText[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;

    const slice = operatorText.slice(i);
    if (usingRest === undefined) {
      const mUsing = slice.match(/^\s+using\s+/i);
      if (mUsing) {
        if (firstClauseStart === -1) firstClauseStart = i;
        usingRest = slice.slice(mUsing[0].length);
      }
    }
    if (onRest === undefined) {
      const mOn = slice.match(/^\s+on\s+/i);
      if (mOn) {
        if (firstClauseStart === -1) firstClauseStart = i;
        onRest = slice.slice(mOn[0].length);
      }
    }
  }

  const nodeType = (firstClauseStart >= 0 ? operatorText.slice(0, firstClauseStart) : operatorText).trim() || operatorText;
  const index = usingRest ? extractQualifiedIdentifierToken(usingRest) : undefined;
  const relation = onRest ? extractQualifiedIdentifierToken(onRest) : undefined;

  return { nodeType, relation, index };
}

function extractQualifiedIdentifierToken(text: string): string | undefined {
  const match = text.match(/^((?:"[^"]+"|[^\s(]+)(?:\.(?:"[^"]+"|[^\s(]+))?)/);
  return match?.[1] || undefined;
}

function nonEmptyNonDash(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return undefined;
  return trimmed;
}

function parseActualRowsValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return undefined;
  if (/^[+-]?[\d,]+(?:\.\d+)?$/.test(trimmed)) {
    return trimmed.replace(/,/g, "");
  }
  return undefined;
}

function formatOpenGaussActualTime(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-" || trimmed.toLowerCase() === "(null)") return undefined;
  const withoutUnit = trimmed.replace(/\s*ms\s*$/i, "").trim();
  if (!withoutUnit) return undefined;

  const rangeMatch = withoutUnit.match(/^\[([^\],]+),\s*([^\]]+)\]$/);
  if (rangeMatch) {
    const start = rangeMatch[1].trim();
    const end = rangeMatch[2].trim();
    if (start && end) return `${start}..${end} ms`;
    return undefined;
  }

  return `${withoutUnit} ms`;
}

function appendUniqueDetail(node: ExplainPlanNode, detail: string) {
  if (!node.details.includes(detail)) {
    node.details.push(detail);
  }
}

function findFirstColumnIndex(columnIndexMap: Map<string, number>, candidates: string[]): number {
  for (const candidate of candidates) {
    const idx = columnIndexMap.get(candidate.toLowerCase());
    if (idx !== undefined) return idx;
  }
  return -1;
}

function cleanScalarValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const lower = text.toLowerCase();
  if (lower === "null" || lower === "(null)") return undefined;
  return text;
}

function parseAdviseColumns(rawValue: unknown): string[] {
  if (rawValue === null || rawValue === undefined) return [];
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((item) => cleanScalarValue(item))
      .filter((item): item is string => !!item)
      .map(unquoteIdentifier)
      .filter(Boolean);
  }

  let text = String(rawValue).trim();
  if (!text) return [];
  const lower = text.toLowerCase();
  if (lower === "null" || lower === "(null)" || text === "()" || text === "-") return [];

  if (text.startsWith("(") && text.endsWith(")")) {
    text = text.slice(1, -1).trim();
  }
  if (!text) return [];

  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);

  return parts
    .map((part) => cleanScalarValue(part))
    .filter((part): part is string => !!part && part !== "-")
    .map(unquoteIdentifier)
    .filter(Boolean);
}

function splitSchemaQualifiedIdentifier(raw: string): { schema?: string; table: string } {
  const trimmed = raw.trim();
  let inQuotes = false;
  let dotIndex = -1;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "." && !inQuotes) {
      dotIndex = i;
      break;
    }
  }
  if (dotIndex > 0) {
    const schema = unquoteIdentifier(trimmed.slice(0, dotIndex).trim());
    const table = unquoteIdentifier(trimmed.slice(dotIndex + 1).trim());
    return { ...(schema ? { schema } : {}), table };
  }
  return { table: unquoteIdentifier(trimmed) };
}

function unquoteIdentifier(ident: string): string {
  const trimmed = ident.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed;
}

function quoteIdentifier(ident: string): string {
  return `"${unquoteIdentifier(ident).replace(/"/g, '""')}"`;
}

function toIdentifierSlug(value: string): string {
  return (
    unquoteIdentifier(value)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "col"
  );
}

function buildDeterministicIndexName(table: string, columns: string[]): string {
  const tableSlug = toIdentifierSlug(table);
  const colsSlug = columns.map(toIdentifierSlug).join("_");
  const full = `idx_${tableSlug}_${colsSlug}`;
  if (full.length <= 63) return full;
  return full.slice(0, 63).replace(/_+$/g, "") || "idx_recommended";
}
