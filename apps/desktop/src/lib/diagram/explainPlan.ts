import type { DatabaseType, QueryResult } from "@/types/database";
import * as api from "@/lib/backend/api";
import { supportsDatabaseFeature } from "@/lib/database/databaseDriverManifest";

export interface ExplainPlanNode {
  id: string;
  title: string;
  nodeType: string;
  relation?: string;
  index?: string;
  cost?: string;
  rows?: string;
  width?: string;
  details: string[];
  children: ExplainPlanNode[];
}

export interface ParsedExplainPlan {
  databaseType: "postgres" | "opengauss";
  raw: unknown;
  nodes: ExplainPlanNode[];
}

export type BuildExplainSqlResult = { ok: true; sql: string } | { ok: false; reason: "unsupported" | "empty" | "unsafe" };

const SUPPORTED_EXPLAIN_TYPES = new Set<DatabaseType>(["postgres", "opengauss"]);
export function supportsExplainPlan(databaseType?: DatabaseType): databaseType is "postgres" | "opengauss" {
  return !!databaseType && supportsDatabaseFeature(databaseType, "sqlExplain") && SUPPORTED_EXPLAIN_TYPES.has(databaseType);
}

/** `analyze` is honored by PostgreSQL-compatible engines server-side. */
export function buildExplainSql(databaseType: DatabaseType | undefined, sql: string, format: "json" | "standard" = "json", analyze?: boolean): Promise<BuildExplainSqlResult> {
  return api.buildExplainSql({ databaseType, sql, format, analyze }) as Promise<BuildExplainSqlResult>;
}

export function parseExplainResult(databaseType: "postgres" | "opengauss", result: QueryResult): ParsedExplainPlan {
  const raw = parseExplainCell(result.rows[0]?.[0]);
  const nodes = parsePostgresExplain(raw);
  return { databaseType, raw, nodes };
}

export function flattenExplainPlanNodes(nodes: ExplainPlanNode[]): ExplainPlanNode[] {
  const rows: ExplainPlanNode[] = [];
  function visit(node: ExplainPlanNode) {
    rows.push(node);
    node.children.forEach((child) => visit(child));
  }
  nodes.forEach((node) => visit(node));
  return rows;
}

function parseExplainCell(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ── PostgreSQL / openGauss JSON explain parser ────────────────────────

function parsePostgresExplain(raw: unknown): ExplainPlanNode[] {
  const plans = Array.isArray(raw) ? raw : [raw];
  return plans
    .map((item, index) => {
      const root = objectValue(item);
      if (!root) return null;
      const plan = objectValue(root.Plan) || root;
      const node = parsePostgresNode(plan, String(index));
      if (!node) return null;

      // EXPLAIN ANALYZE reports these next to "Plan", not inside it.
      const planningTime = numberLike(root["Planning Time"]);
      const executionTime = numberLike(root["Execution Time"]);
      if (planningTime !== undefined) node.details.push(`Planning Time: ${planningTime} ms`);
      if (executionTime !== undefined) node.details.push(`Execution Time: ${executionTime} ms`);
      return node;
    })
    .filter((node): node is ExplainPlanNode => !!node);
}

function parsePostgresNode(plan: Record<string, unknown> | null, id: string): ExplainPlanNode | null {
  if (!plan) return null;
  const nodeType = stringValue(plan["Node Type"]) || "Plan";
  const relation = stringValue(plan["Relation Name"]);
  const index = stringValue(plan["Index Name"]);
  const startupCost = numberLike(plan["Startup Cost"]);
  const totalCost = numberLike(plan["Total Cost"]);
  const rows = numberLike(plan["Plan Rows"]);
  const width = numberLike(plan["Plan Width"]);
  const filter = stringValue(plan.Filter);
  const joinType = stringValue(plan["Join Type"]);
  const sortKey = arrayValue(plan["Sort Key"])?.map(String).join(", ");
  // EXPLAIN ANALYZE only. Actual Rows is per loop, matching Plan Rows.
  const actualRows = numberLike(plan["Actual Rows"]);
  const actualLoops = numberLike(plan["Actual Loops"]);
  const actualStartupTime = numberLike(plan["Actual Startup Time"]);
  const actualTotalTime = numberLike(plan["Actual Total Time"]);

  const children =
    arrayValue(plan.Plans)
      ?.map((child, childIndex) => parsePostgresNode(objectValue(child), `${id}.${childIndex}`))
      .filter((node): node is ExplainPlanNode => !!node) ?? [];

  return {
    id,
    title: relation ? `${nodeType} on ${relation}` : nodeType,
    nodeType,
    relation,
    index,
    cost: [startupCost, totalCost].every(Boolean) ? `${startupCost}..${totalCost}` : totalCost,
    rows,
    width,
    details: [
      joinType ? `Join: ${joinType}` : "",
      filter ? `Filter: ${filter}` : "",
      sortKey ? `Sort: ${sortKey}` : "",
      actualRows !== undefined ? `Actual Rows: ${actualRows}` : "",
      actualLoops !== undefined && Number(actualLoops) > 1 ? `Actual Loops: ${actualLoops}` : "",
      actualStartupTime !== undefined && actualTotalTime !== undefined ? `Actual Time: ${actualStartupTime}..${actualTotalTime} ms` : "",
    ].filter(Boolean),
    children,
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function numberLike(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === "string" && value.trim().length > 0) return value;
  return undefined;
}
