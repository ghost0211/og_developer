<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Copy, Database, ExternalLink, Eye, Info, Loader2, Lock, Pencil, RefreshCcw, RotateCcw, Search, SlidersHorizontal, Table2, X } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import ToolConnectionSelect from "@/components/common/ToolConnectionSelect.vue";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { BackendErrorException, formatError } from "@/lib/backend/errorUtils";
import { copyToClipboard } from "@/lib/common/clipboard";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { toolConnections } from "@/lib/database/toolTargets";
import {
  buildGsGucCliCommand,
  buildGucAlterSystemSql,
  buildGucParametersFallbackQuery,
  buildGucParametersQuery,
  buildGucSessionSetSql,
  filterGucParameters,
  gucContextLevel,
  isMissingGucColumnError,
  normalizeGucBoolValue,
  parseGucParametersRows,
  type GucContextLevel,
  type GucPresetFilter,
  type OpenGaussGucParameter,
} from "@/lib/admin/opengaussGucParameters";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { QueryResult } from "@/types/database";

const props = defineProps<{
  connectionId: string;
  database: string;
  schema?: string;
  tabId?: string;
}>();

type GucQueryTier = "full" | "no_pending_restart" | "fallback";

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const { toast } = useToast();

const connection = computed(() => connectionStore.getConfig(props.connectionId));
const hasEligibleConnections = computed(() => toolConnections(connectionStore.connections ?? [], "pg-stats").length > 0);
const supported = computed(() => {
  const type = effectiveDatabaseTypeForConnection(connection.value);
  return type === "postgres" || type === "opengauss";
});

function onToolConnectionChange(connectionId: string) {
  if (!props.tabId || connectionId === props.connectionId) return;
  const config = connectionStore.getConfig(connectionId);
  queryStore.updateConnection(props.tabId, connectionId, resolveDefaultDatabase(config ?? {}, []));
}

const parameters = ref<OpenGaussGucParameter[]>([]);
const loading = ref(false);
const loadError = ref("");

const search = ref("");
const activePreset = ref<GucPresetFilter>("all");
const selectedCategory = ref<string>("all");
const selectedContext = ref<GucContextLevel | "all">("all");
const modifiedOnly = ref(false);

const dialogOpen = ref(false);
const selectedParam = ref<OpenGaussGucParameter | null>(null);
const draftValue = ref("");

let generation = 0;
let disposed = false;
let queryTier: GucQueryTier = "full";

const presetOptions = computed<Array<{ id: GucPresetFilter; labelKey: string }>>(() => [
  { id: "all", labelKey: "gucParams.presetAll" },
  { id: "memory_concurrency", labelKey: "gucParams.presetMemory" },
  { id: "compatibility", labelKey: "gucParams.presetCompatibility" },
  { id: "audit_perf", labelKey: "gucParams.presetAuditPerf" },
  { id: "restart", labelKey: "gucParams.presetRestart" },
]);

const categories = computed(() => Array.from(new Set(parameters.value.map((item) => item.category).filter(Boolean))).sort((a, b) => a.localeCompare(b)));

const modifiedCount = computed(() => parameters.value.filter((item) => item.modified).length);
const pendingRestartCount = computed(() => parameters.value.filter((item) => item.pendingRestart).length);

const filteredParameters = computed(() =>
  filterGucParameters(parameters.value, {
    search: search.value,
    preset: activePreset.value,
    category: selectedCategory.value,
    contextLevel: selectedContext.value,
    modifiedOnly: modifiedOnly.value,
  }),
);

function formatCountBadge(key: string, count: number): string {
  const formatted = t(key, { count });
  return formatted.includes(String(count)) ? formatted : `${formatted} ${count}`;
}

function contextBadgeClass(level: GucContextLevel): string {
  switch (level) {
    case "session":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "reload":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400";
    case "restart":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function contextLabelKey(level: GucContextLevel): string {
  switch (level) {
    case "session":
      return "gucParams.ctxSession";
    case "reload":
      return "gucParams.ctxReload";
    case "restart":
      return "gucParams.ctxRestart";
    default:
      return "gucParams.ctxReadonly";
  }
}

function contextNoteClass(level: GucContextLevel): string {
  switch (level) {
    case "session":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "reload":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400";
    case "restart":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    default:
      return "border-border bg-muted/60 text-muted-foreground";
  }
}

function contextNoteKey(level: GucContextLevel): string {
  switch (level) {
    case "session":
      return "gucParams.contextNoteSession";
    case "reload":
      return "gucParams.contextNoteReload";
    case "restart":
      return "gucParams.contextNoteRestart";
    default:
      return "gucParams.contextNoteReadonly";
  }
}

function formatValueWithUnit(value: string | null, unit: string): string {
  if (value === null) return "-";
  if (value === "") return '""';
  return unit ? `${value} ${unit}` : value;
}

const selectedLevel = computed<GucContextLevel>(() => (selectedParam.value ? gucContextLevel(selectedParam.value.context) : "readonly"));

const isBoolSelect = computed(() => {
  const param = selectedParam.value;
  return !!param && param.vartype.trim().toLowerCase() === "bool" && param.enumVals.length === 0;
});

const isEnumSelect = computed(() => (selectedParam.value?.enumVals.length ?? 0) > 0);

const dialogTitleInfo = computed(() => {
  const param = selectedParam.value;
  if (!param) return { text: t("gucParams.dialogTitle"), showInlineName: false };
  const formatted = t("gucParams.dialogTitle", { name: param.name });
  return {
    text: formatted,
    showInlineName: !formatted.includes(param.name),
  };
});

const rangeText = computed(() => {
  const param = selectedParam.value;
  if (!param || (param.minVal === null && param.maxVal === null)) return "";
  const min = param.minVal ?? "-∞";
  const max = param.maxVal ?? "+∞";
  const formatted = t("gucParams.rangeHint", { min, max });
  if (formatted.includes(min) || formatted.includes(max)) return formatted;
  return `${formatted}: ${min} .. ${max}`;
});

const sessionSql = computed(() => {
  const param = selectedParam.value;
  if (!param || selectedLevel.value !== "session") return "";
  return buildGucSessionSetSql(param.name, draftValue.value, param.vartype);
});

const alterSystemSql = computed(() => {
  const param = selectedParam.value;
  if (!param || selectedLevel.value === "readonly") return "";
  const includeReload = selectedLevel.value === "session" || selectedLevel.value === "reload";
  return buildGucAlterSystemSql(param.name, draftValue.value, param.vartype, includeReload);
});

const gsGucCommand = computed(() => {
  const param = selectedParam.value;
  if (!param || (selectedLevel.value !== "reload" && selectedLevel.value !== "restart")) return "";
  return buildGsGucCliCommand(param.name, draftValue.value, selectedLevel.value === "reload");
});

function openParameterDialog(param: OpenGaussGucParameter) {
  selectedParam.value = param;
  if (param.vartype.trim().toLowerCase() === "bool" && param.enumVals.length === 0) {
    draftValue.value = normalizeGucBoolValue(param.setting) ?? param.setting;
  } else {
    draftValue.value = param.setting;
  }
  dialogOpen.value = true;
}

function resetDraftToDefault() {
  const param = selectedParam.value;
  if (!param || param.bootVal === null) return;
  if (param.vartype.trim().toLowerCase() === "bool" && param.enumVals.length === 0) {
    draftValue.value = normalizeGucBoolValue(param.bootVal) ?? param.bootVal;
  } else {
    draftValue.value = param.bootVal;
  }
}

async function copyCommand(text: string) {
  if (!text) return;
  try {
    await copyToClipboard(text);
    toast(t("gucParams.commandCopied"), 2000);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 3000);
  }
}

function openInQueryTab(sql: string) {
  if (!sql || !props.connectionId) return;
  const tabId = queryStore.createTab(props.connectionId, props.database, t("gucParams.scriptTabTitle"), "query", props.schema, sql);
  queryStore.updateSql(tabId, sql);
  dialogOpen.value = false;
}

function sqlForTier(tier: GucQueryTier): string {
  if (tier === "full") return buildGucParametersQuery(true);
  if (tier === "no_pending_restart") return buildGucParametersQuery(false);
  return buildGucParametersFallbackQuery();
}

async function executeTierQuery(tier: GucQueryTier): Promise<QueryResult> {
  const result = await api.executeQuery(props.connectionId, props.database, sqlForTier(tier), props.schema || undefined, undefined, { maxRows: 5000 });
  if (result.execution_error) {
    throw result.error ? new BackendErrorException(result.error) : new BackendErrorException(String(result.rows?.[0]?.[0] ?? "Query failed"));
  }
  return result;
}

async function runQueryWithFallback(): Promise<QueryResult> {
  try {
    return await executeTierQuery(queryTier);
  } catch (error) {
    const message = formatError(error);
    if (!isMissingGucColumnError(message)) throw error;
    if (queryTier === "full") {
      try {
        const res = await executeTierQuery("no_pending_restart");
        queryTier = "no_pending_restart";
        return res;
      } catch (nextError) {
        const nextMessage = formatError(nextError);
        if (!isMissingGucColumnError(nextMessage)) throw nextError;
        const res = await executeTierQuery("fallback");
        queryTier = "fallback";
        return res;
      }
    }
    if (queryTier === "no_pending_restart") {
      const res = await executeTierQuery("fallback");
      queryTier = "fallback";
      return res;
    }
    throw error;
  }
}

async function load() {
  if (!supported.value) return;
  const request = ++generation;
  loading.value = true;
  loadError.value = "";
  try {
    await connectionStore.ensureConnected(props.connectionId);
    if (disposed || request !== generation) return;
    const result = await runQueryWithFallback();
    if (disposed || request !== generation) return;
    parameters.value = parseGucParametersRows(result);
    if (selectedCategory.value !== "all" && !categories.value.includes(selectedCategory.value)) {
      selectedCategory.value = "all";
    }
  } catch (error) {
    if (disposed || request !== generation) return;
    parameters.value = [];
    loadError.value = formatError(error);
  } finally {
    if (!disposed && request === generation) loading.value = false;
  }
}

watch(
  () => [props.connectionId, props.database, props.schema, supported.value],
  () => {
    generation++;
    queryTier = "full";
    parameters.value = [];
    loadError.value = "";
    dialogOpen.value = false;
    selectedParam.value = null;
    if (supported.value) {
      void load();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  disposed = true;
  generation++;
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="guc-parameters-panel">
    <!-- Header toolbar -->
    <header class="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs shrink-0 select-none">
      <div class="flex items-center gap-2">
        <SlidersHorizontal class="h-4 w-4 text-primary" />
        <span class="font-semibold text-sm">{{ t("gucParams.title") }}</span>
        <ToolConnectionSelect :model-value="props.connectionId" kind="pg-stats" @update:model-value="onToolConnectionChange" />
        <Badge v-if="props.database" variant="outline" class="h-5 px-2 font-mono text-[11px]" data-testid="guc-database-badge">{{ props.database }}</Badge>
      </div>

      <div v-if="supported" class="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary" class="h-5 px-2 text-[11px]" data-testid="guc-kpi-total">
          {{ formatCountBadge("gucParams.totalCount", parameters.length) }}
        </Badge>
        <Badge variant="outline" class="h-5 px-2 text-[11px]" :class="modifiedCount > 0 ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400' : ''" data-testid="guc-kpi-modified">
          {{ formatCountBadge("gucParams.modifiedCount", modifiedCount) }}
        </Badge>
        <Badge v-if="pendingRestartCount > 0" variant="outline" class="h-5 gap-1 border-amber-500/50 bg-amber-500/15 px-2 text-[11px] text-amber-700 dark:text-amber-400" data-testid="guc-kpi-pending-restart">
          <AlertTriangle class="h-3 w-3" />
          {{ formatCountBadge("gucParams.pendingRestartCount", pendingRestartCount) }}
        </Badge>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" :disabled="loading || !supported" data-testid="guc-refresh-btn" @click="load()">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          <span>{{ t("gucParams.refresh") }}</span>
        </Button>
      </div>
    </header>

    <!-- No connections -->
    <div v-if="!props.connectionId && !hasEligibleConnections" class="flex flex-1 items-center justify-center p-6">
      <div class="max-w-md text-center space-y-2">
        <Database class="mx-auto h-8 w-8 text-muted-foreground" />
        <p class="text-sm font-medium">{{ t("gucParams.noConnections") }}</p>
      </div>
    </div>

    <!-- Unsupported connection type -->
    <div v-else-if="!supported" class="flex flex-1 items-center justify-center p-6">
      <div class="max-w-md text-center space-y-2">
        <AlertTriangle class="mx-auto h-8 w-8 text-amber-500" />
        <p class="text-sm font-medium">{{ t("gucParams.unsupportedTitle") }}</p>
        <p class="text-xs text-muted-foreground">{{ t("gucParams.unsupportedHint") }}</p>
      </div>
    </div>

    <template v-else>
      <!-- Filter bar -->
      <div class="flex flex-col gap-2 border-b bg-background px-3 py-2 text-xs shrink-0">
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative min-w-[220px] flex-1 max-w-sm">
            <Search class="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-foreground" />
            <input v-model="search" class="h-7 w-full rounded-md border bg-background pl-7 pr-7 text-xs outline-none focus:border-ring placeholder:text-muted-foreground" :placeholder="t('gucParams.searchPlaceholder')" data-testid="guc-search-input" />
            <button v-if="search" type="button" class="absolute right-1.5 top-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground" @click="search = ''">
              <X class="h-3 w-3" />
            </button>
          </div>

          <select v-model="selectedCategory" class="h-7 max-w-[220px] rounded-md border bg-background px-2 text-xs outline-none focus:border-ring" :aria-label="t('gucParams.allCategories')" data-testid="guc-category-select">
            <option value="all">{{ t("gucParams.allCategories") }}</option>
            <option v-for="category in categories" :key="category" :value="category">{{ category }}</option>
          </select>

          <select v-model="selectedContext" class="h-7 rounded-md border bg-background px-2 text-xs outline-none focus:border-ring" :aria-label="t('gucParams.allContexts')" data-testid="guc-context-select">
            <option value="all">{{ t("gucParams.allContexts") }}</option>
            <option value="session">{{ t("gucParams.ctxSession") }}</option>
            <option value="reload">{{ t("gucParams.ctxReload") }}</option>
            <option value="restart">{{ t("gucParams.ctxRestart") }}</option>
            <option value="readonly">{{ t("gucParams.ctxReadonly") }}</option>
          </select>

          <label
            class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs select-none transition-colors"
            :class="modifiedOnly ? 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium' : 'bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground'"
          >
            <input v-model="modifiedOnly" type="checkbox" class="h-3.5 w-3.5 accent-primary" data-testid="guc-modified-only" />
            <span>{{ t("gucParams.modifiedOnly") }}</span>
          </label>
        </div>

        <!-- Preset quick filter pills -->
        <div class="flex flex-wrap items-center gap-1.5 select-none">
          <button
            v-for="preset in presetOptions"
            :key="preset.id"
            type="button"
            class="inline-flex h-6 items-center rounded-full border px-2.5 text-[11px] transition-colors"
            :class="activePreset === preset.id ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground'"
            :data-testid="`guc-preset-${preset.id}`"
            @click="activePreset = preset.id"
          >
            {{ t(preset.labelKey) }}
          </button>
        </div>
      </div>

      <!-- Error state -->
      <div v-if="loadError" class="flex flex-1 items-center justify-center p-6">
        <div class="max-w-lg text-center space-y-3">
          <AlertTriangle class="mx-auto h-8 w-8 text-destructive" />
          <p class="text-sm font-medium">{{ t("gucParams.loadFailed") }}</p>
          <p class="break-all text-xs text-muted-foreground">{{ loadError }}</p>
          <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" @click="load()">
            <RefreshCcw class="h-3.5 w-3.5" />
            <span>{{ t("gucParams.retry") }}</span>
          </Button>
        </div>
      </div>

      <!-- Loading skeleton -->
      <div v-else-if="loading && parameters.length === 0" class="flex-1 min-h-0 p-4 space-y-2" data-testid="guc-loading">
        <div v-for="index in 10" :key="index" class="h-7 animate-pulse rounded bg-muted/60" />
      </div>

      <!-- Parameter table -->
      <div v-else class="flex-1 min-h-0 overflow-auto">
        <table class="w-full border-collapse text-xs">
          <thead class="sticky top-0 z-10 bg-muted/80 backdrop-blur">
            <tr class="text-left text-muted-foreground">
              <th class="min-w-[230px] px-2.5 py-2 font-medium">{{ t("gucParams.colName") }}</th>
              <th class="min-w-[140px] max-w-[240px] px-2.5 py-2 font-medium">{{ t("gucParams.colValue") }}</th>
              <th class="min-w-[120px] max-w-[200px] px-2.5 py-2 font-medium">{{ t("gucParams.colDefault") }}</th>
              <th class="w-28 px-2.5 py-2 font-medium">{{ t("gucParams.colContext") }}</th>
              <th class="w-36 px-2.5 py-2 font-medium">{{ t("gucParams.colSource") }}</th>
              <th class="min-w-[240px] px-2.5 py-2 font-medium">{{ t("gucParams.colDescription") }}</th>
              <th class="w-28 px-2.5 py-2 text-right font-medium">{{ t("gucParams.colActions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="param in filteredParameters" :key="param.name" class="border-b border-border/60 align-middle hover:bg-muted/30">
              <td class="px-2.5 py-1.5">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span v-if="param.modified" class="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500" :title="t('gucParams.modifiedBadge')" />
                  <span class="font-mono text-[11px] font-medium text-foreground">{{ param.name }}</span>
                  <Badge v-if="param.unit" variant="outline" class="h-4 px-1.5 font-mono text-[10px] text-muted-foreground">
                    {{ param.unit }}
                  </Badge>
                  <Badge v-if="param.pendingRestart" variant="outline" class="h-4 gap-1 border-amber-500/50 bg-amber-500/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-400">
                    {{ t("gucParams.pendingRestartBadge") }}
                  </Badge>
                </div>
              </td>

              <td class="max-w-[240px] px-2.5 py-1.5">
                <span class="block truncate font-mono text-[11px]" :class="param.modified ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-foreground/90'" :title="param.setting">
                  {{ formatValueWithUnit(param.setting, param.unit) }}
                </span>
              </td>

              <td class="max-w-[200px] px-2.5 py-1.5">
                <span class="block truncate font-mono text-[11px] text-muted-foreground" :title="param.bootVal ?? ''">
                  {{ formatValueWithUnit(param.bootVal, param.unit) }}
                </span>
              </td>

              <td class="px-2.5 py-1.5">
                <Badge variant="outline" class="h-5 px-2 text-[10px] font-medium" :class="contextBadgeClass(gucContextLevel(param.context))" :title="param.context">
                  {{ t(contextLabelKey(gucContextLevel(param.context))) }}
                </Badge>
              </td>

              <td class="px-2.5 py-1.5">
                <span class="font-mono text-[11px]" :class="param.modified ? 'text-foreground' : 'text-muted-foreground'">
                  {{ param.source || "-" }}
                </span>
              </td>

              <td class="max-w-[420px] px-2.5 py-1.5">
                <span class="block truncate text-[11px] text-muted-foreground" :title="param.shortDesc">
                  {{ param.shortDesc || "-" }}
                </span>
              </td>

              <td class="px-2.5 py-1.5 text-right">
                <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground" :data-testid="`guc-action-${param.name}`" @click="openParameterDialog(param)">
                  <Eye v-if="gucContextLevel(param.context) === 'readonly'" class="h-3 w-3" />
                  <Pencil v-else class="h-3 w-3" />
                  <span>{{ gucContextLevel(param.context) === "readonly" ? t("gucParams.viewAction") : t("gucParams.editAction") }}</span>
                </Button>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="filteredParameters.length === 0" class="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <Table2 class="h-8 w-8 text-muted-foreground" />
          <p class="text-sm font-medium">{{ t("gucParams.empty") }}</p>
        </div>
      </div>
    </template>

    <!-- Modification Helper Dialog -->
    <Dialog v-model:open="dialogOpen">
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle class="flex flex-wrap items-center gap-2 pr-6">
            <span>{{ dialogTitleInfo.text }}</span>
            <code v-if="dialogTitleInfo.showInlineName && selectedParam" class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold">
              {{ selectedParam.name }}
            </code>
          </DialogTitle>
        </DialogHeader>

        <div v-if="selectedParam" class="grid max-h-[75vh] gap-4 overflow-auto pr-1 text-xs">
          <!-- Metadata & description -->
          <div class="space-y-2 rounded-md border bg-muted/20 p-3">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="font-mono text-xs font-semibold text-foreground">{{ selectedParam.name }}</span>
              <Badge variant="outline" class="h-5 px-2 text-[10px]">{{ selectedParam.vartype || "-" }}</Badge>
              <Badge v-if="selectedParam.category" variant="secondary" class="h-5 px-2 text-[10px]">{{ selectedParam.category }}</Badge>
              <Badge variant="outline" class="h-5 px-2 text-[10px]" :class="contextBadgeClass(selectedLevel)"> {{ t(contextLabelKey(selectedLevel)) }} ({{ selectedParam.context }}) </Badge>
              <Badge v-if="selectedParam.pendingRestart" variant="outline" class="h-5 gap-1 border-amber-500/50 bg-amber-500/15 px-2 text-[10px] text-amber-700 dark:text-amber-400">
                <AlertTriangle class="h-3 w-3" />
                {{ t("gucParams.pendingRestartBadge") }}
              </Badge>
            </div>

            <p v-if="selectedParam.shortDesc" class="text-xs leading-relaxed text-muted-foreground">
              {{ selectedParam.shortDesc }}
            </p>

            <div class="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
              <div class="rounded border bg-background px-2.5 py-1.5">
                <div class="text-[11px] text-muted-foreground">{{ t("gucParams.currentValue") }}</div>
                <div class="mt-0.5 font-mono text-xs font-medium break-all">
                  {{ formatValueWithUnit(selectedParam.setting, selectedParam.unit) }}
                </div>
              </div>
              <div class="rounded border bg-background px-2.5 py-1.5">
                <div class="text-[11px] text-muted-foreground">{{ t("gucParams.defaultValue") }}</div>
                <div class="mt-0.5 font-mono text-xs text-muted-foreground break-all">
                  {{ formatValueWithUnit(selectedParam.bootVal, selectedParam.unit) }}
                </div>
              </div>
            </div>

            <div v-if="rangeText" class="text-[11px] text-muted-foreground font-mono">
              {{ rangeText }}
            </div>
          </div>

          <!-- Context warning / scope banner -->
          <div class="flex items-start gap-2 rounded-md border px-3 py-2 text-xs" :class="contextNoteClass(selectedLevel)" role="status">
            <AlertTriangle v-if="selectedLevel === 'restart'" class="mt-0.5 h-4 w-4 shrink-0" />
            <Lock v-else-if="selectedLevel === 'readonly'" class="mt-0.5 h-4 w-4 shrink-0" />
            <Info v-else class="mt-0.5 h-4 w-4 shrink-0" />
            <span class="leading-relaxed">{{ t(contextNoteKey(selectedLevel)) }}</span>
          </div>

          <!-- New Value editor & live generated command preview cards -->
          <template v-if="selectedLevel !== 'readonly'">
            <div class="space-y-1.5">
              <div class="flex items-center justify-between gap-2">
                <label class="text-xs font-medium" for="guc-new-value-input">{{ t("gucParams.newValueLabel") }}</label>
                <Button v-if="selectedParam.bootVal !== null" variant="ghost" size="sm" class="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground" data-testid="guc-reset-default-btn" @click="resetDraftToDefault">
                  <RotateCcw class="h-3 w-3" />
                  <span>{{ t("gucParams.resetToDefault") }}</span>
                </Button>
              </div>

              <div class="flex items-center gap-2">
                <select v-if="isBoolSelect" id="guc-new-value-input" v-model="draftValue" class="h-8 w-full rounded-md border bg-background px-2.5 font-mono text-xs outline-none focus:border-ring" data-testid="guc-new-value-select">
                  <option value="on">on</option>
                  <option value="off">off</option>
                  <option v-if="draftValue !== 'on' && draftValue !== 'off'" :value="draftValue">{{ draftValue }}</option>
                </select>

                <select v-else-if="isEnumSelect" id="guc-new-value-input" v-model="draftValue" class="h-8 w-full rounded-md border bg-background px-2.5 font-mono text-xs outline-none focus:border-ring" data-testid="guc-new-value-select">
                  <option v-for="optionValue in selectedParam.enumVals" :key="optionValue" :value="optionValue">
                    {{ optionValue }}
                  </option>
                  <option v-if="!selectedParam.enumVals.includes(draftValue)" :value="draftValue">
                    {{ draftValue }}
                  </option>
                </select>

                <Input v-else id="guc-new-value-input" v-model="draftValue" class="h-8 font-mono text-xs" data-testid="guc-new-value-input" />

                <Badge v-if="selectedParam.unit" variant="outline" class="h-8 shrink-0 px-2.5 font-mono text-xs text-muted-foreground">
                  {{ selectedParam.unit }}
                </Badge>
              </div>
            </div>

            <!-- Generated command preview cards -->
            <div class="grid gap-3">
              <!-- Session SET -->
              <div v-if="sessionSql" class="rounded-md border bg-muted/20 p-3 space-y-2" data-testid="guc-preview-session">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs font-medium">{{ t("gucParams.sessionSqlTitle") }}</span>
                  <div class="flex items-center gap-1">
                    <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px]" @click="copyCommand(sessionSql)">
                      <Copy class="h-3 w-3" />
                      <span>{{ t("gucParams.copyCommand") }}</span>
                    </Button>
                    <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px]" @click="openInQueryTab(sessionSql)">
                      <ExternalLink class="h-3 w-3" />
                      <span>{{ t("gucParams.openInQueryTab") }}</span>
                    </Button>
                  </div>
                </div>
                <pre class="overflow-x-auto rounded border bg-background p-2.5 font-mono text-[11px] leading-relaxed">{{ sessionSql }}</pre>
              </div>

              <!-- ALTER SYSTEM SET -->
              <div v-if="alterSystemSql" class="rounded-md border bg-muted/20 p-3 space-y-2" data-testid="guc-preview-alter-system">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs font-medium">{{ t("gucParams.alterSystemSqlTitle") }}</span>
                  <div class="flex items-center gap-1">
                    <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px]" @click="copyCommand(alterSystemSql)">
                      <Copy class="h-3 w-3" />
                      <span>{{ t("gucParams.copyCommand") }}</span>
                    </Button>
                    <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px]" @click="openInQueryTab(alterSystemSql)">
                      <ExternalLink class="h-3 w-3" />
                      <span>{{ t("gucParams.openInQueryTab") }}</span>
                    </Button>
                  </div>
                </div>
                <pre class="overflow-x-auto rounded border bg-background p-2.5 font-mono text-[11px] leading-relaxed">{{ alterSystemSql }}</pre>
              </div>

              <!-- gs_guc CLI -->
              <div v-if="gsGucCommand" class="rounded-md border bg-muted/20 p-3 space-y-2" data-testid="guc-preview-gs-guc">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs font-medium">{{ t("gucParams.gsGucCliTitle") }}</span>
                  <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px]" @click="copyCommand(gsGucCommand)">
                    <Copy class="h-3 w-3" />
                    <span>{{ t("gucParams.copyCommand") }}</span>
                  </Button>
                </div>
                <pre class="overflow-x-auto rounded border bg-background p-2.5 font-mono text-[11px] leading-relaxed">{{ gsGucCommand }}</pre>
              </div>
            </div>
          </template>
        </div>
      </DialogContent>
    </Dialog>
  </section>
</template>
