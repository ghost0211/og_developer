<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, AlertTriangle, Check, CheckCircle2, Copy, History, Loader2, Pencil, RefreshCw, RotateCcw, Search, Trash2, X } from "@lucide/vue";

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { databaseOptionsForConnection } from "@/composables/useDatabaseOptions";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatError } from "@/lib/backend/errorUtils";
import * as api from "@/lib/backend/api";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import {
  buildPurgeAllRecycleBinSql,
  buildPurgeRecycleBinItemSql,
  buildTimecapsuleRestoreSql,
  formatQualifiedOpengaussName,
  isRecycleBinCatalogUnavailableError,
  isRecycleBinFallbackCandidateError,
  isRelationAlreadyExistsError,
  OPENGAUSS_ENABLE_RECYCLEBIN_GUC_COMMAND,
  OPENGAUSS_ENABLE_RECYCLEBIN_SQL,
  OPENGAUSS_NAMESPACE_MAP_SQL,
  OPENGAUSS_RECYCLEBIN_FALLBACK_SQL,
  OPENGAUSS_RECYCLEBIN_LIST_SQL,
  parseEnableRecycleBinResult,
  parseNamespaceOidMap,
  parseRecycleBinRows,
  type RecycleBinItem,
} from "@/lib/database/opengaussRecycleBin";
import type { QueryResult } from "@/types/database";

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
}>();

const emit = defineEmits<{
  restored: [
    payload: {
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
    },
  ];
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

const selectedConnectionId = ref(props.prefillConnectionId || "");
const selectedDatabase = ref(props.prefillDatabase || "");
const selectedSchema = ref(props.prefillSchema || "");
const operationFilter = ref<"ALL" | "DROP" | "TRUNCATE">("ALL");
const tablesOnly = ref(true);
const searchQuery = ref("");

const loading = ref(false);
const mutating = ref(false);
const loadError = ref("");
const catalogUnavailable = ref(false);
const recycleBinEnabled = ref<boolean | null>(null);
const copiedToken = ref("");

const databases = ref<string[]>([]);
const serverSchemas = ref<string[]>([]);
const items = ref<RecycleBinItem[]>([]);

type RowActionMode = "rename" | "confirm-truncate" | "confirm-purge";

interface ActiveRowAction {
  key: string;
  mode: RowActionMode;
}

const activeRowAction = ref<ActiveRowAction | null>(null);
const renameTargetInput = ref("");
const renameInputEl = ref<HTMLInputElement | null>(null);
const confirmingPurgeAll = ref(false);

let loadRunId = 0;
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const connections = computed(() => connectionStore.connections.filter((connection) => effectiveDatabaseTypeForConnection(connection) === "opengauss"));

const currentConnection = computed(() => connectionStore.getConfig(selectedConnectionId.value));

const schemaOptions = computed(() => {
  const set = new Set<string>();
  for (const s of serverSchemas.value) {
    if (s) set.add(s);
  }
  for (const item of items.value) {
    if (item.schema) set.add(item.schema);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
});

const hiddenNonTableCount = computed(() => items.value.filter((item) => item.rcytype !== 0).length);

const restorableCount = computed(() => items.value.filter((item) => item.canRestore).length);

const filteredItems = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  return items.value.filter((item) => {
    if (tablesOnly.value && item.rcytype !== 0) return false;
    if (selectedSchema.value && item.schema !== selectedSchema.value) return false;
    if (operationFilter.value !== "ALL" && item.operation !== operationFilter.value) return false;
    if (!q) return true;
    return item.originName.toLowerCase().includes(q) || item.rcyname.toLowerCase().includes(q) || item.schema.toLowerCase().includes(q) || (item.owner ?? "").toLowerCase().includes(q) || item.typeLabel.toLowerCase().includes(q);
  });
});

const hasActiveFilter = computed(() => Boolean(selectedSchema.value) || operationFilter.value !== "ALL" || Boolean(searchQuery.value.trim()) || (tablesOnly.value && hiddenNonTableCount.value > 0));

function itemKey(item: RecycleBinItem): string {
  return `${item.schema}:${item.rcyname || item.originName}:${item.operation}:${item.recycleTime}:${item.rcytype}`;
}

function truncateMiddle(value: string, maxLen = 26): string {
  if (!value || value.length <= maxLen) return value;
  const head = Math.ceil((maxLen - 3) * 0.55);
  const tail = Math.max(4, maxLen - 3 - head);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function formatRecycleTime(raw: string): string {
  if (!raw) return "-";
  return raw.replace(/(\d{2}:\d{2}:\d{2})\.\d+/, "$1");
}

function qualifiedLiveName(item: RecycleBinItem): string {
  return formatQualifiedOpengaussName(item.schema, item.originName || item.rcyname);
}

function previewRenameSql(item: RecycleBinItem): string {
  const candidate = renameTargetInput.value.trim();
  try {
    return buildTimecapsuleRestoreSql(item, { renameTo: candidate || `${item.originName}_restored` });
  } catch {
    return "";
  }
}

function previewTruncateSql(item: RecycleBinItem): string {
  try {
    return buildTimecapsuleRestoreSql(item);
  } catch {
    return "";
  }
}

function previewPurgeItemSql(item: RecycleBinItem): string {
  try {
    return buildPurgeRecycleBinItemSql(item);
  } catch {
    return "";
  }
}

function resetFilters() {
  selectedSchema.value = "";
  operationFilter.value = "ALL";
  searchQuery.value = "";
  if (items.value.length > 0 && items.value.every((item) => item.rcytype !== 0)) {
    tablesOnly.value = false;
  }
}

function markCopied(token: string) {
  copiedToken.value = token;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    if (copiedToken.value === token) copiedToken.value = "";
  }, 1600);
}

async function handleCopyText(text: string, token: string, successToast: string) {
  if (!text) return;
  try {
    await copyToClipboard(text);
    markCopied(token);
    toast(successToast, 1800);
  } catch (error: unknown) {
    toast(t("recycleBin.copyFailed", { message: formatError(error) }, "复制失败：{message}"), 3000);
  }
}

async function copyItemTimecapsuleSql(item: RecycleBinItem) {
  if (!item.canRestore) return;
  const key = itemKey(item);
  const renameOverride = activeRowAction.value?.key === key && activeRowAction.value.mode === "rename" ? renameTargetInput.value.trim() : "";
  try {
    const sql = buildTimecapsuleRestoreSql(item, { renameTo: renameOverride || undefined });
    await handleCopyText(sql, `sql:${key}`, t("recycleBin.sqlCopied", "已复制 TIMECAPSULE SQL"));
  } catch (error: unknown) {
    toast(formatError(error), 3000);
  }
}

async function runCheckedQuery(connectionId: string, database: string, sql: string): Promise<QueryResult> {
  const res = await api.executeQuery(connectionId, database, sql);
  if (res.execution_error) {
    throw res.error ?? new Error("SQL execution failed");
  }
  return res;
}

async function loadScopeOptions() {
  const connectionId = selectedConnectionId.value;
  const config = connectionStore.getConfig(connectionId);
  if (!connectionId || !config) {
    databases.value = [];
    serverSchemas.value = [];
    return;
  }

  try {
    await connectionStore.ensureConnected(connectionId);
    const databaseRows = await api.listDatabases(connectionId);
    databases.value = databaseOptionsForConnection(
      databaseRows.map((db) => db.name),
      config,
    );
  } catch (error: unknown) {
    console.warn("[RecycleBin] failed to load database options", error);
    databases.value = config.database ? [config.database] : ["postgres"];
  }

  if (!selectedDatabase.value || !databases.value.includes(selectedDatabase.value)) {
    selectedDatabase.value = databases.value[0] || config.database || "postgres";
  }

  try {
    serverSchemas.value = selectedDatabase.value ? await api.listSchemas(connectionId, selectedDatabase.value) : [];
  } catch (error: unknown) {
    console.warn("[RecycleBin] failed to load schema options", error);
    serverSchemas.value = [];
  }
}

async function refreshRecycleBin() {
  const connectionId = selectedConnectionId.value;
  const database = selectedDatabase.value;
  if (!connectionId || !database) return;

  const runId = ++loadRunId;
  loading.value = true;
  loadError.value = "";
  catalogUnavailable.value = false;
  activeRowAction.value = null;
  confirmingPurgeAll.value = false;

  try {
    await connectionStore.ensureConnected(connectionId);
    if (runId !== loadRunId) return;

    // 1. Check GUC `SHOW enable_recyclebin` (non-fatal if restricted)
    try {
      const gucRes = await api.executeQuery(connectionId, database, OPENGAUSS_ENABLE_RECYCLEBIN_SQL);
      if (runId !== loadRunId) return;
      recycleBinEnabled.value = parseEnableRecycleBinResult(gucRes);
    } catch {
      if (runId !== loadRunId) return;
      recycleBinEnabled.value = null;
    }

    // 2. Query pg_catalog.gs_recyclebin with automatic fallback
    try {
      const listRes = await runCheckedQuery(connectionId, database, OPENGAUSS_RECYCLEBIN_LIST_SQL);
      if (runId !== loadRunId) return;
      items.value = parseRecycleBinRows(listRes);
    } catch (primaryError: unknown) {
      if (runId !== loadRunId) return;
      if (isRecycleBinCatalogUnavailableError(primaryError)) {
        catalogUnavailable.value = true;
        items.value = [];
        return;
      }
      if (!isRecycleBinFallbackCandidateError(primaryError)) {
        throw primaryError;
      }

      // Fallback query when an openGauss build lacks one of the joined columns/functions
      const fallbackRes = await runCheckedQuery(connectionId, database, OPENGAUSS_RECYCLEBIN_FALLBACK_SQL);
      if (runId !== loadRunId) return;

      let namespaceMap: Map<string, string> | undefined;
      try {
        const nsRes = await api.executeQuery(connectionId, database, OPENGAUSS_NAMESPACE_MAP_SQL);
        namespaceMap = parseNamespaceOidMap(nsRes);
      } catch {
        namespaceMap = undefined;
      }
      if (runId !== loadRunId) return;
      items.value = parseRecycleBinRows(fallbackRes, { namespaceMap });
    }
  } catch (error: unknown) {
    if (runId !== loadRunId) return;
    const msg = formatError(error);
    loadError.value = msg;
    items.value = [];
    toast(t("recycleBin.loadFailed", { message: msg }, "读取回收站失败：{message}"), 3500);
  } finally {
    if (runId === loadRunId) {
      loading.value = false;
    }
  }
}

async function onConnectionChanged() {
  selectedDatabase.value = "";
  selectedSchema.value = "";
  recycleBinEnabled.value = null;
  items.value = [];
  await loadScopeOptions();
  await refreshRecycleBin();
}

async function onDatabaseChanged() {
  selectedSchema.value = "";
  recycleBinEnabled.value = null;
  items.value = [];
  await loadScopeOptions();
  await refreshRecycleBin();
}

function openRowAction(item: RecycleBinItem, mode: RowActionMode, initialRename?: string) {
  const key = itemKey(item);
  if (activeRowAction.value?.key === key && activeRowAction.value.mode === mode && !initialRename) {
    activeRowAction.value = null;
    return;
  }
  confirmingPurgeAll.value = false;
  activeRowAction.value = { key, mode };
  if (mode === "rename") {
    renameTargetInput.value = initialRename ?? `${item.originName}_restored`;
    void nextTick(() => {
      renameInputEl.value?.focus();
      renameInputEl.value?.select();
    });
  }
}

function closeRowAction() {
  activeRowAction.value = null;
}

async function executeGuardedRecycleSql(sql: string): Promise<boolean> {
  if (!selectedConnectionId.value || !selectedDatabase.value) return false;
  const result = await executeWithProductionSqlGuard({
    connection: currentConnection.value,
    database: selectedDatabase.value,
    sql,
    source: t("recycleBin.productionSource", "openGauss 回收站与闪回恢复"),
    execute: async () => runCheckedQuery(selectedConnectionId.value, selectedDatabase.value, sql),
  });
  return result !== undefined;
}

async function restoreDropDirect(item: RecycleBinItem) {
  if (!item.canRestore || mutating.value) return;
  let sql: string;
  try {
    sql = buildTimecapsuleRestoreSql(item);
  } catch (error: unknown) {
    toast(formatError(error), 3000);
    return;
  }

  mutating.value = true;
  try {
    const executed = await executeGuardedRecycleSql(sql);
    if (!executed) return;

    toast(t("recycleBin.restoreSuccess", { name: item.originName }, "已成功闪回恢复表 {name}"), 2500);
    emit("restored", {
      connectionId: selectedConnectionId.value,
      database: selectedDatabase.value,
      schema: item.schema || undefined,
      tableName: item.originName,
    });
    await refreshRecycleBin();
  } catch (error: unknown) {
    if (isRelationAlreadyExistsError(error)) {
      toast(t("recycleBin.restoreConflictHint", { name: item.originName }, "同名表 {name} 已存在，请指定新表名执行重命名恢复"), 3800);
      openRowAction(item, "rename", `${item.originName}_restored`);
      return;
    }
    toast(t("recycleBin.restoreFailed", { message: formatError(error) }, "闪回恢复失败：{message}"), 4000);
  } finally {
    mutating.value = false;
  }
}

async function restoreDropRenamed(item: RecycleBinItem) {
  if (!item.canRestore || mutating.value) return;
  const targetName = renameTargetInput.value.trim();
  if (!targetName) {
    toast(t("recycleBin.renameRequired", "请输入恢复后的新表名"), 2500);
    return;
  }

  let sql: string;
  try {
    sql = buildTimecapsuleRestoreSql(item, { renameTo: targetName });
  } catch (error: unknown) {
    toast(formatError(error), 3000);
    return;
  }

  mutating.value = true;
  try {
    const executed = await executeGuardedRecycleSql(sql);
    if (!executed) return;

    activeRowAction.value = null;
    toast(t("recycleBin.restoreAsSuccess", { origin: item.originName, target: targetName }, "已将 {origin} 闪回恢复为新表 {target}"), 2800);
    emit("restored", {
      connectionId: selectedConnectionId.value,
      database: selectedDatabase.value,
      schema: item.schema || undefined,
      tableName: targetName,
    });
    await refreshRecycleBin();
  } catch (error: unknown) {
    toast(t("recycleBin.restoreFailed", { message: formatError(error) }, "闪回恢复失败：{message}"), 4000);
  } finally {
    mutating.value = false;
  }
}

async function confirmRestoreTruncate(item: RecycleBinItem) {
  if (!item.canRestore || mutating.value) return;
  let sql: string;
  try {
    sql = buildTimecapsuleRestoreSql(item);
  } catch (error: unknown) {
    toast(formatError(error), 3000);
    return;
  }

  mutating.value = true;
  try {
    const executed = await executeGuardedRecycleSql(sql);
    if (!executed) return;

    activeRowAction.value = null;
    toast(t("recycleBin.truncateRestoreSuccess", { name: item.originName }, "已将表 {name} 闪回至 TRUNCATE 前的数据快照"), 2800);
    emit("restored", {
      connectionId: selectedConnectionId.value,
      database: selectedDatabase.value,
      schema: item.schema || undefined,
      tableName: item.originName,
    });
    await refreshRecycleBin();
  } catch (error: unknown) {
    toast(t("recycleBin.restoreFailed", { message: formatError(error) }, "闪回恢复失败：{message}"), 4000);
  } finally {
    mutating.value = false;
  }
}

async function confirmPurgeSingle(item: RecycleBinItem) {
  if (!item.canPurge || mutating.value) return;
  let sql: string;
  try {
    sql = buildPurgeRecycleBinItemSql(item);
  } catch (error: unknown) {
    toast(formatError(error), 3000);
    return;
  }

  mutating.value = true;
  try {
    const executed = await executeGuardedRecycleSql(sql);
    if (!executed) return;

    activeRowAction.value = null;
    toast(t("recycleBin.purgeSuccess", { name: item.originName || item.rcyname }, "已彻底清除回收站对象 {name}"), 2200);
    await refreshRecycleBin();
  } catch (error: unknown) {
    toast(t("recycleBin.purgeFailed", { message: formatError(error) }, "清除对象失败：{message}"), 4000);
  } finally {
    mutating.value = false;
  }
}

function promptPurgeAll() {
  if (items.value.length === 0 || loading.value || mutating.value) return;
  activeRowAction.value = null;
  confirmingPurgeAll.value = true;
}

async function confirmPurgeAll() {
  if (mutating.value) return;
  const sql = buildPurgeAllRecycleBinSql();

  mutating.value = true;
  try {
    const executed = await executeGuardedRecycleSql(sql);
    if (!executed) return;

    confirmingPurgeAll.value = false;
    toast(t("recycleBin.purgeAllSuccess", "已清空当前回收站"), 2500);
    await refreshRecycleBin();
  } catch (error: unknown) {
    toast(t("recycleBin.purgeAllFailed", { message: formatError(error) }, "清空回收站失败：{message}"), 4000);
  } finally {
    mutating.value = false;
  }
}

watch(
  () => open.value,
  (isOpen) => {
    if (!isOpen) {
      loadRunId++;
      activeRowAction.value = null;
      confirmingPurgeAll.value = false;
      return;
    }

    const activeConn = connectionStore.activeConnectionId;
    const validActiveConn = activeConn && connections.value.some((c) => c.id === activeConn) ? activeConn : "";
    const validPrefillConn = props.prefillConnectionId && connections.value.some((c) => c.id === props.prefillConnectionId) ? props.prefillConnectionId : "";
    const validCurrentConn = selectedConnectionId.value && connections.value.some((c) => c.id === selectedConnectionId.value) ? selectedConnectionId.value : "";

    selectedConnectionId.value = validPrefillConn || validCurrentConn || validActiveConn || connections.value[0]?.id || "";
    if (props.prefillDatabase) selectedDatabase.value = props.prefillDatabase;
    selectedSchema.value = props.prefillSchema ?? "";

    void (async () => {
      await loadScopeOptions();
      if (props.prefillDatabase && databases.value.includes(props.prefillDatabase)) {
        selectedDatabase.value = props.prefillDatabase;
      }
      if (props.prefillSchema !== undefined) {
        selectedSchema.value = props.prefillSchema;
      }
      await refreshRecycleBin();
    })();
  },
  { immediate: true },
);
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-[min(96vw,1200px)] h-[660px] flex flex-col p-0 gap-0 overflow-hidden select-text">
      <!-- Header -->
      <DialogHeader class="px-5 py-3 border-b bg-muted/30 shrink-0">
        <div class="flex items-center justify-between pr-10">
          <div class="flex items-center gap-2">
            <History class="h-4 w-4 text-primary" />
            <DialogTitle class="text-sm font-semibold">{{ t("recycleBin.title", "openGauss 回收站与闪回恢复") }}</DialogTitle>
            <Badge variant="outline" class="text-[10px] font-mono text-muted-foreground">gs_recyclebin / TIMECAPSULE</Badge>
          </div>

          <Badge v-if="recycleBinEnabled === true" variant="outline" class="text-[11px] font-mono border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"> enable_recyclebin = on </Badge>
          <Badge v-else-if="recycleBinEnabled === false" variant="outline" class="text-[11px] font-mono border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/10"> enable_recyclebin = off </Badge>
        </div>
      </DialogHeader>

      <!-- Top Filter & Scope Bar -->
      <div class="flex flex-wrap items-center gap-x-2.5 gap-y-2 px-5 py-2.5 border-b bg-muted/10 text-xs shrink-0 select-none">
        <!-- Connection -->
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-muted-foreground shrink-0">{{ t("recycleBin.connection", "连接") }}</span>
          <select v-model="selectedConnectionId" class="h-7 w-36 rounded border bg-background px-2 text-xs outline-none focus:border-ring" :disabled="loading || mutating || connections.length === 0" @change="void onConnectionChanged()">
            <option v-for="c in connections" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>

        <!-- Database -->
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-muted-foreground shrink-0">{{ t("recycleBin.database", "数据库") }}</span>
          <select v-model="selectedDatabase" class="h-7 w-28 rounded border bg-background px-2 text-xs outline-none focus:border-ring" :disabled="loading || mutating || databases.length === 0" @change="void onDatabaseChanged()">
            <option v-for="d in databases" :key="d" :value="d">{{ d }}</option>
          </select>
        </div>

        <!-- Schema Filter -->
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-muted-foreground shrink-0">{{ t("recycleBin.schema", "模式") }}</span>
          <select v-model="selectedSchema" class="h-7 w-28 rounded border bg-background px-2 text-xs outline-none focus:border-ring" :disabled="loading || mutating">
            <option value="">{{ t("recycleBin.allSchemas", "全部模式") }}</option>
            <option v-for="schemaName in schemaOptions" :key="schemaName" :value="schemaName">{{ schemaName }}</option>
          </select>
        </div>

        <!-- Operation Filter -->
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-muted-foreground shrink-0">{{ t("recycleBin.operation", "操作") }}</span>
          <select v-model="operationFilter" class="h-7 w-28 rounded border bg-background px-2 text-xs outline-none focus:border-ring" :disabled="loading || mutating">
            <option value="ALL">{{ t("recycleBin.allOperations", "全部操作") }}</option>
            <option value="DROP">DROP</option>
            <option value="TRUNCATE">TRUNCATE</option>
          </select>
        </div>

        <!-- Tables Only Toggle -->
        <label class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded border bg-background cursor-pointer hover:bg-muted/50 transition-colors shrink-0" :title="t('recycleBin.tablesOnlyHint', '默认隐藏从属索引、TOAST 表与分区对象，取消勾选可查看并清除独立索引')">
          <input v-model="tablesOnly" type="checkbox" class="h-3.5 w-3.5 accent-primary cursor-pointer" />
          <span>{{ t("recycleBin.tablesOnly", "仅显示表") }}</span>
          <span v-if="hiddenNonTableCount > 0" class="text-[10px] text-muted-foreground font-mono"> (+{{ hiddenNonTableCount }}) </span>
        </label>

        <!-- Search & Refresh -->
        <div class="ml-auto flex items-center gap-2 shrink-0">
          <div class="relative w-44">
            <Search class="absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-foreground/60 pointer-events-none" />
            <input v-model="searchQuery" type="text" :placeholder="t('recycleBin.searchPlaceholder', '搜索原对象名 / BIN$ 名称...')" class="h-7 w-full rounded border bg-background pl-7 pr-6 text-xs outline-none focus:border-ring" />
            <button v-if="searchQuery" type="button" class="absolute right-1.5 top-1.5 text-muted-foreground hover:text-foreground" @click="searchQuery = ''">
              <X class="h-3.5 w-3.5" />
            </button>
          </div>

          <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs shrink-0" :disabled="loading || mutating || !selectedConnectionId || !selectedDatabase" @click="void refreshRecycleBin()">
            <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
            <span>{{ t("recycleBin.refresh", "刷新") }}</span>
          </Button>
        </div>
      </div>

      <!-- Status Banner when enable_recyclebin is OFF -->
      <div v-if="recycleBinEnabled === false" class="px-5 py-2.5 border-b bg-amber-500/10 text-xs flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div class="flex items-start gap-2.5 min-w-0 flex-1">
          <AlertTriangle class="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div class="space-y-1 min-w-0">
            <div class="font-medium text-amber-800 dark:text-amber-300">
              {{ t("recycleBin.disabledBannerTitle", "当前实例未启用回收站（enable_recyclebin = off）") }}
            </div>
            <div class="text-[11px] text-amber-700/90 dark:text-amber-300/80 leading-relaxed">
              {{ t("recycleBin.disabledBannerDesc", "未开启时，新执行的 DROP TABLE 与 TRUNCATE TABLE 将直接物理删除，不会进入 gs_recyclebin。请在数据库服务端执行以下命令在线启用：") }}
            </div>
            <div class="flex items-center gap-2 pt-0.5">
              <code class="px-2 py-0.5 rounded bg-background/80 border border-amber-500/30 font-mono text-[11px] text-foreground break-all">
                {{ OPENGAUSS_ENABLE_RECYCLEBIN_GUC_COMMAND }}
              </code>
            </div>
          </div>
        </div>

        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs border-amber-500/40 hover:bg-amber-500/15 shrink-0" @click="void handleCopyText(OPENGAUSS_ENABLE_RECYCLEBIN_GUC_COMMAND, 'guc', t('recycleBin.gucCopied', '已复制 gs_guc 启用命令'))">
          <Check v-if="copiedToken === 'guc'" class="h-3.5 w-3.5 text-emerald-500" />
          <Copy v-else class="h-3.5 w-3.5" />
          <span>{{ t("recycleBin.copyGucCommand", "复制启用命令") }}</span>
        </Button>
      </div>

      <!-- Load Error Banner -->
      <div v-if="loadError" class="px-5 py-2 border-b bg-destructive/10 text-destructive text-xs flex items-center justify-between gap-2 shrink-0">
        <div class="flex items-center gap-2 min-w-0">
          <AlertCircle class="h-3.5 w-3.5 shrink-0" />
          <span class="truncate" :title="loadError">{{ loadError }}</span>
        </div>
        <Button variant="ghost" size="sm" class="h-6 px-2 text-xs shrink-0" @click="void refreshRecycleBin()">
          {{ t("recycleBin.retry", "重试") }}
        </Button>
      </div>

      <!-- Main Table Area -->
      <div class="flex-1 min-h-0 overflow-auto p-0">
        <!-- No openGauss connections -->
        <div v-if="connections.length === 0" class="flex flex-col h-full items-center justify-center p-8 gap-2 text-muted-foreground text-center">
          <AlertCircle class="h-8 w-8 text-amber-500" />
          <span class="font-medium text-foreground text-xs">{{ t("recycleBin.noConnections", "暂无 openGauss 连接") }}</span>
          <span class="text-[11px]">{{ t("recycleBin.noConnectionsHint", "请先创建并连接 openGauss 数据库实例后再打开回收站。") }}</span>
        </div>

        <!-- Loading -->
        <div v-else-if="loading" class="flex h-full items-center justify-center p-8 text-xs text-muted-foreground gap-2">
          <Loader2 class="h-4 w-4 animate-spin text-primary" />
          <span>{{ t("recycleBin.loading", "正在读取 gs_recyclebin 回收站记录...") }}</span>
        </div>

        <!-- Server does not have gs_recyclebin -->
        <div v-else-if="catalogUnavailable" class="flex flex-col h-full items-center justify-center p-8 gap-2 text-muted-foreground text-center">
          <AlertTriangle class="h-8 w-8 text-amber-500" />
          <span class="font-medium text-foreground text-xs">
            {{ t("recycleBin.catalogUnavailable", "当前数据库版本不支持 gs_recyclebin 回收站") }}
          </span>
          <span class="text-[11px] max-w-md">
            {{ t("recycleBin.catalogUnavailableHint", "TIMECAPSULE 回收站特性需要支持 pg_catalog.gs_recyclebin 系统表的 openGauss 版本（建议 2.1.0 及以上，且为 Astore 存储引擎表）。") }}
          </span>
        </div>

        <!-- Empty recycle bin -->
        <div v-else-if="items.length === 0" class="flex flex-col h-full items-center justify-center p-8 gap-2 text-muted-foreground text-center">
          <CheckCircle2 class="h-8 w-8 text-emerald-500" />
          <span class="font-medium text-foreground text-xs">{{ t("recycleBin.empty", "当前数据库回收站为空") }}</span>
          <span class="text-[11px] max-w-md">
            {{ t("recycleBin.emptyHint", "当 enable_recyclebin 开启后，被 DROP 或 TRUNCATE 的表会自动保留在此处，支持一键 TIMECAPSULE 闪回恢复。") }}
          </span>
        </div>

        <!-- Filtered out all items -->
        <div v-else-if="filteredItems.length === 0" class="flex flex-col h-full items-center justify-center p-8 gap-2.5 text-muted-foreground text-center">
          <Search class="h-7 w-7 text-muted-foreground/60" />
          <span class="font-medium text-foreground text-xs">
            {{ t("recycleBin.noFilteredMatches", "当前筛选条件下没有匹配的回收站记录") }}
          </span>
          <span v-if="tablesOnly && hiddenNonTableCount > 0" class="text-[11px]">
            {{ t("recycleBin.hiddenChildrenNote", { count: hiddenNonTableCount }, "共有 {count} 个索引/TOAST/分区从属对象被“仅显示表”隐藏") }}
          </span>
          <Button v-if="hasActiveFilter" variant="outline" size="sm" class="h-7 text-xs mt-1" @click="resetFilters">
            {{ t("recycleBin.resetFilters", "重置筛选条件") }}
          </Button>
        </div>

        <!-- Tabular Items -->
        <div v-else class="w-full">
          <table class="w-full text-left text-xs border-collapse font-sans">
            <thead class="sticky top-0 bg-muted/90 backdrop-blur z-10 border-b text-muted-foreground font-medium select-none">
              <tr>
                <th class="py-2 px-3 min-w-[170px]">{{ t("recycleBin.colOriginName", "原对象名称") }}</th>
                <th class="py-2 px-2.5 w-[105px]">{{ t("recycleBin.colSchema", "模式") }}</th>
                <th class="py-2 px-2.5 w-[92px]">{{ t("recycleBin.colOperation", "回收操作") }}</th>
                <th class="py-2 px-2.5 w-[152px]">{{ t("recycleBin.colRecycleTime", "回收时间") }}</th>
                <th class="py-2 px-2.5 w-[210px]">{{ t("recycleBin.colRcyName", "系统回收名 (rcyname)") }}</th>
                <th class="py-2 px-2.5 w-[90px]">{{ t("recycleBin.colOwner", "属主") }}</th>
                <th class="py-2 px-2.5 w-[96px]">{{ t("recycleBin.colStatus", "状态") }}</th>
                <th class="py-2 px-3 w-[250px] text-right">{{ t("recycleBin.colActions", "操作") }}</th>
              </tr>
            </thead>
            <tbody class="divide-y">
              <template v-for="item in filteredItems" :key="itemKey(item)">
                <tr class="hover:bg-muted/40 transition-colors" :class="{ 'bg-primary/5': activeRowAction?.key === itemKey(item) }">
                  <!-- Original Name + Type -->
                  <td class="py-2 px-3">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <span class="font-mono font-semibold text-foreground truncate" :title="item.originName || item.rcyname">
                        {{ item.originName || "-" }}
                      </span>
                      <Badge v-if="item.rcytype !== 0 || !tablesOnly" variant="secondary" class="text-[10px] font-mono px-1.5 py-0 h-4 shrink-0">
                        {{ item.typeLabel }}
                      </Badge>
                    </div>
                  </td>

                  <!-- Schema -->
                  <td class="py-2 px-2.5 font-mono text-[11px] text-muted-foreground truncate" :title="item.schema">
                    {{ item.schema || "-" }}
                  </td>

                  <!-- Operation Badge -->
                  <td class="py-2 px-2.5">
                    <Badge v-if="item.operation === 'DROP'" variant="outline" class="text-[10px] font-mono border-destructive/40 text-destructive bg-destructive/10"> DROP </Badge>
                    <Badge v-else-if="item.operation === 'TRUNCATE'" variant="outline" class="text-[10px] font-mono border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/10"> TRUNCATE </Badge>
                    <Badge v-else variant="secondary" class="text-[10px] font-mono">
                      {{ item.rawOperation || "UNKNOWN" }}
                    </Badge>
                  </td>

                  <!-- Recycled Time -->
                  <td class="py-2 px-2.5 font-mono text-[11px] text-muted-foreground whitespace-nowrap" :title="item.recycleCsn ? `${item.recycleTime} (CSN: ${item.recycleCsn})` : item.recycleTime">
                    {{ formatRecycleTime(item.recycleTime) }}
                  </td>

                  <!-- System Recycle Name (rcyname) -->
                  <td class="py-2 px-2.5">
                    <div v-if="item.rcyname" class="flex items-center gap-1 min-w-0">
                      <span class="font-mono text-[11px] text-muted-foreground truncate" :title="item.rcyname">
                        {{ truncateMiddle(item.rcyname, 24) }}
                      </span>
                      <button
                        type="button"
                        class="p-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-muted shrink-0"
                        :title="t('recycleBin.copyRcyName', '复制系统回收名')"
                        @click="void handleCopyText(item.rcyname, `rcy:${itemKey(item)}`, t('recycleBin.rcyNameCopied', '已复制系统回收名'))"
                      >
                        <Check v-if="copiedToken === `rcy:${itemKey(item)}`" class="h-3 w-3 text-emerald-500" />
                        <Copy v-else class="h-3 w-3" />
                      </button>
                    </div>
                    <span v-else class="text-muted-foreground">-</span>
                  </td>

                  <!-- Owner -->
                  <td class="py-2 px-2.5 font-mono text-[11px] text-muted-foreground truncate" :title="item.owner ?? ''">
                    {{ item.owner || "-" }}
                  </td>

                  <!-- Restorable Status -->
                  <td class="py-2 px-2.5">
                    <Badge v-if="item.canRestore" variant="outline" class="text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10">
                      {{ t("recycleBin.statusRestorable", "可闪回") }}
                    </Badge>
                    <Badge v-else-if="item.canPurge" variant="outline" class="text-[10px] text-muted-foreground">
                      {{ t("recycleBin.statusPurgeOnly", "仅可清除") }}
                    </Badge>
                    <Badge v-else variant="secondary" class="text-[10px] text-muted-foreground">
                      {{ t("recycleBin.statusDependent", "从属对象") }}
                    </Badge>
                  </td>

                  <!-- Row Actions -->
                  <td class="py-2 px-3 text-right">
                    <div class="flex items-center justify-end gap-1">
                      <!-- DROP Restore + Restore As -->
                      <template v-if="item.canRestore && item.operation === 'DROP'">
                        <Button variant="outline" size="sm" class="h-6 px-2 text-[11px] gap-1 border-primary/30 text-primary hover:bg-primary/10" :disabled="mutating" :title="t('recycleBin.restoreDropTip', '使用 TIMECAPSULE TO BEFORE DROP 直接恢复原表名')" @click="void restoreDropDirect(item)">
                          <RotateCcw class="h-3 w-3" />
                          <span>{{ t("recycleBin.restore", "闪回恢复") }}</span>
                        </Button>
                        <Button variant="ghost" size="sm" class="h-6 px-1.5 text-[11px] gap-1 text-muted-foreground hover:text-foreground" :disabled="mutating" :title="t('recycleBin.restoreAs', '重命名恢复')" @click="openRowAction(item, 'rename')">
                          <Pencil class="h-3 w-3" />
                          <span>{{ t("recycleBin.restoreAsShort", "重命名") }}</span>
                        </Button>
                      </template>

                      <!-- TRUNCATE Restore -->
                      <template v-else-if="item.canRestore && item.operation === 'TRUNCATE'">
                        <Button
                          variant="outline"
                          size="sm"
                          class="h-6 px-2 text-[11px] gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
                          :disabled="mutating"
                          :title="t('recycleBin.restoreTruncateTip', '将表数据闪回至 TRUNCATE 之前的状态')"
                          @click="openRowAction(item, 'confirm-truncate')"
                        >
                          <RotateCcw class="h-3 w-3" />
                          <span>{{ t("recycleBin.restore", "闪回恢复") }}</span>
                        </Button>
                      </template>

                      <!-- Purge single item -->
                      <Button v-if="item.canPurge" variant="ghost" size="sm" class="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-destructive" :disabled="mutating" :title="t('recycleBin.purge', '彻底清除')" @click="openRowAction(item, 'confirm-purge')">
                        <Trash2 class="h-3.5 w-3.5" />
                      </Button>

                      <!-- Copy TIMECAPSULE SQL -->
                      <Button
                        variant="ghost"
                        size="sm"
                        class="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                        :disabled="!item.canRestore"
                        :title="item.canRestore ? t('recycleBin.copySql', '复制 TIMECAPSULE SQL') : t('recycleBin.copySqlDisabledTip', '仅表级可恢复对象支持生成 TIMECAPSULE SQL')"
                        @click="void copyItemTimecapsuleSql(item)"
                      >
                        <Check v-if="copiedToken === `sql:${itemKey(item)}`" class="h-3.5 w-3.5 text-emerald-500" />
                        <Copy v-else class="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>

                <!-- Expandable Inline Action Row (Rename DROP / Confirm TRUNCATE / Confirm Single PURGE) -->
                <tr v-if="activeRowAction?.key === itemKey(item)" class="bg-muted/35">
                  <td colspan="8" class="px-4 py-2.5">
                    <!-- 1. Restore DROP As New Table Name -->
                    <div v-if="activeRowAction.mode === 'rename'" class="space-y-2">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <span class="text-xs text-muted-foreground">
                          {{ t("recycleBin.restoreAsHint", "当原表名已被新表占用，或希望保留当前表并恢复历史快照做数据比对时，请指定新表名：") }}
                        </span>
                        <div class="flex items-center gap-2">
                          <input
                            ref="renameInputEl"
                            v-model="renameTargetInput"
                            type="text"
                            class="h-7 w-56 rounded border bg-background px-2.5 font-mono text-xs outline-none focus:border-ring"
                            :placeholder="`${item.originName}_restored`"
                            :disabled="mutating"
                            @keydown.enter.prevent="void restoreDropRenamed(item)"
                            @keydown.esc.prevent="closeRowAction"
                          />
                          <Button size="sm" class="h-7 px-3 text-xs gap-1" :disabled="mutating || !renameTargetInput.trim()" @click="void restoreDropRenamed(item)">
                            <Loader2 v-if="mutating" class="h-3 w-3 animate-spin" />
                            <RotateCcw v-else class="h-3 w-3" />
                            <span>{{ t("recycleBin.confirmRestoreAs", "确认重命名恢复") }}</span>
                          </Button>
                          <Button variant="outline" size="sm" class="h-7 px-2.5 text-xs" :disabled="mutating" @click="closeRowAction">
                            {{ t("recycleBin.cancel", "取消") }}
                          </Button>
                        </div>
                      </div>
                      <div v-if="previewRenameSql(item)" class="text-[11px] font-mono text-muted-foreground bg-background/80 border rounded px-2.5 py-1 break-all">
                        {{ previewRenameSql(item) }}
                      </div>
                    </div>

                    <!-- 2. Confirm TRUNCATE Flashback -->
                    <div v-else-if="activeRowAction.mode === 'confirm-truncate'" class="space-y-2">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex items-center gap-2 text-amber-700 dark:text-amber-300 text-xs">
                          <AlertTriangle class="h-4 w-4 shrink-0" />
                          <span>
                            {{ t("recycleBin.truncateRestoreWarning", { table: qualifiedLiveName(item) }, "注意：执行闪回恢复将使线上表 {table} 的当前数据回退至 TRUNCATE 前的快照，请确认后再继续。") }}
                          </span>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                          <Button size="sm" class="h-7 px-3 text-xs gap-1 bg-amber-600 hover:bg-amber-700 text-white" :disabled="mutating" @click="void confirmRestoreTruncate(item)">
                            <Loader2 v-if="mutating" class="h-3 w-3 animate-spin" />
                            <RotateCcw v-else class="h-3 w-3" />
                            <span>{{ t("recycleBin.confirmTruncateRestore", "确认闪回数据") }}</span>
                          </Button>
                          <Button variant="outline" size="sm" class="h-7 px-2.5 text-xs" :disabled="mutating" @click="closeRowAction">
                            {{ t("recycleBin.cancel", "取消") }}
                          </Button>
                        </div>
                      </div>
                      <div v-if="previewTruncateSql(item)" class="text-[11px] font-mono text-muted-foreground bg-background/80 border rounded px-2.5 py-1 break-all">
                        {{ previewTruncateSql(item) }}
                      </div>
                    </div>

                    <!-- 3. Confirm Single Item PURGE -->
                    <div v-else-if="activeRowAction.mode === 'confirm-purge'" class="space-y-2">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex items-center gap-2 text-destructive text-xs">
                          <AlertCircle class="h-4 w-4 shrink-0" />
                          <span>
                            {{ t("recycleBin.purgeItemWarning", { name: item.originName || item.rcyname }, "彻底清除将从回收站永久物理删除 {name} 并释放存储空间，清除后不可再闪回恢复。") }}
                          </span>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                          <Button variant="destructive" size="sm" class="h-7 px-3 text-xs gap-1" :disabled="mutating" @click="void confirmPurgeSingle(item)">
                            <Loader2 v-if="mutating" class="h-3 w-3 animate-spin" />
                            <Trash2 v-else class="h-3 w-3" />
                            <span>{{ t("recycleBin.confirmPurge", "确认彻底清除") }}</span>
                          </Button>
                          <Button variant="outline" size="sm" class="h-7 px-2.5 text-xs" :disabled="mutating" @click="closeRowAction">
                            {{ t("recycleBin.cancel", "取消") }}
                          </Button>
                        </div>
                      </div>
                      <div v-if="previewPurgeItemSql(item)" class="text-[11px] font-mono text-muted-foreground bg-background/80 border rounded px-2.5 py-1 break-all">
                        {{ previewPurgeItemSql(item) }}
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Inline Confirmation Bar for PURGE RECYCLEBIN -->
      <div v-if="confirmingPurgeAll" class="px-5 py-2.5 border-t bg-destructive/10 text-xs flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div class="flex items-center gap-2 text-destructive min-w-0">
          <AlertTriangle class="h-4 w-4 shrink-0" />
          <span>
            {{ t("recycleBin.purgeAllWarning", "确认执行 PURGE RECYCLEBIN 清空回收站？当前回收站中的所有对象将被永久物理释放，无法撤销。") }}
          </span>
          <code class="px-1.5 py-0.5 rounded bg-background/80 border border-destructive/30 font-mono text-[11px] text-foreground shrink-0"> PURGE RECYCLEBIN </code>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <Button variant="destructive" size="sm" class="h-7 px-3 text-xs gap-1" :disabled="mutating" @click="void confirmPurgeAll()">
            <Loader2 v-if="mutating" class="h-3.5 w-3.5 animate-spin" />
            <Trash2 v-else class="h-3.5 w-3.5" />
            <span>{{ t("recycleBin.confirmPurgeAll", "确认清空回收站") }}</span>
          </Button>
          <Button variant="outline" size="sm" class="h-7 px-2.5 text-xs" :disabled="mutating" @click="confirmingPurgeAll = false">
            {{ t("recycleBin.cancel", "取消") }}
          </Button>
        </div>
      </div>

      <!-- Footer -->
      <DialogFooter class="mx-0 mb-0 px-5 py-3 border-t bg-muted/20 flex flex-row items-center justify-between shrink-0">
        <div class="text-xs text-muted-foreground">
          {{ t("recycleBin.summary", { total: items.length, restorable: restorableCount }, "共 {total} 项回收记录，其中 {restorable} 张表可闪回恢复") }}
        </div>

        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" class="h-7 text-xs gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" :disabled="items.length === 0 || loading || mutating || catalogUnavailable" @click="promptPurgeAll">
            <Trash2 class="h-3.5 w-3.5" />
            <span>{{ t("recycleBin.purgeAll", "清空回收站") }}</span>
          </Button>
          <Button variant="outline" size="sm" class="h-7 text-xs" @click="open = false">
            {{ t("recycleBin.close", "关闭") }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
