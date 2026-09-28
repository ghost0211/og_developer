/**
 * 执行计划诊断（PostgreSQL / openGauss）。
 *
 * 解析后的 `ExplainPlanNode` 丢弃了大量原生 JSON 字段（Sort Method、Hash Batches、
 * Shared Read Blocks 等），因此诊断器直接遍历 `ParsedExplainPlan.raw` 里的
 * EXPLAIN (FORMAT JSON) 原始结构。全部为纯函数，方便单元测试。
 *
 * 结构约定：顶层是数组（或单个对象），每项的 `Plan` 是计划树根，子节点在 `Plans` 数组里。
 * 所有字段访问都做防御式处理：键可能缺失，数值可能是字符串。
 */

export type ExplainPlanFindingSeverity = "info" | "warning" | "critical";

export interface ExplainPlanFinding {
  severity: ExplainPlanFindingSeverity;
  /** i18n key 后缀，如 "rowEstimateDeviation" */
  code: string;
  /** 触发规则的节点类型 */
  nodeType: string;
  /** 相关表（如有） */
  relation?: string;
  /** i18n 插值参数 */
  metrics: Record<string, string | number>;
}

type PlanNode = Record<string, unknown>;

type PlanRule = (node: PlanNode) => ExplainPlanFinding | null;

const SEVERITY_RANK: Record<ExplainPlanFindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

// ── 防御式取值 ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is PlanNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把数字或字符串数字统一转成 number，非法值返回 undefined。 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/,/g, "");
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** 归一化键名，用于跨越 openGauss / PostgreSQL 的命名差异做宽松匹配。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

/** 先按候选键精确取值，失败后再按归一化键宽松匹配。 */
function pickNumber(node: PlanNode, candidates: string[]): number | undefined {
  for (const key of candidates) {
    const direct = toNumber(node[key]);
    if (direct !== undefined) return direct;
  }
  const wanted = new Set(candidates.map(normalizeKey));
  for (const [key, value] of Object.entries(node)) {
    if (!wanted.has(normalizeKey(key))) continue;
    const parsed = toNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function pickString(node: PlanNode, candidates: string[]): string | undefined {
  for (const key of candidates) {
    const direct = toStringValue(node[key]);
    if (direct !== undefined && direct.trim().length > 0) return direct;
  }
  const wanted = new Set(candidates.map(normalizeKey));
  for (const [key, value] of Object.entries(node)) {
    if (!wanted.has(normalizeKey(key))) continue;
    const parsed = toStringValue(value);
    if (parsed !== undefined && parsed.trim().length > 0) return parsed;
  }
  return undefined;
}

function hasKeyMatching(node: PlanNode, pattern: RegExp): boolean {
  return Object.keys(node).some((key) => pattern.test(key));
}

/** 尝试保留整数，同时对小数保留一位，便于 i18n 展示。 */
function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function planChildren(node: PlanNode): PlanNode[] {
  const plans = node["Plans"];
  if (!Array.isArray(plans)) return [];
  return plans.filter(isRecord);
}

function buildFinding(node: PlanNode, code: string, severity: ExplainPlanFindingSeverity, metrics: Record<string, string | number>): ExplainPlanFinding {
  const nodeType = toStringValue(node["Node Type"]) ?? "Plan";
  const finding: ExplainPlanFinding = {
    severity,
    code,
    nodeType,
    // nodeType 一并放进插值参数，文案可自描述触发节点。
    metrics: { nodeType, ...metrics },
  };
  const relation = toStringValue(node["Relation Name"]);
  if (relation) finding.relation = relation;
  return finding;
}

// ── 规则实现（每条独立小函数，便于单测） ───────────────────────────────

/**
 * 规则 1：行数估算偏差。
 * 预估行数与实际行数（Actual Rows × Actual Loops）相差 10 倍以上告警，100 倍以上严重。
 */
function ruleRowEstimateDeviation(node: PlanNode): ExplainPlanFinding | null {
  const planRows = toNumber(node["Plan Rows"]);
  const actualRows = pickNumber(node, ["Actual Rows"]);
  if (planRows === undefined || actualRows === undefined) return null;

  const loops = Math.max(0, pickNumber(node, ["Actual Loops"]) ?? 1);
  const actualTotal = actualRows * loops;
  const high = Math.max(actualTotal, planRows);
  const low = Math.min(actualTotal, planRows);
  const deviation = high / Math.max(1, low);
  if (!Number.isFinite(deviation)) return null;

  const severity: ExplainPlanFindingSeverity | null = deviation >= 100 ? "critical" : deviation >= 10 ? "warning" : null;
  if (!severity) return null;

  return buildFinding(node, "rowEstimateDeviation", severity, {
    planRows: round(planRows),
    actualRows: round(actualRows),
    loops: round(loops),
    deviation: round(deviation),
  });
}

/**
 * 规则 2：大表顺序扫描 + 高过滤。
 * 有实际数据时用真实行数计算过滤比例（critical）；纯 EXPLAIN 时用 Plan Rows 估算，
 * 条件更严格（>= 10 万行、比例 >= 99%）并降级为 warning。
 */
function ruleSeqScanHeavyFilter(node: PlanNode): ExplainPlanFinding | null {
  if ((toStringValue(node["Node Type"]) ?? "").trim().toLowerCase() !== "seq scan") return null;

  const removed = pickNumber(node, ["Rows Removed by Filter"]);
  if (removed === undefined || removed < 10000) return null;

  const actualRows = pickNumber(node, ["Actual Rows"]);
  if (actualRows !== undefined) {
    const loops = Math.max(0, pickNumber(node, ["Actual Loops"]) ?? 1);
    const actualTotal = actualRows * loops;
    const denominator = removed + actualTotal;
    if (denominator <= 0) return null;
    const ratio = removed / denominator;
    if (ratio < 0.95) return null;
    return buildFinding(node, "seqScanHeavyFilter", "critical", {
      rowsRemoved: round(removed),
      actualRows: round(actualTotal),
      loops: round(loops),
      filterRatio: round(ratio * 100),
    });
  }

  if (removed < 100000) return null;
  const planRows = toNumber(node["Plan Rows"]) ?? 0;
  const denominator = removed + planRows;
  if (denominator <= 0) return null;
  const ratio = removed / denominator;
  if (ratio < 0.99) return null;
  return buildFinding(node, "seqScanHeavyFilter", "warning", {
    rowsRemoved: round(removed),
    planRows: round(planRows),
    filterRatio: round(ratio * 100),
  });
}

/**
 * 规则 3：排序落盘。
 * "Sort Method" 以 external 开头（external merge / external sort），
 * 或节点带有 "Sort Space Type: Disk" / 其它 Disk 痕迹时告警，建议增大 work_mem。
 */
function ruleSortSpill(node: PlanNode): ExplainPlanFinding | null {
  const method = pickString(node, ["Sort Method"]);
  const sortSpaceType = pickString(node, ["Sort Space Type"]);
  const external = !!method && method.trim().toLowerCase().startsWith("external");
  const diskBacked = !!sortSpaceType && sortSpaceType.trim().toLowerCase() === "disk";
  const nodeType = toStringValue(node["Node Type"]) ?? "";
  const diskTrace = /sort/i.test(nodeType) && hasKeyMatching(node, /disk/i);
  if (!external && !diskBacked && !diskTrace) return null;

  return buildFinding(node, "sortSpill", "warning", {
    method: method ?? sortSpaceType ?? "external",
    sortSpaceType: sortSpaceType ?? (diskTrace ? "Disk" : "-"),
  });
}

/**
 * 规则 4：Hash 分批落盘。
 * "Hash Batches"（openGauss 可能是 "Batches"）> 1，且存在 Peak Memory Usage / Disk
 * 等落盘痕迹时告警，建议增大 work_mem。
 */
function ruleHashSpill(node: PlanNode): ExplainPlanFinding | null {
  const batches = pickNumber(node, ["Hash Batches", "Batches", "Hash Batch"]);
  if (batches === undefined || batches <= 1) return null;

  const spillTrace = hasKeyMatching(node, /peak.*memory|memory.*usage|work_?mem|disk/i);
  if (!spillTrace) return null;

  const metrics: Record<string, string | number> = { batches: round(batches) };
  const peakMemory = pickNumber(node, ["Peak Memory Usage", "Peak Memory"]);
  if (peakMemory !== undefined) metrics.peakMemoryKb = round(peakMemory);
  return buildFinding(node, "hashSpill", "warning", metrics);
}

/**
 * 规则 5：嵌套循环放大。
 * Nested Loop 的直接子节点中只要有 Actual Loops >= 10000，就提示考虑 Hash Join 或内层索引。
 */
function ruleNestedLoopAmplification(node: PlanNode): ExplainPlanFinding | null {
  const nodeType = toStringValue(node["Node Type"]) ?? "";
  if (!/nested\s*loops?/i.test(nodeType)) return null;

  const children = planChildren(node);
  let maxLoops = 0;
  for (const child of children) {
    const loops = pickNumber(child, ["Actual Loops"]) ?? 0;
    if (loops > maxLoops) maxLoops = loops;
  }
  if (maxLoops < 10000) return null;

  return buildFinding(node, "nestedLoopAmplification", "info", {
    loops: round(maxLoops),
    childCount: children.length,
  });
}

/**
 * 规则 6：物理读占比高。
 * 任意节点 "Shared Read Blocks" > 10000 且超过 "Shared Hit Blocks" 时提示 I/O 偏重、
 * 缓冲命中率偏低。
 */
function ruleIoHeavy(node: PlanNode): ExplainPlanFinding | null {
  const read = pickNumber(node, ["Shared Read Blocks", "Read Blocks"]);
  if (read === undefined || read <= 10000) return null;

  const hit = pickNumber(node, ["Shared Hit Blocks", "Hit Blocks"]) ?? 0;
  if (read <= hit) return null;

  return buildFinding(node, "ioHeavy", "info", {
    sharedReadBlocks: round(read),
    sharedHitBlocks: round(hit),
  });
}

/** requiresActual 为 true 的规则只在 EXPLAIN ANALYZE（有真实执行数据）时运行。 */
const PLAN_RULES: Array<{ requiresActual: boolean; run: PlanRule }> = [
  { requiresActual: true, run: ruleRowEstimateDeviation },
  { requiresActual: false, run: ruleSeqScanHeavyFilter },
  { requiresActual: true, run: ruleSortSpill },
  { requiresActual: true, run: ruleHashSpill },
  { requiresActual: true, run: ruleNestedLoopAmplification },
  { requiresActual: true, run: ruleIoHeavy },
];

// ── 入口 ───────────────────────────────────────────────────────────────

/** EXPLAIN 原始结果可能是 JSON 字符串，做一次防御式解析。 */
function parseRaw(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return raw;
  }
}

function extractRoots(raw: unknown): PlanNode[] {
  if (raw === null || raw === undefined) return [];
  const items: unknown[] = Array.isArray(raw) ? raw : [raw];
  const roots: PlanNode[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    roots.push(isRecord(item["Plan"]) ? item["Plan"] : item);
  }
  return roots;
}

/** 整个计划是否包含真实执行数据（Actual Rows / Actual Loops）。 */
function detectActualData(raw: unknown): boolean {
  let found = false;
  const visit = (value: unknown): void => {
    if (found) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (toNumber(value["Actual Rows"]) !== undefined || toNumber(value["Actual Loops"]) !== undefined) {
      found = true;
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(raw);
  return found;
}

/**
 * 分析 EXPLAIN (FORMAT JSON) 原始结果，返回按严重程度排序的诊断结论。
 *
 * - 递归遍历 `Plan` / `Plans` 子树；
 * - 同一节点同一 code 只报一次；
 * - 纯 EXPLAIN（无 Actual 数据）时只跑规则 2 的保守分支，其余跳过。
 */
export function analyzeExplainPlan(raw: unknown): ExplainPlanFinding[] {
  const parsed = parseRaw(raw);
  const roots = extractRoots(parsed);
  if (roots.length === 0) return [];

  const hasActualData = detectActualData(parsed);
  const findings: ExplainPlanFinding[] = [];
  const seen = new Set<string>();
  let nodeIndex = 0;

  const visit = (node: PlanNode): void => {
    const nodeId = nodeIndex++;
    for (const rule of PLAN_RULES) {
      if (rule.requiresActual && !hasActualData) continue;
      const finding = rule.run(node);
      if (!finding) continue;
      const dedupeKey = `${nodeId}:${finding.code}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      findings.push(finding);
    }
    planChildren(node).forEach(visit);
  };

  roots.forEach(visit);

  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.index - b.index)
    .map((entry) => entry.finding);
}
