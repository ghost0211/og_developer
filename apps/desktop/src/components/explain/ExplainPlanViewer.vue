<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, AlertOctagon, AlertTriangle, Bot, Braces, GitBranch, Info, Stethoscope, Table2, FileText, Workflow } from "@lucide/vue";
import type { ParsedExplainPlan, ExplainPlanNode } from "@/lib/diagram/explainPlan";
import { flattenExplainPlanNodes } from "@/lib/diagram/explainPlan";
import { analyzeExplainPlan } from "@/lib/diagram/explainPlanDiagnosis";
import type { ExplainPlanFindingSeverity } from "@/lib/diagram/explainPlanDiagnosis";
import { extractActualRows } from "@/lib/diagram/planCanvas";
import { buildExplainPlanAiPrompt } from "@/lib/diagram/explainPlanAiAnalysis";
import { Button } from "@/components/ui/button";
import type { ConnectionConfig, QueryResult } from "@/types/database";
import ExplainPlanNodeTree from "./ExplainPlanNodeTree.vue";
import ExplainPlanDiagram from "./ExplainPlanDiagram.vue";

const props = defineProps<{
  plan?: ParsedExplainPlan;
  error?: string;
  loading?: boolean;
  sourceSql?: string;
  explainSql?: string;
  connection?: ConnectionConfig;
  database?: string;
  schema?: string;
  tableResult?: QueryResult;
  tableError?: string;
}>();

const { t } = useI18n();
const emit = defineEmits<{
  analyzeAi: [prompt: string];
}>();
const activeView = ref<"canvas" | "tree" | "summary" | "raw" | "table">("canvas");
const hasTableView = computed(() => !!props.tableResult || !!props.tableError);

watch(
  [hasTableView, () => !!props.tableResult, () => !!props.plan, () => props.loading],
  ([available, hasTableResult, hasPlan, loading]) => {
    if (!available && activeView.value === "table") activeView.value = "canvas";
    // Wait for JSON EXPLAIN to finish so regular MySQL still defaults to its visual tree.
    if (!loading && hasTableResult && !hasPlan) activeView.value = "table";
  },
  { immediate: true },
);

const flatRows = computed(() => {
  const rows: Array<{ node: ExplainPlanNode; depth: number }> = [];
  function visit(node: ExplainPlanNode, depth: number) {
    rows.push({ node, depth });
    node.children.forEach((child) => visit(child, depth + 1));
  }
  props.plan?.nodes.forEach((node) => visit(node, 0));
  return rows;
});

const rawContent = computed(() => {
  if (!props.plan?.raw) return "";
  if (typeof props.plan.raw === "string") return props.plan.raw;
  return JSON.stringify(props.plan.raw, null, 2);
});

const isRawString = computed(() => typeof props.plan?.raw === "string");
const rawFormatLabel = computed(() => (isRawString.value ? "TEXT" : "JSON"));
const nodeCount = computed(() => (props.plan ? flattenExplainPlanNodes(props.plan.nodes).length : 0));
// Measured rows exist only when the plan was produced by a mode that ran the query (EXPLAIN ANALYZE)
const measuredRowsLabel = computed(() => {
  const databaseType = props.plan?.databaseType;
  if (databaseType !== "postgres" && databaseType !== "opengauss") return undefined;
  if (!flattenExplainPlanNodes(props.plan!.nodes).some((node) => extractActualRows(node) !== undefined)) return undefined;
  return "ANALYZE";
});

// 诊断器直接读原始 JSON（解析后的节点丢失了 Sort Method、Hash Batches 等字段）。
const findings = computed(() => {
  if (!props.plan?.raw) return [];
  try {
    return analyzeExplainPlan(props.plan.raw);
  } catch {
    return [];
  }
});

const severityIcons = { critical: AlertOctagon, warning: AlertTriangle, info: Info } as const;
const severityClasses: Record<ExplainPlanFindingSeverity, string> = {
  critical: "text-destructive",
  warning: "text-amber-500",
  info: "text-muted-foreground",
};

function tableCellText(value: unknown): string {
  if (value === null) return "NULL";
  return value === undefined ? "" : String(value);
}

function analyzeWithAi() {
  const plan = props.plan;
  const sourceSql = props.sourceSql;
  if (!plan || !sourceSql?.trim()) return;

  const connection = props.connection;
  emit(
    "analyzeAi",
    buildExplainPlanAiPrompt({
      sourceSql,
      plan,
      connection: connection
        ? {
            name: connection.name,
            databaseType: connection.db_type,
            host: connection.host,
            port: connection.port,
            database: props.database,
            schema: props.schema,
            productName: connection.database_info?.productName,
            productVersion: connection.database_info?.productVersion,
            sqlCompatibility: connection.database_info?.sqlCompatibility,
          }
        : undefined,
      diagnoses: findings.value.map((finding) => ({
        ...finding,
        summary: t(`explainDiagnosis.finding.${finding.code}`, finding.metrics),
        suggestion: t(`explainDiagnosis.suggestion.${finding.code}`),
      })),
    }),
  );
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="h-9 shrink-0 border-b px-3 flex items-center gap-2 text-xs">
      <span class="inline-flex items-center gap-1 rounded border bg-muted px-2 py-0.5 font-medium">
        <GitBranch class="h-3.5 w-3.5" />
        {{ t("explain.title") }}
      </span>
      <span v-if="plan || hasTableView" class="text-muted-foreground">
        {{ plan?.databaseType.toUpperCase() || "OPENGAUSS" }}<template v-if="plan"> · {{ t("explain.nodeCount", { count: nodeCount }) }}</template>
      </span>
      <span v-if="measuredRowsLabel" class="ml-1 inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 font-semibold text-green-700 dark:bg-green-900/30 dark:text-green-300" style="font-size: 10px">{{ measuredRowsLabel }}</span>
      <span class="flex-1" />
      <Button v-if="plan && sourceSql?.trim()" size="sm" variant="outline" class="h-7 gap-1.5 px-2 text-xs" :title="t('history.analyzeWithAi')" :aria-label="t('history.analyzeWithAi')" @click="analyzeWithAi">
        <Bot class="h-3.5 w-3.5" aria-hidden="true" />
        {{ t("history.analyzeWithAi") }}
      </Button>
      <div v-if="plan || hasTableView" class="inline-flex rounded-md border bg-muted/40 p-0.5">
        <Button v-if="plan" size="sm" :variant="activeView === 'canvas' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs gap-1" @click="activeView = 'canvas'">
          <Workflow class="h-3.5 w-3.5" />
          {{ t("explain.canvas") }}
        </Button>
        <Button v-if="plan" size="sm" :variant="activeView === 'tree' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs gap-1" @click="activeView = 'tree'">
          <GitBranch class="h-3.5 w-3.5" />
          {{ t("explain.tree") }}
        </Button>
        <Button v-if="plan" size="sm" :variant="activeView === 'summary' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs gap-1" @click="activeView = 'summary'">
          <Table2 class="h-3.5 w-3.5" />
          {{ t("explain.summary") }}
        </Button>
        <Button v-if="plan" size="sm" :variant="activeView === 'raw' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs gap-1" @click="activeView = 'raw'">
          <FileText v-if="isRawString" class="h-3.5 w-3.5" />
          <Braces v-else class="h-3.5 w-3.5" />
          {{ rawFormatLabel }}
        </Button>
        <Button v-if="hasTableView" size="sm" :variant="activeView === 'table' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs gap-1" @click="activeView = 'table'">
          <Table2 class="h-3.5 w-3.5" />
          {{ t("explain.standardTable") }}
        </Button>
      </div>
    </div>

    <div v-if="loading && !(activeView === 'table' && hasTableView)" class="flex-1 min-h-0 flex items-center justify-center text-sm text-muted-foreground">
      {{ t("explain.running") }}
    </div>

    <div v-else-if="activeView === 'table' && hasTableView" class="flex-1 min-h-0 overflow-auto">
      <div v-if="tableError" class="flex h-full min-h-0 items-center justify-center p-3">
        <div class="flex max-w-xl items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
          <span>{{ tableError }}</span>
        </div>
      </div>

      <div v-else-if="tableResult" class="p-3">
        <div class="overflow-x-auto rounded border">
          <table class="min-w-full w-max text-left text-xs">
            <thead class="bg-muted/70 text-muted-foreground">
              <tr>
                <th v-for="(column, columnIndex) in tableResult.columns" :key="columnIndex" class="whitespace-nowrap px-2 py-1.5 font-medium">{{ column }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, rowIndex) in tableResult.rows" :key="rowIndex" class="border-t">
                <td v-for="(_column, columnIndex) in tableResult.columns" :key="columnIndex" class="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                  {{ tableCellText(row[columnIndex]) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div v-else-if="error" class="flex-1 min-h-0 flex items-center justify-center">
      <div class="flex max-w-xl items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
        <span>{{ error }}</span>
      </div>
    </div>

    <div v-else-if="!plan" class="flex-1 min-h-0 flex items-center justify-center text-sm text-muted-foreground">
      {{ t("explain.empty") }}
    </div>

    <div v-else-if="activeView === 'canvas'" class="flex-1 min-h-0">
      <ExplainPlanDiagram :nodes="plan.nodes" />
    </div>

    <div v-else class="flex-1 min-h-0 overflow-auto">
      <div v-if="activeView === 'tree'" class="mx-auto max-w-5xl space-y-px p-2">
        <ExplainPlanNodeTree v-for="node in plan.nodes" :key="node.id" :node="node" />
      </div>

      <div v-else-if="activeView === 'summary'" class="p-3">
        <div class="overflow-auto rounded border">
          <table class="w-full min-w-[760px] text-left text-xs">
            <thead class="bg-muted/70 text-muted-foreground">
              <tr>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.node") }}</th>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.relation") }}</th>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.index") }}</th>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.cost") }}</th>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.rows") }}</th>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.details") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in flatRows" :key="row.node.id" class="border-t">
                <td class="px-2 py-1.5 font-medium" :style="{ paddingLeft: `${8 + row.depth * 18}px` }">
                  {{ row.node.title }}
                </td>
                <td class="px-2 py-1.5 text-muted-foreground">{{ row.node.relation || "-" }}</td>
                <td class="px-2 py-1.5 text-muted-foreground">{{ row.node.index || "-" }}</td>
                <td class="px-2 py-1.5 tabular-nums">{{ row.node.cost || "-" }}</td>
                <td class="px-2 py-1.5 tabular-nums">{{ row.node.rows || "-" }}</td>
                <td class="px-2 py-1.5 text-muted-foreground">
                  {{ row.node.details.join("; ") || "-" }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <pre v-else class="m-3 overflow-auto whitespace-pre rounded border bg-muted/30 p-3 font-mono text-xs leading-relaxed">{{ rawContent }}</pre>
    </div>

    <div v-if="plan && findings.length" class="shrink-0 border-t bg-muted/20">
      <div class="flex items-center gap-1.5 px-3 py-1.5 text-xs">
        <Stethoscope class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <span class="font-medium">{{ t("explainDiagnosis.title") }}</span>
        <span class="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{{ t("explainDiagnosis.count", { count: findings.length }) }}</span>
      </div>
      <ul class="max-h-44 space-y-1 overflow-auto px-3 pb-2">
        <li v-for="(finding, index) in findings" :key="`${finding.code}-${index}`" class="flex items-start gap-2 text-xs">
          <component :is="severityIcons[finding.severity]" class="mt-0.5 h-3.5 w-3.5 shrink-0" :class="severityClasses[finding.severity]" aria-hidden="true" />
          <span class="min-w-0">
            <span v-if="finding.relation" class="mr-1 rounded bg-muted px-1 py-0.5 text-[11px] font-medium">{{ finding.relation }}</span>
            <span class="font-medium text-foreground">{{ t(`explainDiagnosis.finding.${finding.code}`, finding.metrics) }}</span>
            <span class="ml-1 text-muted-foreground">{{ t(`explainDiagnosis.suggestion.${finding.code}`) }}</span>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>
