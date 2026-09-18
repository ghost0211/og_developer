<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Stethoscope, Code2, Loader2, RefreshCw, Search } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import * as api from "@/lib/backend/api";
import type { RoutineHealthSnapshot } from "@/lib/backend/api";
import type { ObjectSourceKind, QueryTab } from "@/types/database";
import type { RoutineHealthFinding } from "@/lib/maintenance/routineHealthAnalysis";
import { buildRoutineHealthReport, reportRowPriority, type RoutineHealthReportRow } from "@/lib/maintenance/routineHealthReport";
import { routineHealthWarningText } from "@/lib/maintenance/routineHealthWarnings";

const props = defineProps<{ tab: QueryTab }>();
const { t, te } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const schema = ref(props.tab.schema || "");
const schemas = ref<string[]>([]);
const rows = ref<RoutineHealthReportRow[]>([]);
const snapshot = ref<RoutineHealthSnapshot | null>(null);
const loading = ref(false);
const running = ref(false);
const scanError = ref("");
const optionError = ref("");
const operationMessages = ref<string[]>([]);
const search = ref("");
const statusFilter = ref("issues");
const typeFilter = ref("ALL");
const selected = ref(new Set<string>());
const analyzedAt = ref("");
let generation = 0;
let operationGeneration = 0;
let disposed = false;

const connectionName = computed(() => connectionStore.getConfig(props.tab.connectionId)?.name || props.tab.connectionId);
const visibleRows = computed(() =>
  rows.value.filter((row) => {
    const priority = reportRowPriority(row);
    if (statusFilter.value === "issues" && priority === 0) return false;
    if (statusFilter.value === "errors" && priority !== 2) return false;
    if (statusFilter.value === "review" && priority !== 1) return false;
    if (statusFilter.value === "clear" && priority !== 0) return false;
    if (typeFilter.value !== "ALL" && row.routine.objectType !== typeFilter.value) return false;
    const needle = search.value.trim().toLowerCase();
    return !needle || `${row.routine.schema}.${row.routine.name} ${row.routine.signature} ${row.findings.map(findingText).join(" ")}`.toLowerCase().includes(needle);
  }),
);
const errorCount = computed(() => rows.value.filter((row) => reportRowPriority(row) === 2).length);
const reviewCount = computed(() => rows.value.filter((row) => reportRowPriority(row) === 1).length);
const routineCount = computed(() => rows.value.filter((row) => row.origin === "analysis").length);
const selectedRows = computed(() => rows.value.filter((row) => selected.value.has(row.key) && canRetry(row)));
const retryableVisibleRows = computed(() => visibleRows.value.filter(canRetry));
const allSelected = computed(() => retryableVisibleRows.value.length > 0 && retryableVisibleRows.value.every((row) => selected.value.has(row.key)));

function findingText(finding: RoutineHealthFinding): string {
  if (finding.code === "compilation_failed") return finding.message || t("routineHealth.noCompilerDetails");
  const key = `routineHealth.findings.${finding.code}`;
  return te(key) ? t(key, { name: finding.objectName || "", detail: finding.message }) : finding.message;
}

function canRetry(row: RoutineHealthReportRow): boolean {
  return row.origin === "compilation" && !!row.compilation?.source?.trim();
}

function toggleSelection(row: RoutineHealthReportRow) {
  if (selected.value.has(row.key)) selected.value.delete(row.key);
  else selected.value.add(row.key);
}

function toggleAll() {
  const remove = allSelected.value;
  for (const row of retryableVisibleRows.value) {
    if (remove) selected.value.delete(row.key);
    else selected.value.add(row.key);
  }
}

function onSchemaChanged() {
  props.tab.schema = schema.value || undefined;
}

async function scan() {
  const request = ++generation;
  loading.value = true;
  scanError.value = "";
  selected.value.clear();
  // A failed scan must not leave an old scope's findings looking current.
  rows.value = [];
  snapshot.value = null;
  analyzedAt.value = "";
  try {
    await connectionStore.ensureConnected(props.tab.connectionId);
    const result = await api.listRoutineHealthSnapshot(props.tab.connectionId, props.tab.database, schema.value || undefined);
    if (disposed || request !== generation) return;
    rows.value = buildRoutineHealthReport(result);
    snapshot.value = result;
    analyzedAt.value = new Date().toLocaleTimeString();
  } catch (error) {
    if (!disposed && request === generation) scanError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (!disposed && request === generation) loading.value = false;
  }
}

async function initialize() {
  const request = generation;
  try {
    await connectionStore.ensureConnected(props.tab.connectionId);
    const result = await api.listSchemas(props.tab.connectionId, props.tab.database);
    if (!disposed && request === generation) schemas.value = result;
  } catch (error) {
    if (!disposed) optionError.value = String(error);
  }
  if (!disposed && request === generation) await scan();
}

function openRoutine(row: RoutineHealthReportRow) {
  const routine = row.routine;
  if (row.origin === "compilation") {
    // Historical CREATE source is not proof of a live object; never navigate an arbitrary overload.
    queryStore.createTab(props.tab.connectionId, props.tab.database, `${routine.schema}.${routine.name}`, "query", routine.schema, routine.source || "", props.tab.catalog, { forceNew: true });
    return;
  }
  const kind = routine.objectType.replace(" ", "_") as ObjectSourceKind;
  queryStore.openProgramWindow({ connectionId: props.tab.connectionId, database: props.tab.database, schema: routine.schema, name: routine.name, objectType: kind, signature: routine.signature, catalog: props.tab.catalog });
}

async function retryRecords(targets: RoutineHealthReportRow[]) {
  if (running.value || loading.value) return;
  const eligible = targets.filter(canRetry);
  if (!eligible.length) return;
  const run = ++operationGeneration;
  const connectionId = props.tab.connectionId;
  const database = props.tab.database;
  running.value = true;
  operationMessages.value = [];
  let success = 0;
  let failed = 0;
  try {
    for (const row of eligible) {
      if (disposed || run !== operationGeneration) return;
      const record = row.compilation!;
      try {
        const result = await api.recompileObject(connectionId, database, record.schema, record.name, record.objectType);
        if (disposed || run !== operationGeneration) return;
        if (result.success) success++;
        else {
          failed++;
          operationMessages.value.push(`${record.schema}.${record.name}: ${result.error || t("routineHealth.noCompilerDetails")}`);
        }
      } catch (error) {
        if (disposed || run !== operationGeneration) return;
        failed++;
        operationMessages.value.push(`${record.schema}.${record.name}: ${String(error)}`);
      }
    }
    if (disposed || run !== operationGeneration) return;
    operationMessages.value.unshift(t("routineHealth.retrySummary", { success, failed }));
    await scan();
  } finally {
    if (!disposed && run === operationGeneration) running.value = false;
  }
}

watch(
  () => [props.tab.connectionId, props.tab.database, props.tab.schema],
  () => {
    generation++;
    operationGeneration++;
    schema.value = props.tab.schema || "";
    rows.value = [];
    snapshot.value = null;
    analyzedAt.value = "";
    loading.value = true;
    running.value = false;
    optionError.value = "";
    operationMessages.value = [];
    void initialize();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  disposed = true;
  generation++;
  operationGeneration++;
});
</script>

<template>
  <section class="h-full min-h-0 flex flex-col bg-background text-foreground" data-testid="routine-health-panel">
    <header class="border-b px-4 py-3 shrink-0 space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <Stethoscope class="h-4 w-4 text-primary" />
        <h2 class="text-sm font-semibold">{{ t("invalidObjects.title") }}</h2>
        <span class="text-xs text-muted-foreground">{{ connectionName }} / {{ tab.database }}</span>
        <div class="ml-auto flex items-center gap-2">
          <label class="text-xs flex items-center gap-1">
            {{ t("invalidObjects.schema") }}
            <select v-model="schema" class="h-7 max-w-48 rounded border bg-background px-2" :disabled="loading || running" @change="onSchemaChanged">
              <option value="">{{ t("routineHealth.businessSchemas") }}</option>
              <option v-for="name in schemas" :key="name" :value="name">{{ name }}</option>
              <option v-if="schema && !schemas.includes(schema)" :value="schema">{{ schema }}</option>
            </select>
          </label>
          <Button size="sm" variant="outline" class="h-7 gap-1 text-xs" :disabled="loading || running" data-testid="analyze" @click="scan"> <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />{{ t("routineHealth.analyze") }} </Button>
        </div>
      </div>
      <p class="text-xs text-muted-foreground">{{ t("routineHealth.scopeHint") }}</p>
    </header>
    <div class="flex flex-wrap gap-2 items-center px-4 py-2 border-b text-xs shrink-0">
      <select v-model="statusFilter" class="h-7 rounded border bg-background px-2" :aria-label="t('invalidObjects.status')" data-testid="status-filter">
        <option value="issues">{{ t("routineHealth.issues") }}</option>
        <option value="errors">{{ t("routineHealth.errors") }}</option>
        <option value="review">{{ t("routineHealth.review") }}</option>
        <option value="clear">{{ t("routineHealth.noFindings") }}</option>
        <option value="all">{{ t("routineHealth.allResults") }}</option>
      </select>
      <select v-model="typeFilter" class="h-7 rounded border bg-background px-2" :aria-label="t('invalidObjects.type')">
        <option value="ALL">{{ t("invalidObjects.allTypes") }}</option>
        <option value="FUNCTION">FUNCTION</option>
        <option value="PROCEDURE">PROCEDURE</option>
        <option value="PACKAGE">PACKAGE</option>
        <option value="PACKAGE BODY">PACKAGE BODY</option>
      </select>
      <div class="relative flex-1 max-w-sm min-w-40">
        <Search class="absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-foreground" />
        <input v-model="search" class="h-7 w-full rounded border bg-background pl-7 pr-2" :placeholder="t('routineHealth.search')" />
      </div>
      <span v-if="snapshot" class="ml-auto text-muted-foreground">{{ t("routineHealth.summary", { count: routineCount, errors: errorCount, review: reviewCount }) }}</span>
    </div>
    <div class="flex-1 min-h-0 overflow-auto">
      <div v-if="scanError" role="alert" class="m-4 rounded border border-destructive/40 p-3 text-sm text-destructive whitespace-pre-wrap">{{ t("routineHealth.scanFailed") }}: {{ scanError }}</div>
      <div v-if="optionError" class="mx-4 my-2 text-xs text-amber-600">{{ t("routineHealth.schemaLoadFailed") }}: {{ optionError }}</div>
      <div v-if="snapshot?.warnings.length" class="m-4 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs space-y-1" role="status">
        <p class="font-medium">{{ t("routineHealth.coverage") }}</p>
        <p v-for="warning in snapshot.warnings" :key="warning.code + (warning.detail ?? '')" class="whitespace-pre-wrap">{{ routineHealthWarningText(warning, te, t) }}</p>
      </div>
      <div v-if="operationMessages.length" class="m-4 rounded border p-3 text-xs whitespace-pre-wrap" role="status">
        <p v-for="(message, index) in operationMessages" :key="index">{{ message }}</p>
      </div>
      <div v-if="loading" class="p-12 flex justify-center gap-2 text-sm text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("routineHealth.loading") }}</div>
      <div v-else-if="snapshot && !visibleRows.length" class="p-12 text-center text-sm text-muted-foreground">
        <p>{{ rows.length ? t("routineHealth.noMatches") : t("routineHealth.noRoutines") }}</p>
        <p class="mt-2 text-xs">{{ t("routineHealth.emptyHint") }}</p>
      </div>
      <table v-else-if="visibleRows.length" class="w-full border-collapse text-xs text-left">
        <thead class="sticky top-0 z-10 bg-muted text-muted-foreground">
          <tr>
            <th class="px-3 py-2 w-8"><input type="checkbox" :checked="allSelected" :disabled="running || loading || !retryableVisibleRows.length" :aria-label="t('routineHealth.selectRecords')" @change="toggleAll" /></th>
            <th class="p-2 w-28">{{ t("invalidObjects.status") }}</th>
            <th class="p-2 w-24">{{ t("routineHealth.origin") }}</th>
            <th class="p-2 w-1/4">{{ t("routineHealth.routine") }}</th>
            <th class="p-2">{{ t("routineHealth.results") }}</th>
            <th class="p-2 w-36">{{ t("invalidObjects.actions") }}</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="row in visibleRows" :key="row.key" class="align-top hover:bg-muted/30" :data-origin="row.origin">
            <td class="px-3 py-3"><input v-if="canRetry(row)" type="checkbox" :checked="selected.has(row.key)" :disabled="running || loading" :aria-label="row.routine.name" @change="toggleSelection(row)" /></td>
            <td class="p-2">
              <Badge :variant="reportRowPriority(row) === 2 ? 'destructive' : 'secondary'" class="whitespace-nowrap">{{
                row.origin === "compilation" ? t("routineHealth.compilationFailed") : reportRowPriority(row) === 2 ? t("routineHealth.errors") : reportRowPriority(row) === 1 ? t("routineHealth.review") : t("routineHealth.noFindings")
              }}</Badge>
            </td>
            <td class="p-2 text-muted-foreground">{{ t(`routineHealth.${row.origin}`) }}</td>
            <td class="p-2 break-words">
              <button class="text-left font-mono text-primary hover:underline" @click="openRoutine(row)">{{ row.routine.schema }}.{{ row.routine.name }}</button>
              <p class="text-muted-foreground mt-1">{{ row.routine.objectType }}</p>
              <p v-if="row.routine.signature" class="font-mono text-muted-foreground mt-1 break-all">{{ row.routine.signature }}</p>
            </td>
            <td class="p-2 space-y-1">
              <div v-for="(finding, index) in row.findings" :key="index" class="whitespace-pre-wrap break-words" :class="finding.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'">
                <span v-if="finding.line" class="font-mono mr-1">{{ t("routineHealth.line", { line: finding.line }) }}</span
                >{{ findingText(finding) }}
              </div>
              <span v-if="!row.findings.length" class="text-muted-foreground">{{ t("routineHealth.checkedHint") }}</span>
            </td>
            <td class="p-2">
              <div class="flex flex-col items-start gap-1">
                <Button variant="ghost" size="sm" class="h-7 text-xs gap-1" data-testid="open-source" :disabled="row.origin === 'compilation' && !row.routine.source" @click="openRoutine(row)"
                  ><Code2 class="h-3 w-3" />{{ t(row.origin === "compilation" ? "routineHealth.viewRecordedSource" : "routineHealth.openRoutine") }}</Button
                >
                <Button v-if="canRetry(row)" variant="outline" size="sm" class="h-7 text-xs" :disabled="running || loading" data-testid="retry-record" @click="retryRecords([row])">{{ t("routineHealth.retry") }}</Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <footer class="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t text-xs shrink-0">
      <span class="text-muted-foreground">{{ analyzedAt ? t("routineHealth.analyzedAt", { time: analyzedAt }) : t("routineHealth.notAnalyzed") }}</span>
      <div class="flex items-center gap-2">
        <span v-if="selectedRows.length" class="text-muted-foreground">{{ t("routineHealth.retryHint") }}</span>
        <Button v-if="rows.some(canRetry)" size="sm" variant="outline" class="h-7 text-xs" :disabled="running || loading || !selectedRows.length" @click="retryRecords(selectedRows)"
          ><Loader2 v-if="running" class="h-3 w-3 mr-1 animate-spin" />{{ t("routineHealth.retrySelected", { count: selectedRows.length }) }}</Button
        >
      </div>
    </footer>
  </section>
</template>
