<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, CheckCircle2, Copy, Database, ExternalLink, FileCode2, HardDrive, Layers, Loader2, Play, RefreshCcw, Search, Table2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import MetricCard from "@/components/common/MetricCard.vue";
import ToolConnectionSelect from "@/components/common/ToolConnectionSelect.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { formatError } from "@/lib/backend/errorUtils";
import * as api from "@/lib/backend/api";
import {
  buildDropIndexSql,
  buildRelationStorageTopQuery,
  buildTableBloatQuery,
  buildTablespacesFallbackQuery,
  buildTablespacesQuery,
  buildUnusedIndexesQuery,
  buildUserSchemasQuery,
  buildVacuumSql,
  formatStorageBytes,
  formatStorageCount,
  parseRelationStorageRows,
  parseTableBloatRows,
  parseTablespaceRows,
  parseUnusedIndexRows,
  parseUserSchemaRows,
  quoteQualifiedPgIdent,
  type BloatSeverity,
  type MaintenanceSqlMode,
  type RelationStorageRow,
  type TableBloatRow,
  type TablespaceInfo,
  type UnusedIndexRow,
} from "@/lib/admin/opengaussStorageBloat";

const props = defineProps<{
  connectionId: string;
  database: string;
  schema?: string;
  tabId?: string;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const { toast } = useToast();

const RELATION_LIMIT = 100;
const BLOAT_LIMIT = 150;
const INDEX_LIMIT = 150;

const connection = computed(() => connectionStore.getConfig(props.connectionId));
const supported = computed(() => {
  const type = effectiveDatabaseTypeForConnection(connection.value);
  return type === "opengauss" || type === "postgres";
});

function onToolConnectionChange(connectionId: string) {
  if (!props.tabId || connectionId === props.connectionId) return;
  const config = connectionStore.getConfig(connectionId);
  queryStore.updateConnection(props.tabId, connectionId, resolveDefaultDatabase(config ?? {}, []));
}

const activeTab = ref<"storage" | "bloat" | "indexes">("storage");
const selectedSchema = ref<string>(props.schema || "");
const userSchemas = ref<string[]>([]);

const tablespaces = ref<TablespaceInfo[]>([]);
const relationRows = ref<RelationStorageRow[]>([]);
const bloatRows = ref<TableBloatRow[]>([]);
const unusedIndexRows = ref<UnusedIndexRow[]>([]);

const loading = ref(false);
const indexesLoading = ref(false);
const analyzing = ref(false);
const hasLoadedOnce = ref(false);
const loadError = ref("");
const lastRefreshedAt = ref("");

// Sub-tab search & filter states
const storageSearch = ref("");
const bloatSearch = ref("");
const onlyNeedsMaintenance = ref(false);
const selectedBloatKeys = ref<Set<string>>(new Set());

const indexSearch = ref("");
const includeUnique = ref(false);
const onlyZeroScans = ref(false);

let generation = 0;
let indexesGeneration = 0;
let disposed = false;

async function runQuery(sql: string, maxRows = 500) {
  const res = await api.executeQuery(props.connectionId, props.database, sql, props.schema || undefined, undefined, { maxRows });
  if (res?.execution_error) {
    throw new Error(formatError(res.error ?? res.rows?.[0]?.[0] ?? "Query execution failed"));
  }
  return res;
}

async function fetchTablespaces(): Promise<TablespaceInfo[]> {
  try {
    const res = await runQuery(buildTablespacesQuery(), 500);
    return parseTablespaceRows(res);
  } catch {
    // Restricted roles may lack filesystem stat permission for pg_tablespace_size(oid).
    const fallbackRes = await runQuery(buildTablespacesFallbackQuery(), 500);
    return parseTablespaceRows(fallbackRes);
  }
}

function clearData() {
  tablespaces.value = [];
  relationRows.value = [];
  bloatRows.value = [];
  unusedIndexRows.value = [];
  selectedBloatKeys.value = new Set();
  hasLoadedOnce.value = false;
  lastRefreshedAt.value = "";
}

async function load() {
  if (!props.connectionId || !supported.value) return;
  const request = ++generation;
  const idxRequest = ++indexesGeneration;
  loading.value = true;
  loadError.value = "";
  const schemaFilter = selectedSchema.value || undefined;
  try {
    await connectionStore.ensureConnected(props.connectionId);
    if (disposed || request !== generation) return;

    const [tsList, relRes, bloatRes, idxRes] = await Promise.all([
      fetchTablespaces(),
      runQuery(buildRelationStorageTopQuery(RELATION_LIMIT, schemaFilter), RELATION_LIMIT),
      runQuery(buildTableBloatQuery(BLOAT_LIMIT, schemaFilter), BLOAT_LIMIT),
      runQuery(buildUnusedIndexesQuery(INDEX_LIMIT, schemaFilter, includeUnique.value), INDEX_LIMIT),
    ]);

    if (disposed || request !== generation || idxRequest !== indexesGeneration) return;

    tablespaces.value = tsList;
    relationRows.value = parseRelationStorageRows(relRes);
    const parsedBloat = parseTableBloatRows(bloatRes);
    bloatRows.value = parsedBloat;
    unusedIndexRows.value = parseUnusedIndexRows(idxRes);

    // Prune selections that no longer exist in the refreshed bloat list.
    const validKeys = new Set(parsedBloat.map((row) => bloatRowKey(row)));
    const retained = new Set<string>();
    for (const key of selectedBloatKeys.value) {
      if (validKeys.has(key)) retained.add(key);
    }
    selectedBloatKeys.value = retained;

    hasLoadedOnce.value = true;
    lastRefreshedAt.value = new Date().toLocaleTimeString();
  } catch (error) {
    if (disposed || request !== generation) return;
    loadError.value = formatError(error);
  } finally {
    if (!disposed && request === generation) {
      loading.value = false;
    }
  }
}

async function initialize() {
  if (!props.connectionId || !supported.value) {
    clearData();
    userSchemas.value = [];
    loadError.value = "";
    loading.value = false;
    return;
  }
  const request = ++generation;
  loading.value = true;
  loadError.value = "";
  clearData();
  try {
    await connectionStore.ensureConnected(props.connectionId);
    if (disposed || request !== generation) return;

    // Fetch user schemas alongside initial diagnostic data; a schema list failure
    // should not block loading if the main catalog views succeed.
    const schemasPromise = runQuery(buildUserSchemasQuery(), 1000)
      .then((res) => parseUserSchemaRows(res))
      .catch(() => [] as string[]);

    const schemaFilter = selectedSchema.value || undefined;
    const idxRequest = ++indexesGeneration;

    const [schemasList, tsList, relRes, bloatRes, idxRes] = await Promise.all([
      schemasPromise,
      fetchTablespaces(),
      runQuery(buildRelationStorageTopQuery(RELATION_LIMIT, schemaFilter), RELATION_LIMIT),
      runQuery(buildTableBloatQuery(BLOAT_LIMIT, schemaFilter), BLOAT_LIMIT),
      runQuery(buildUnusedIndexesQuery(INDEX_LIMIT, schemaFilter, includeUnique.value), INDEX_LIMIT),
    ]);

    if (disposed || request !== generation || idxRequest !== indexesGeneration) return;

    userSchemas.value = schemasList;
    tablespaces.value = tsList;
    relationRows.value = parseRelationStorageRows(relRes);
    bloatRows.value = parseTableBloatRows(bloatRes);
    unusedIndexRows.value = parseUnusedIndexRows(idxRes);
    hasLoadedOnce.value = true;
    lastRefreshedAt.value = new Date().toLocaleTimeString();
  } catch (error) {
    if (disposed || request !== generation) return;
    loadError.value = formatError(error);
  } finally {
    if (!disposed && request === generation) {
      loading.value = false;
    }
  }
}

async function reloadUnusedIndexes() {
  if (!props.connectionId || !supported.value || !hasLoadedOnce.value) return;
  const request = generation;
  const idxRequest = ++indexesGeneration;
  indexesLoading.value = true;
  const schemaFilter = selectedSchema.value || undefined;
  try {
    const idxRes = await runQuery(buildUnusedIndexesQuery(INDEX_LIMIT, schemaFilter, includeUnique.value), INDEX_LIMIT);
    if (disposed || request !== generation || idxRequest !== indexesGeneration) return;
    unusedIndexRows.value = parseUnusedIndexRows(idxRes);
  } catch (error) {
    if (disposed || request !== generation || idxRequest !== indexesGeneration) return;
    toast(formatError(error), 4000);
  } finally {
    if (!disposed && idxRequest === indexesGeneration) {
      indexesLoading.value = false;
    }
  }
}

function onSchemaChange() {
  selectedBloatKeys.value = new Set();
  void load();
}

// KPI Computations
const totalUserStorageBytes = computed(() => relationRows.value.reduce((sum, row) => sum + row.totalBytes, 0));
const totalTableBytes = computed(() => relationRows.value.reduce((sum, row) => sum + row.tableBytes, 0));
const totalIndexAndToastBytes = computed(() => relationRows.value.reduce((sum, row) => sum + row.indexBytes + row.toastBytes, 0));

const tablespaceKnownTotalBytes = computed<number | null>(() => {
  const known = tablespaces.value.map((item) => item.sizeBytes).filter((size): size is number => size !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, size) => sum + size, 0);
});

const bloatAlertCount = computed(() => bloatRows.value.filter((row) => row.severity === "critical" || row.severity === "warning").length);
const totalDeadTuples = computed(() => bloatRows.value.reduce((sum, row) => sum + row.deadTuples, 0));

const zeroScanIndexes = computed(() => unusedIndexRows.value.filter((row) => row.idxScan === 0));
const zeroScanIndexBytes = computed(() => zeroScanIndexes.value.reduce((sum, row) => sum + row.indexBytes, 0));

// Tab 1: Storage filtering & helpers
const filteredRelationRows = computed(() => {
  const needle = storageSearch.value.trim().toLowerCase();
  if (!needle) return relationRows.value;
  return relationRows.value.filter((row) => `${row.schema}.${row.name} ${row.tablespace} ${row.relkind}`.toLowerCase().includes(needle));
});

function relkindLabel(relkind: string): string {
  switch (relkind.toLowerCase()) {
    case "r":
      return "TABLE";
    case "p":
      return "PART";
    case "m":
      return "MATVIEW";
    default:
      return relkind.toUpperCase() || "-";
  }
}

function storageComposition(row: RelationStorageRow) {
  const indexAndToast = Math.max(0, row.indexBytes) + Math.max(0, row.toastBytes);
  const table = Math.max(0, row.tableBytes);
  const total = Math.max(row.totalBytes, table + indexAndToast);
  if (total <= 0) {
    return { tablePct: 0, indexPct: 0, toastPct: 0, indexAndToastBytes: indexAndToast };
  }
  const tablePct = Math.min(100, Math.max(0, (table / total) * 100));
  const indexPct = Math.min(100 - tablePct, Math.max(0, (Math.max(0, row.indexBytes) / total) * 100));
  const toastPct = Math.min(100 - tablePct - indexPct, Math.max(0, (Math.max(0, row.toastBytes) / total) * 100));
  return { tablePct, indexPct, toastPct, indexAndToastBytes: indexAndToast };
}

function openTableStructure(row: RelationStorageRow) {
  queryStore.openTableStructure(props.connectionId, props.database, row.schema, row.name);
}

// Tab 2: Bloat filtering, selection, & maintenance actions
function bloatRowKey(row: Pick<TableBloatRow, "schema" | "name">): string {
  return `${row.schema}\0${row.name}`;
}

const filteredBloatRows = computed(() => {
  const needle = bloatSearch.value.trim().toLowerCase();
  return bloatRows.value.filter((row) => {
    if (onlyNeedsMaintenance.value && row.severity === "healthy") return false;
    if (!needle) return true;
    return `${row.schema}.${row.name} ${row.severity}`.toLowerCase().includes(needle);
  });
});

const selectedBloatRows = computed(() => bloatRows.value.filter((row) => selectedBloatKeys.value.has(bloatRowKey(row))));

const allVisibleBloatSelected = computed(() => {
  if (filteredBloatRows.value.length === 0) return false;
  return filteredBloatRows.value.every((row) => selectedBloatKeys.value.has(bloatRowKey(row)));
});

function toggleBloatRow(row: TableBloatRow) {
  const key = bloatRowKey(row);
  const next = new Set(selectedBloatKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selectedBloatKeys.value = next;
}

function toggleAllVisibleBloat() {
  const next = new Set(selectedBloatKeys.value);
  if (allVisibleBloatSelected.value) {
    for (const row of filteredBloatRows.value) {
      next.delete(bloatRowKey(row));
    }
  } else {
    for (const row of filteredBloatRows.value) {
      next.add(bloatRowKey(row));
    }
  }
  selectedBloatKeys.value = next;
}

function severityBadgeClass(severity: BloatSeverity): string {
  switch (severity) {
    case "critical":
      return "border-destructive/40 bg-destructive/15 text-destructive";
    case "warning":
      return "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400";
    case "healthy":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  }
}

function severityLabel(severity: BloatSeverity): string {
  switch (severity) {
    case "critical":
      return t("storageBloat.severityCritical");
    case "warning":
      return t("storageBloat.severityWarning");
    case "healthy":
      return t("storageBloat.severityHealthy");
  }
}

function latestTimestamp(primary: string, auto: string): string {
  if (!primary && !auto) return "-";
  if (!primary) return auto;
  if (!auto) return primary;
  return primary >= auto ? primary : auto;
}

function toMaintenanceTargets(list: readonly Pick<TableBloatRow, "schema" | "name">[]): Array<{ schema: string; table: string }> {
  return list.map((item) => ({ schema: item.schema, table: item.name }));
}

function openMaintenanceScript(targets: Array<{ schema: string; table: string }>, mode: Exclude<MaintenanceSqlMode, "analyze">, actionTag: string) {
  const sql = buildVacuumSql(targets, mode);
  if (!sql) return;
  const tabTitle = `${t("storageBloat.scriptTabTitle")} · ${actionTag}`;
  const tabId = queryStore.createTab(props.connectionId, props.database, tabTitle, "query", props.schema || undefined, undefined, undefined, { forceNew: true });
  queryStore.updateSql(tabId, sql);
}

async function runAnalyzeTargets(targets: Array<{ schema: string; table: string }>) {
  if (analyzing.value || targets.length === 0) return;
  const fullSql = buildVacuumSql(targets, "analyze");
  if (!fullSql) return;

  analyzing.value = true;
  let executedCount = 0;
  try {
    const outcome = await executeWithProductionSqlGuard({
      connection: connection.value,
      database: props.database,
      sql: fullSql,
      source: t("storageBloat.title"),
      execute: async () => {
        toast(t("storageBloat.analyzeRunning"), 3000);
        for (const target of targets) {
          const singleStmt = `ANALYZE ${quoteQualifiedPgIdent(target.schema, target.table)};`;
          await runQuery(singleStmt, 1);
          executedCount += 1;
        }
        return executedCount;
      },
    });
    if (disposed || outcome === undefined) return;
    toast(t("storageBloat.analyzeDone", { count: outcome }), 2500);
    await load();
  } catch (error) {
    if (disposed) return;
    const message = formatError(error);
    toast(t("storageBloat.analyzeFailed", { message }), 4000);
    if (executedCount > 0) {
      await load();
    }
  } finally {
    if (!disposed) {
      analyzing.value = false;
    }
  }
}

// Tab 3: Unused indexes filtering & actions
const filteredUnusedIndexRows = computed(() => {
  const needle = indexSearch.value.trim().toLowerCase();
  return unusedIndexRows.value.filter((row) => {
    if (onlyZeroScans.value && row.idxScan !== 0) return false;
    if (!needle) return true;
    return `${row.schema}.${row.tableName} ${row.indexName} ${row.indexDef}`.toLowerCase().includes(needle);
  });
});

async function copyDropSql(row: UnusedIndexRow) {
  try {
    await copyToClipboard(buildDropIndexSql(row.schema, row.indexName, true));
    toast(t("storageBloat.dropSqlCopied"), 2000);
  } catch (error) {
    toast(formatError(error), 3000);
  }
}

function openDropScript(row: UnusedIndexRow) {
  const dropSql = buildDropIndexSql(row.schema, row.indexName, true);
  const script = [`-- Table: ${quoteQualifiedPgIdent(row.schema, row.tableName)} (idx_scan: ${row.idxScan}, size: ${formatStorageBytes(row.indexBytes)})`, "-- Note: DROP INDEX CONCURRENTLY must be executed outside a transaction block.", dropSql].join("\n");
  const tabTitle = `${t("storageBloat.scriptTabTitle")} · DROP INDEX`;
  const tabId = queryStore.createTab(props.connectionId, props.database, tabTitle, "query", row.schema || props.schema || undefined, undefined, undefined, { forceNew: true });
  queryStore.updateSql(tabId, script);
}

watch(
  () => [props.connectionId, props.database, props.schema, supported.value] as const,
  () => {
    generation++;
    indexesGeneration++;
    selectedSchema.value = props.schema || "";
    void initialize();
  },
  { immediate: true },
);

watch(includeUnique, () => {
  void reloadUnusedIndexes();
});

onBeforeUnmount(() => {
  disposed = true;
  generation++;
  indexesGeneration++;
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="storage-bloat-panel">
    <!-- Toolbar -->
    <header class="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs shrink-0 select-none">
      <div class="flex items-center gap-2">
        <HardDrive class="h-4 w-4 text-primary" />
        <span class="font-semibold text-sm">{{ t("storageBloat.title") }}</span>
        <ToolConnectionSelect :model-value="props.connectionId" kind="pg-stats" :disabled="loading || analyzing" @update:model-value="onToolConnectionChange" />
        <Badge v-if="props.database" variant="outline" class="h-5 max-w-40 truncate rounded-md px-1.5 font-mono text-[11px]" :title="props.database">
          {{ props.database }}
        </Badge>
      </div>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <select
          v-model="selectedSchema"
          class="h-7 max-w-44 rounded-md border bg-background px-2 text-xs outline-none focus:border-ring"
          :disabled="loading || analyzing || !supported || !props.connectionId"
          :aria-label="t('storageBloat.colSchema')"
          data-testid="storage-bloat-schema"
          @change="onSchemaChange"
        >
          <option value="">{{ t("storageBloat.allSchemas") }}</option>
          <option v-for="schemaName in userSchemas" :key="schemaName" :value="schemaName">{{ schemaName }}</option>
          <option v-if="selectedSchema && !userSchemas.includes(selectedSchema)" :value="selectedSchema">{{ selectedSchema }}</option>
        </select>

        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" :disabled="loading || analyzing || !supported || !props.connectionId" data-testid="storage-bloat-refresh" @click="load()">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          <span>{{ t("storageBloat.refresh") }}</span>
        </Button>

        <span v-if="lastRefreshedAt" class="text-[11px] text-muted-foreground whitespace-nowrap">
          {{ t("storageBloat.lastRefreshed", { time: lastRefreshedAt }) }}
        </span>
      </div>
    </header>

    <!-- No connection available -->
    <div v-if="!props.connectionId" class="flex flex-1 items-center justify-center p-6">
      <div class="max-w-md text-center space-y-2">
        <Database class="mx-auto h-8 w-8 text-muted-foreground" />
        <p class="text-sm font-medium">{{ t("storageBloat.noConnections") }}</p>
      </div>
    </div>

    <!-- Unsupported connection type -->
    <div v-else-if="!supported" class="flex flex-1 items-center justify-center p-6">
      <div class="max-w-md text-center space-y-2">
        <AlertTriangle class="mx-auto h-8 w-8 text-amber-500" />
        <p class="text-sm font-medium">{{ t("storageBloat.unsupportedTitle") }}</p>
        <p class="text-xs text-muted-foreground">{{ t("storageBloat.unsupportedHint") }}</p>
      </div>
    </div>

    <!-- Error state -->
    <div v-else-if="loadError" class="flex flex-1 items-center justify-center p-6">
      <div class="max-w-lg text-center space-y-3">
        <AlertTriangle class="mx-auto h-8 w-8 text-destructive" />
        <p class="text-sm font-medium">{{ t("storageBloat.loadFailed") }}</p>
        <p class="break-all text-xs text-muted-foreground">{{ loadError }}</p>
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" @click="initialize">
          <RefreshCcw class="h-3.5 w-3.5" />
          <span>{{ t("storageBloat.retry") }}</span>
        </Button>
      </div>
    </div>

    <!-- Initial loading skeleton -->
    <div v-else-if="loading && !hasLoadedOnce" class="flex-1 min-h-0 p-4 space-y-3" data-testid="storage-bloat-loading">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div v-for="idx in 4" :key="idx" class="h-20 animate-pulse rounded-lg bg-muted/60" />
      </div>
      <div v-for="idx in 8" :key="idx" class="h-7 animate-pulse rounded bg-muted/60" />
    </div>

    <!-- Main Dashboard -->
    <div v-else class="flex flex-1 min-h-0 flex-col">
      <!-- KPI Row -->
      <div class="grid shrink-0 grid-cols-2 gap-2.5 border-b bg-muted/15 px-3 py-2.5 lg:grid-cols-4">
        <MetricCard :label="t('storageBloat.kpiTotalStorage')" :value="formatStorageBytes(totalUserStorageBytes)" :sub="`${formatStorageCount(relationRows.length)} · ${formatStorageBytes(totalTableBytes)} / ${formatStorageBytes(totalIndexAndToastBytes)}`" :icon="HardDrive" />
        <MetricCard :label="t('storageBloat.kpiTablespaces')" :value="formatStorageCount(tablespaces.length)" :sub="tablespaceKnownTotalBytes !== null ? formatStorageBytes(tablespaceKnownTotalBytes) : undefined" :icon="Database" />
        <MetricCard :label="t('storageBloat.kpiBloatTables')" :value="formatStorageCount(bloatAlertCount)" :sub="`${t('storageBloat.kpiDeadTuples')}: ${formatStorageCount(totalDeadTuples)}`" :icon="AlertTriangle" />
        <MetricCard :label="t('storageBloat.kpiZeroScanIndexes')" :value="formatStorageCount(zeroScanIndexes.length)" :sub="formatStorageBytes(zeroScanIndexBytes)" :icon="Layers" />
      </div>

      <!-- Sub-tab Bar -->
      <div class="flex shrink-0 items-center justify-between gap-2 border-b bg-muted/25 px-3 py-1.5 text-xs select-none">
        <div class="flex items-center gap-1 rounded-md border bg-muted/60 p-0.5">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-all"
            :class="activeTab === 'storage' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            data-testid="tab-storage"
            @click="activeTab = 'storage'"
          >
            <HardDrive class="h-3.5 w-3.5 text-primary" />
            <span>{{ t("storageBloat.tabStorage") }}</span>
            <span class="rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">{{ relationRows.length }}</span>
          </button>

          <button type="button" class="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-all" :class="activeTab === 'bloat' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" data-testid="tab-bloat" @click="activeTab = 'bloat'">
            <AlertTriangle class="h-3.5 w-3.5" :class="bloatAlertCount > 0 ? 'text-amber-500' : 'text-muted-foreground'" />
            <span>{{ t("storageBloat.tabBloat") }}</span>
            <span class="rounded-full px-1.5 py-0.2 text-[10px] font-mono" :class="bloatAlertCount > 0 ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300 font-semibold' : 'bg-muted'">
              {{ bloatAlertCount > 0 ? bloatAlertCount : bloatRows.length }}
            </span>
          </button>

          <button
            type="button"
            class="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-all"
            :class="activeTab === 'indexes' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            data-testid="tab-indexes"
            @click="activeTab = 'indexes'"
          >
            <Layers class="h-3.5 w-3.5 text-blue-500" />
            <span>{{ t("storageBloat.tabIndexes") }}</span>
            <span class="rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">{{ unusedIndexRows.length }}</span>
          </button>
        </div>
      </div>

      <!-- Tab 1: Storage & Tablespaces -->
      <div v-if="activeTab === 'storage'" class="flex flex-1 min-h-0 flex-col">
        <!-- Tablespaces summary strip -->
        <div v-if="tablespaces.length > 0" class="shrink-0 border-b bg-muted/10 px-3 py-2">
          <div class="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Database class="h-3.5 w-3.5" />
            <span>{{ t("storageBloat.tablespacesTitle") }}</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <div v-for="ts in tablespaces" :key="ts.name" class="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs">
              <span class="font-mono font-semibold">{{ ts.name }}</span>
              <Badge variant="secondary" class="h-4 px-1.5 font-mono text-[10px]">
                {{ formatStorageBytes(ts.sizeBytes) }}
              </Badge>
              <span v-if="ts.owner" class="text-[11px] text-muted-foreground">{{ ts.owner }}</span>
              <span v-if="ts.location" class="max-w-52 truncate font-mono text-[10px] text-muted-foreground" :title="ts.location">
                {{ ts.location }}
              </span>
            </div>
          </div>
        </div>

        <!-- Storage Filter Bar -->
        <div class="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
          <div class="relative w-64">
            <Search class="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-foreground" />
            <input v-model="storageSearch" class="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs outline-none focus:border-ring placeholder:text-muted-foreground" :placeholder="t('storageBloat.searchPlaceholder')" />
          </div>
        </div>

        <!-- Relation Storage Table -->
        <div class="flex-1 min-h-0 overflow-auto">
          <table class="w-full border-collapse text-xs">
            <thead class="sticky top-0 z-10 bg-muted/85 backdrop-blur">
              <tr class="border-b text-left text-muted-foreground">
                <th class="px-2.5 py-2 font-medium">{{ t("storageBloat.colSchema") }}</th>
                <th class="px-2.5 py-2 font-medium">{{ t("storageBloat.colObject") }}</th>
                <th class="w-20 px-2.5 py-2 font-medium">{{ t("storageBloat.colKind") }}</th>
                <th class="px-2.5 py-2 font-medium">{{ t("storageBloat.colTablespace") }}</th>
                <th class="w-24 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colTotalSize") }}</th>
                <th class="w-24 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colTableSize") }}</th>
                <th class="w-28 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colIndexToastSize") }}</th>
                <th class="w-40 px-2.5 py-2 font-medium">{{ t("storageBloat.colComposition") }}</th>
                <th class="w-24 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colEstRows") }}</th>
                <th class="w-28 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colActions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in filteredRelationRows" :key="`${row.schema}.${row.name}`" class="border-b border-border/60 hover:bg-muted/30">
                <td class="px-2.5 py-1.5 font-mono text-muted-foreground">{{ row.schema }}</td>
                <td class="px-2.5 py-1.5 font-mono font-medium">{{ row.name }}</td>
                <td class="px-2.5 py-1.5">
                  <Badge variant="outline" class="h-4 px-1.5 font-mono text-[10px]" :title="row.relkind">{{ relkindLabel(row.relkind) }}</Badge>
                </td>
                <td class="px-2.5 py-1.5 font-mono text-muted-foreground">{{ row.tablespace || "-" }}</td>
                <td class="px-2.5 py-1.5 text-right font-mono font-semibold tabular-nums">{{ formatStorageBytes(row.totalBytes) }}</td>
                <td class="px-2.5 py-1.5 text-right font-mono tabular-nums">{{ formatStorageBytes(row.tableBytes) }}</td>
                <td class="px-2.5 py-1.5 text-right font-mono tabular-nums text-muted-foreground" :title="`${formatStorageBytes(row.indexBytes)} + ${formatStorageBytes(row.toastBytes)}`">
                  {{ formatStorageBytes(storageComposition(row).indexAndToastBytes) }}
                </td>
                <td class="px-2.5 py-1.5">
                  <div class="flex h-2 w-full overflow-hidden rounded-full bg-muted" :title="`${t('storageBloat.colTableSize')}: ${formatStorageBytes(row.tableBytes)} | ${t('storageBloat.colIndexToastSize')}: ${formatStorageBytes(storageComposition(row).indexAndToastBytes)}`">
                    <div class="h-full bg-blue-500 transition-all" :style="{ width: `${storageComposition(row).tablePct}%` }" />
                    <div class="h-full bg-amber-500 transition-all" :style="{ width: `${storageComposition(row).indexPct}%` }" />
                    <div class="h-full bg-purple-500 transition-all" :style="{ width: `${storageComposition(row).toastPct}%` }" />
                  </div>
                </td>
                <td class="px-2.5 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ formatStorageCount(row.estimatedRows) }}</td>
                <td class="px-2.5 py-1.5 text-right">
                  <Button variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground" @click="openTableStructure(row)">
                    <ExternalLink class="h-3 w-3" />
                    <span>{{ t("storageBloat.openStructure") }}</span>
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="filteredRelationRows.length === 0" class="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Table2 class="h-8 w-8 text-muted-foreground" />
            <p class="text-sm font-medium">{{ t("storageBloat.emptyStorage") }}</p>
          </div>
        </div>
      </div>

      <!-- Tab 2: Dead-Tuple Bloat & Maintenance -->
      <div v-else-if="activeTab === 'bloat'" class="flex flex-1 min-h-0 flex-col">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5 text-xs shrink-0">
          <div class="flex flex-wrap items-center gap-3">
            <div class="relative w-56">
              <Search class="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-foreground" />
              <input v-model="bloatSearch" class="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs outline-none focus:border-ring placeholder:text-muted-foreground" :placeholder="t('storageBloat.searchPlaceholder')" />
            </div>

            <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
              <input v-model="onlyNeedsMaintenance" type="checkbox" class="h-3.5 w-3.5 accent-primary" data-testid="toggle-needs-maintenance" />
              <span>{{ t("storageBloat.onlyNeedsMaintenance") }}</span>
            </label>
          </div>

          <div class="flex flex-wrap items-center gap-1.5">
            <span v-if="selectedBloatRows.length > 0" class="mr-1 text-[11px] font-medium text-primary">
              {{ t("storageBloat.selectedCount", { count: selectedBloatRows.length }) }}
            </span>

            <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[11px]" :disabled="selectedBloatRows.length === 0 || analyzing" data-testid="batch-vacuum-script" @click="openMaintenanceScript(toMaintenanceTargets(selectedBloatRows), 'vacuum_analyze', 'VACUUM ANALYZE')">
              <FileCode2 class="h-3 w-3" />
              <span>{{ t("storageBloat.openVacuumScript") }}</span>
            </Button>

            <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[11px]" :disabled="selectedBloatRows.length === 0 || analyzing" data-testid="batch-analyze-now" @click="runAnalyzeTargets(toMaintenanceTargets(selectedBloatRows))">
              <Loader2 v-if="analyzing" class="h-3 w-3 animate-spin" />
              <Play v-else class="h-3 w-3" />
              <span>{{ t("storageBloat.runAnalyzeNow") }}</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              class="h-7 gap-1 px-2 text-[11px] border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
              :disabled="selectedBloatRows.length === 0 || analyzing"
              data-testid="batch-vacuum-full-script"
              @click="openMaintenanceScript(toMaintenanceTargets(selectedBloatRows), 'vacuum_full', 'VACUUM FULL')"
            >
              <FileCode2 class="h-3 w-3" />
              <span>{{ t("storageBloat.openVacuumFullScript") }}</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              class="h-7 gap-1 px-2 text-[11px] border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
              :disabled="selectedBloatRows.length === 0 || analyzing"
              data-testid="batch-reindex-script"
              @click="openMaintenanceScript(toMaintenanceTargets(selectedBloatRows), 'reindex', 'REINDEX')"
            >
              <FileCode2 class="h-3 w-3" />
              <span>{{ t("storageBloat.openReindexScript") }}</span>
            </Button>
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-auto">
          <table class="w-full border-collapse text-xs">
            <thead class="sticky top-0 z-10 bg-muted/85 backdrop-blur">
              <tr class="border-b text-left text-muted-foreground">
                <th class="w-8 px-2.5 py-2 text-center">
                  <input type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="allVisibleBloatSelected" :disabled="filteredBloatRows.length === 0" @change="toggleAllVisibleBloat" />
                </th>
                <th class="px-2.5 py-2 font-medium">{{ t("storageBloat.colSchema") }}</th>
                <th class="px-2.5 py-2 font-medium">{{ t("storageBloat.colObject") }}</th>
                <th class="w-24 px-2.5 py-2 font-medium">{{ t("storageBloat.colSeverity") }}</th>
                <th class="w-24 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colDeadTuples") }}</th>
                <th class="w-24 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colDeadRatio") }}</th>
                <th class="w-24 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colLiveTuples") }}</th>
                <th class="w-24 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colTotalSize") }}</th>
                <th class="w-32 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colScans") }}</th>
                <th class="w-36 px-2.5 py-2 font-medium">{{ t("storageBloat.colLastVacuum") }}</th>
                <th class="w-36 px-2.5 py-2 font-medium">{{ t("storageBloat.colLastAnalyze") }}</th>
                <th class="w-40 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colActions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in filteredBloatRows" :key="bloatRowKey(row)" class="border-b border-border/60 hover:bg-muted/30">
                <td class="px-2.5 py-1.5 text-center">
                  <input type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="selectedBloatKeys.has(bloatRowKey(row))" @change="toggleBloatRow(row)" />
                </td>
                <td class="px-2.5 py-1.5 font-mono text-muted-foreground">{{ row.schema }}</td>
                <td class="px-2.5 py-1.5 font-mono font-medium">{{ row.name }}</td>
                <td class="px-2.5 py-1.5">
                  <span class="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium" :class="severityBadgeClass(row.severity)">
                    {{ severityLabel(row.severity) }}
                  </span>
                </td>
                <td class="px-2.5 py-1.5 text-right font-mono font-semibold tabular-nums" :class="row.severity === 'critical' ? 'text-destructive' : row.severity === 'warning' ? 'text-amber-600 dark:text-amber-400' : ''">
                  {{ formatStorageCount(row.deadTuples) }}
                </td>
                <td class="px-2.5 py-1.5 text-right font-mono tabular-nums">{{ row.deadRatioPct.toFixed(2) }}%</td>
                <td class="px-2.5 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{{ formatStorageCount(row.liveTuples) }}</td>
                <td class="px-2.5 py-1.5 text-right font-mono tabular-nums">{{ formatStorageBytes(row.totalBytes) }}</td>
                <td class="px-2.5 py-1.5 text-right font-mono tabular-nums text-muted-foreground" :title="`seq_scan: ${row.seqScan} / idx_scan: ${row.idxScan}`">{{ formatStorageCount(row.seqScan) }} / {{ formatStorageCount(row.idxScan) }}</td>
                <td class="px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground whitespace-nowrap" :title="`vacuum: ${row.lastVacuum || '-'} | autovacuum: ${row.lastAutovacuum || '-'}`">
                  {{ latestTimestamp(row.lastVacuum, row.lastAutovacuum) }}
                </td>
                <td class="px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground whitespace-nowrap" :title="`analyze: ${row.lastAnalyze || '-'} | autoanalyze: ${row.lastAutoanalyze || '-'}`">
                  {{ latestTimestamp(row.lastAnalyze, row.lastAutoanalyze) }}
                </td>
                <td class="px-2.5 py-1.5">
                  <div class="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground" :disabled="analyzing" @click="runAnalyzeTargets([{ schema: row.schema, table: row.name }])">
                      <Play class="h-3 w-3" />
                      <span>ANALYZE</span>
                    </Button>
                    <Button variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground" @click="openMaintenanceScript([{ schema: row.schema, table: row.name }], 'vacuum_analyze', 'VACUUM ANALYZE')">
                      <FileCode2 class="h-3 w-3" />
                      <span>VACUUM</span>
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="filteredBloatRows.length === 0" class="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <CheckCircle2 class="h-8 w-8 text-emerald-500" />
            <p class="text-sm font-medium">{{ t("storageBloat.emptyBloat") }}</p>
          </div>
        </div>
      </div>

      <!-- Tab 3: Unused Index Advisor -->
      <div v-else class="flex flex-1 min-h-0 flex-col">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5 text-xs shrink-0">
          <div class="flex flex-wrap items-center gap-3">
            <div class="relative w-64">
              <Search class="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-foreground" />
              <input v-model="indexSearch" class="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs outline-none focus:border-ring placeholder:text-muted-foreground" :placeholder="t('storageBloat.searchPlaceholder')" />
            </div>

            <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
              <input v-model="includeUnique" type="checkbox" class="h-3.5 w-3.5 accent-primary" data-testid="toggle-include-unique" />
              <span>{{ t("storageBloat.includeUniqueIndexes") }}</span>
            </label>

            <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
              <input v-model="onlyZeroScans" type="checkbox" class="h-3.5 w-3.5 accent-primary" data-testid="toggle-only-zero-scans" />
              <span>{{ t("storageBloat.onlyZeroScans") }}</span>
            </label>
          </div>

          <Loader2 v-if="indexesLoading" class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </div>

        <div class="flex-1 min-h-0 overflow-auto">
          <table class="w-full border-collapse text-xs">
            <thead class="sticky top-0 z-10 bg-muted/85 backdrop-blur">
              <tr class="border-b text-left text-muted-foreground">
                <th class="px-2.5 py-2 font-medium">{{ t("storageBloat.colSchema") }}</th>
                <th class="px-2.5 py-2 font-medium">{{ t("storageBloat.colObject") }}</th>
                <th class="px-2.5 py-2 font-medium">{{ t("storageBloat.colIndexName") }}</th>
                <th class="w-24 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colIndexSize") }}</th>
                <th class="w-28 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colIndexScans") }}</th>
                <th class="px-2.5 py-2 font-medium">{{ t("storageBloat.colDefinition") }}</th>
                <th class="w-48 px-2.5 py-2 text-right font-medium">{{ t("storageBloat.colActions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in filteredUnusedIndexRows" :key="`${row.schema}.${row.indexName}`" class="border-b border-border/60 align-top hover:bg-muted/30">
                <td class="px-2.5 py-1.5 font-mono text-muted-foreground">{{ row.schema }}</td>
                <td class="px-2.5 py-1.5 font-mono">{{ row.tableName }}</td>
                <td class="px-2.5 py-1.5">
                  <div class="flex items-center gap-1.5">
                    <span class="font-mono font-medium">{{ row.indexName }}</span>
                    <Badge v-if="row.isUnique" variant="secondary" class="h-4 px-1 text-[10px]">
                      {{ t("storageBloat.uniqueTag") }}
                    </Badge>
                  </div>
                </td>
                <td class="px-2.5 py-1.5 text-right font-mono font-semibold tabular-nums">{{ formatStorageBytes(row.indexBytes) }}</td>
                <td class="px-2.5 py-1.5 text-right font-mono tabular-nums" :title="`idx_scan: ${row.idxScan} | idx_tup_read: ${row.idxTupRead} | idx_tup_fetch: ${row.idxTupFetch}`">
                  <div :class="row.idxScan === 0 ? 'font-semibold text-amber-600 dark:text-amber-400' : ''">
                    {{ formatStorageCount(row.idxScan) }}
                  </div>
                  <div class="text-[10px] text-muted-foreground">{{ formatStorageCount(row.idxTupRead) }} / {{ formatStorageCount(row.idxTupFetch) }}</div>
                </td>
                <td class="px-2.5 py-1.5">
                  <span class="block max-w-[460px] truncate font-mono text-[11px] text-muted-foreground" :title="row.indexDef">
                    {{ row.indexDef || "-" }}
                  </span>
                </td>
                <td class="px-2.5 py-1.5">
                  <div class="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground" @click="copyDropSql(row)">
                      <Copy class="h-3 w-3" />
                      <span>{{ t("storageBloat.copyDropSql") }}</span>
                    </Button>
                    <Button variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground" @click="openDropScript(row)">
                      <ExternalLink class="h-3 w-3" />
                      <span>{{ t("storageBloat.openDropScript") }}</span>
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="filteredUnusedIndexRows.length === 0" class="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Layers class="h-8 w-8 text-muted-foreground" />
            <p class="text-sm font-medium">{{ t("storageBloat.emptyIndexes") }}</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
