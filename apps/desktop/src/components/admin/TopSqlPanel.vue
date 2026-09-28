<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Copy, Database, ExternalLink, Gauge, Loader2, Plus, RefreshCcw, Table2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import * as api from "@/lib/backend/api";
import { buildTopSqlAvailabilitySql, buildTopSqlColumnsFallbackSql, buildTopSqlColumnsSql, buildTopSqlQuery, formatTopSqlCount, formatTopSqlDuration, mapTopSqlAvailability, mapTopSqlColumns, mapTopSqlRows, type TopSqlOrderBy, type TopSqlRow } from "@/lib/admin/topSql";

const props = defineProps<{
  connectionId: string;
  database: string;
  schema?: string;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const { toast } = useToast();

const TOP_LIMITS = [50, 100, 200] as const;

// Driver manifest is deliberately avoided: only PostgreSQL / openGauss expose
// pg_stat_statements, so the panel is gated on the live connection type.
const connection = computed(() => connectionStore.getConfig(props.connectionId));
const connectionName = computed(() => connection.value?.name || props.connectionId);
const supported = computed(() => {
  const type = connection.value?.db_type;
  return type === "postgres" || type === "opengauss";
});

const orderBy = ref<TopSqlOrderBy>("total");
const limit = ref<number>(50);

const columns = ref<string[]>([]);
const rows = ref<TopSqlRow[]>([]);
const loading = ref(false);
const creatingExtension = ref(false);
const loadError = ref("");
/** True when the pg_stat_statements view/extension could not be found. */
const unavailable = ref(false);
/** Whether the extension appears in pg_extension (drives the guidance text). */
const extensionInstalled = ref(false);
const lastRefreshedAt = ref("");

let generation = 0;
let disposed = false;

/** Discover which pg_stat_statements columns this server actually exposes. */
async function discoverColumns(): Promise<string[]> {
  const scoped = await api.executeQuery(props.connectionId, props.database, buildTopSqlColumnsSql(), props.schema || undefined, undefined, { maxRows: 200 });
  const discovered = mapTopSqlColumns(scoped);
  if (discovered.length > 0) return discovered;
  // The view may live outside `public` (custom install schema).
  const unscoped = await api.executeQuery(props.connectionId, props.database, buildTopSqlColumnsFallbackSql(), props.schema || undefined, undefined, { maxRows: 200 });
  return mapTopSqlColumns(unscoped);
}

/** Load the ranking rows for the current toolbar selection. */
async function load() {
  if (!supported.value || unavailable.value) return;
  const request = ++generation;
  loading.value = true;
  loadError.value = "";
  try {
    const sql = buildTopSqlQuery(columns.value, orderBy.value, limit.value);
    const result = await api.executeQuery(props.connectionId, props.database, sql, props.schema || undefined, undefined, { maxRows: limit.value });
    if (disposed || request !== generation) return;
    rows.value = mapTopSqlRows(result);
    lastRefreshedAt.value = new Date().toLocaleTimeString();
  } catch (error) {
    if (disposed || request !== generation) return;
    rows.value = [];
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (!disposed && request === generation) loading.value = false;
  }
}

/** Probe availability, then load. Safe to call repeatedly (e.g. after retry). */
async function initialize() {
  if (!supported.value) return;
  const request = ++generation;
  loading.value = true;
  loadError.value = "";
  unavailable.value = false;
  extensionInstalled.value = false;
  rows.value = [];
  columns.value = [];
  lastRefreshedAt.value = "";
  try {
    await connectionStore.ensureConnected(props.connectionId);
    const discovered = await discoverColumns();
    if (disposed || request !== generation) return;
    columns.value = discovered;
    if (discovered.length === 0) {
      // Distinguish "extension missing" from a plain permissions/query failure.
      const availability = await api.executeQuery(props.connectionId, props.database, buildTopSqlAvailabilitySql(), props.schema || undefined, undefined, { maxRows: 1 });
      if (disposed || request !== generation) return;
      extensionInstalled.value = mapTopSqlAvailability(availability);
      unavailable.value = true;
      loading.value = false;
      return;
    }
    loading.value = false;
    await load();
  } catch (error) {
    if (disposed || request !== generation) return;
    rows.value = [];
    loadError.value = error instanceof Error ? error.message : String(error);
    loading.value = false;
  }
}

/** Execute CREATE EXTENSION and re-run the availability probe on success. */
async function createExtension() {
  if (creatingExtension.value) return;
  creatingExtension.value = true;
  try {
    await api.executeQuery(props.connectionId, props.database, "CREATE EXTENSION IF NOT EXISTS pg_stat_statements", props.schema || undefined, undefined, { maxRows: 1 });
    toast(t("topSql.extensionCreated"));
    await initialize();
  } catch (error) {
    toast(t("topSql.extensionCreateFailed", { message: error instanceof Error ? error.message : String(error) }), 4000);
  } finally {
    creatingExtension.value = false;
  }
}

async function copySql(row: TopSqlRow) {
  try {
    await copyToClipboard(row.query);
    toast(t("topSql.sqlCopied"));
  } catch (error) {
    toast(t("topSql.copyFailed", { message: error instanceof Error ? error.message : String(error) }), 3000);
  }
}

/** Open the statement in a reusable SQL editor tab. */
function openInEditor(row: TopSqlRow) {
  const tabId = queryStore.createTab(props.connectionId, props.database, t("topSql.openInEditorTitle"), "query", props.schema);
  queryStore.updateSql(tabId, row.query);
}

watch(
  () => [props.connectionId, props.database, props.schema, supported.value],
  () => {
    generation++;
    void initialize();
  },
  { immediate: true },
);

// Re-run when the toolbar selection changes (only after a successful probe).
watch([orderBy, limit], () => {
  if (!supported.value || unavailable.value || columns.value.length === 0) return;
  void load();
});

onBeforeUnmount(() => {
  disposed = true;
  generation++;
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="top-sql-panel">
    <!-- Toolbar -->
    <header class="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs shrink-0 select-none">
      <div class="flex items-center gap-2">
        <Gauge class="h-4 w-4 text-primary" />
        <span class="font-semibold text-sm">{{ t("topSql.title") }}</span>
        <Badge variant="outline" class="h-5 px-2 text-[11px] font-mono">{{ connectionName }}</Badge>
        <span v-if="props.database" class="text-[11px] text-muted-foreground font-mono">{{ props.database }}</span>
      </div>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span>{{ t("topSql.orderBy") }}</span>
          <select v-model="orderBy" class="h-7 rounded-md border bg-background px-1.5 text-xs outline-none focus:border-ring" :aria-label="t('topSql.orderBy')" data-testid="top-sql-order">
            <option value="total">{{ t("topSql.orderTotal") }}</option>
            <option value="mean">{{ t("topSql.orderMean") }}</option>
            <option value="calls">{{ t("topSql.orderCalls") }}</option>
            <option value="rows">{{ t("topSql.orderRows") }}</option>
            <option value="read">{{ t("topSql.orderRead") }}</option>
          </select>
        </label>

        <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span>{{ t("topSql.topN") }}</span>
          <select v-model.number="limit" class="h-7 rounded-md border bg-background px-1.5 text-xs outline-none focus:border-ring" :aria-label="t('topSql.topN')" data-testid="top-sql-limit">
            <option v-for="value in TOP_LIMITS" :key="value" :value="value">{{ value }}</option>
          </select>
        </label>

        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" :disabled="loading || !supported" @click="load()">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          <span>{{ t("topSql.refresh") }}</span>
        </Button>

        <span v-if="lastRefreshedAt" class="text-[11px] text-muted-foreground whitespace-nowrap">{{ t("topSql.lastRefreshed", { time: lastRefreshedAt }) }}</span>
      </div>
    </header>

    <!-- Unsupported connection type -->
    <div v-if="!supported" class="flex flex-1 items-center justify-center p-6">
      <div class="max-w-md text-center space-y-2">
        <AlertTriangle class="mx-auto h-8 w-8 text-amber-500" />
        <p class="text-sm font-medium">{{ t("topSql.unsupportedTitle") }}</p>
        <p class="text-xs text-muted-foreground">{{ t("topSql.unsupportedHint") }}</p>
      </div>
    </div>

    <!-- Error state -->
    <div v-else-if="loadError" class="flex flex-1 items-center justify-center p-6">
      <div class="max-w-lg text-center space-y-3">
        <AlertTriangle class="mx-auto h-8 w-8 text-destructive" />
        <p class="text-sm font-medium">{{ t("topSql.errorTitle") }}</p>
        <p class="break-all text-xs text-muted-foreground">{{ loadError }}</p>
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" @click="initialize">
          <RefreshCcw class="h-3.5 w-3.5" />
          <span>{{ t("topSql.retry") }}</span>
        </Button>
      </div>
    </div>

    <!-- Extension unavailable guidance -->
    <div v-else-if="unavailable" class="flex flex-1 items-center justify-center p-6">
      <div class="max-w-xl space-y-3 text-center">
        <Database class="mx-auto h-8 w-8 text-muted-foreground" />
        <p class="text-sm font-medium">{{ t("topSql.unavailableTitle") }}</p>
        <p class="text-xs text-muted-foreground">{{ t("topSql.unavailableHint") }}</p>
        <pre class="mx-auto max-w-md rounded-md border bg-muted/40 p-3 text-left text-[11px] leading-relaxed overflow-x-auto">
shared_preload_libraries = 'pg_stat_statements'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;</pre
        >
        <p class="text-[11px] text-muted-foreground">{{ t("topSql.unavailableOpenGaussHint") }}</p>
        <Button v-if="!extensionInstalled" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" :disabled="creatingExtension" @click="createExtension">
          <Loader2 v-if="creatingExtension" class="h-3.5 w-3.5 animate-spin" />
          <Plus v-else class="h-3.5 w-3.5" />
          <span>{{ t("topSql.createExtension") }}</span>
        </Button>
      </div>
    </div>

    <!-- Loading skeleton -->
    <div v-else-if="loading && rows.length === 0" class="flex-1 min-h-0 p-4 space-y-2" data-testid="top-sql-loading">
      <div v-for="index in 8" :key="index" class="h-7 animate-pulse rounded bg-muted/60" />
    </div>

    <!-- Ranking table -->
    <div v-else class="flex-1 min-h-0 overflow-auto">
      <table class="w-full border-collapse text-xs">
        <thead class="sticky top-0 z-10 bg-muted/80 backdrop-blur">
          <tr class="text-left text-muted-foreground">
            <th class="w-12 px-2 py-2 text-right font-medium">#</th>
            <th class="w-24 px-2 py-2 text-right font-medium">{{ t("topSql.colTotal") }}</th>
            <th class="w-24 px-2 py-2 text-right font-medium">{{ t("topSql.colMean") }}</th>
            <th class="w-24 px-2 py-2 text-right font-medium">{{ t("topSql.colCalls") }}</th>
            <th class="w-24 px-2 py-2 text-right font-medium">{{ t("topSql.colRows") }}</th>
            <th class="px-2 py-2 font-medium">{{ t("topSql.colQuery") }}</th>
            <th class="w-36 px-2 py-2 text-right font-medium">{{ t("topSql.colActions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in rows" :key="`${index}-${row.query.slice(0, 40)}`" class="border-b border-border/60 align-top hover:bg-muted/30">
            <td class="px-2 py-1.5 text-right font-mono text-muted-foreground">{{ index + 1 }}</td>
            <td class="px-2 py-1.5 text-right font-mono">{{ formatTopSqlDuration(row.totalMs) }}</td>
            <td class="px-2 py-1.5 text-right font-mono">{{ formatTopSqlDuration(row.meanMs) }}</td>
            <td class="px-2 py-1.5 text-right font-mono">{{ formatTopSqlCount(row.calls) }}</td>
            <td class="px-2 py-1.5 text-right font-mono">{{ formatTopSqlCount(row.rowsTotal) }}</td>
            <td class="px-2 py-1.5">
              <span class="block max-w-[720px] truncate font-mono text-[11px] text-foreground/90" :title="row.query">{{ row.query }}</span>
            </td>
            <td class="px-2 py-1.5">
              <div class="flex items-center justify-end gap-1">
                <Button variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground" :title="t('topSql.copySql')" @click="copySql(row)">
                  <Copy class="h-3 w-3" />
                  <span>{{ t("topSql.copySqlShort") }}</span>
                </Button>
                <Button variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground" :title="t('topSql.openInEditor')" @click="openInEditor(row)">
                  <ExternalLink class="h-3 w-3" />
                  <span>{{ t("topSql.openInEditorShort") }}</span>
                </Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="rows.length === 0" class="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <Table2 class="h-8 w-8 text-muted-foreground" />
        <p class="text-sm font-medium">{{ t("topSql.empty") }}</p>
        <p class="text-xs text-muted-foreground">{{ t("topSql.emptyHint") }}</p>
      </div>
    </div>
  </section>
</template>
