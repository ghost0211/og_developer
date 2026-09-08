<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, AlertTriangle, ArrowDown, ArrowUp, Ban, CheckCircle2, Clock, Copy, ExternalLink, Info, Layers, Loader2, Lock, Play, RefreshCcw, Search, ShieldAlert, Trash2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { clampInterval, createProcessListLoadCoordinator, DEFAULT_REFRESH_SECONDS, processListExecutionError } from "@/lib/database/processListDrivers";
import { resolveProcessListDriverForConnection, type ProcessRow } from "@/lib/database/processListDrivers";
import type { BlockingLockRow, LockDetailRow } from "@/lib/database/postgresProcessList";

const props = defineProps<{
  connection: ConnectionConfig;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const { toast } = useToast();

// Driver resolution. Prefer the live store config because ensureConnected can
// hydrate driver_profile/database_info after this panel has already mounted.
const currentConnection = computed(() => connectionStore.getConfig(props.connection.id) ?? props.connection);
const driver = computed(() => resolveProcessListDriverForConnection(currentConnection.value));
const columns = computed(() => driver.value?.columns ?? []);
const numericKeys = computed(() => new Set(columns.value.filter((column) => column.numeric).map((column) => column.key)));

// Active View Tab
const activeMainTab = ref<"sessions" | "blocking" | "locks">("sessions");

// Data States
const rows = ref<ProcessRow[]>([]);
const blockingLocks = ref<BlockingLockRow[]>([]);
const resourceLocks = ref<LockDetailRow[]>([]);
const truncated = ref(false);
const ownSessionId = ref<number | null>(null);
const loading = ref(false);
const loadCoordinator = createProcessListLoadCoordinator();
const loadError = ref("");

// Filter & Sort
const search = ref("");
const stateFilter = ref<"all" | "active" | "waiting" | "idle_in_transaction" | "idle">("all");
const sortKey = ref<string>(driver.value?.defaultSortKey ?? "time");
const sortDir = ref<"asc" | "desc">("desc");

// Selected Session for Inspector Panel
const selectedSession = ref<ProcessRow | null>(null);

// Auto-Refresh
const autoRefresh = ref(false);
const intervalSeconds = ref(DEFAULT_REFRESH_SECONDS);
let timer: ReturnType<typeof setInterval> | undefined;

// Action Targets & Modals
const killTarget = ref<ProcessRow | null>(null);
const cancelTarget = ref<ProcessRow | null>(null);
const killing = ref(false);
const cancelling = ref(false);
const fallbackListSql = ref<string | null>(null);

// Full-text preview for statements
const previewText = ref<string | null>(null);

// Supports blocking/locks tab
const supportsLocks = computed(() => !!driver.value?.blockingLocksSql || !!driver.value?.locksSql);

// Privilege and visibility detection for openGauss / PostgreSQL
const currentDbUser = computed(() => props.connection.username?.trim() || "CURRENT_USER");
const isPostgresOrOpenGauss = computed(() => {
  const t = props.connection.db_type;
  return t === "opengauss" || t === "postgres";
});

const isOnlyOwnSession = computed(() => {
  if (rows.value.length === 0) return false;
  const otherRows = rows.value.filter((r) => !isOwnSession(r));
  return otherRows.length === 0;
});

const grantCommand = computed(() => {
  const user = currentDbUser.value;
  if (props.connection.db_type === "opengauss") {
    return `GRANT monadmin TO ${user};`;
  }
  return `GRANT pg_read_all_stats TO ${user};`;
});

async function copyGrantCommand() {
  await copyToClipboard(grantCommand.value);
  toast(t("processList.grantCopied", { sql: grantCommand.value }, `已复制授权 SQL: ${grantCommand.value}`), 2000);
}

// Formatted duration helper
function formatDuration(seconds: number | string | null | undefined): string {
  if (seconds === null || seconds === undefined || isNaN(Number(seconds))) return "-";
  const sec = Math.floor(Number(seconds));
  if (sec < 0) return "0s";
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

// Statistics Counters
const stats = computed(() => {
  let active = 0;
  let waiting = 0;
  let idleInXact = 0;
  let maxTime = 0;

  for (const row of rows.value) {
    const st = String(row.state || row.command || "").toLowerCase();
    const wait = String(row.wait || "").toLowerCase();
    const time = typeof row.time === "number" ? row.time : 0;
    if (time > maxTime) maxTime = time;

    if (wait && wait !== "none" && wait !== "") {
      waiting++;
    }
    if (st.includes("active") || st === "query" || st === "execute") {
      active++;
    } else if (st.includes("idle in transaction")) {
      idleInXact++;
    }
  }

  return {
    total: rows.value.length,
    active,
    waiting,
    idleInXact,
    maxTime,
  };
});

// Filtered & Sorted Sessions
const filteredRows = computed(() => {
  let base = rows.value.slice();

  // State Filter
  if (stateFilter.value !== "all") {
    base = base.filter((row) => {
      const st = String(row.state || row.command || "").toLowerCase();
      const wait = String(row.wait || "").toLowerCase();
      if (stateFilter.value === "active") {
        return st.includes("active") || st === "query" || st === "execute";
      }
      if (stateFilter.value === "waiting") {
        return wait && wait !== "none" && wait !== "";
      }
      if (stateFilter.value === "idle_in_transaction") {
        return st.includes("idle in transaction");
      }
      if (stateFilter.value === "idle") {
        return st === "idle" || st === "sleep";
      }
      return true;
    });
  }

  // Text search
  const query = search.value.trim().toLowerCase();
  if (query) {
    base = base.filter((row) => Object.values(row).some((value) => value !== null && value !== undefined && String(value).toLowerCase().includes(query)));
  }

  // Sort
  const key = sortKey.value;
  const dir = sortDir.value === "asc" ? 1 : -1;
  return base.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
});

function toggleSort(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDir.value = numericKeys.value.has(key) ? "desc" : "asc";
  }
}

// Load data
async function load(options: { silent?: boolean } = {}) {
  if (!loadCoordinator.tryStart()) return;
  if (!options.silent) loading.value = true;
  loadError.value = "";

  try {
    // Connecting can hydrate/normalize the profile, so resolve the driver
    // after ensureConnected rather than silently returning on an early null.
    await connectionStore.ensureConnected(props.connection.id);
    const activeDriver = driver.value;
    if (!activeDriver) {
      throw new Error(t("processList.monitorUnsupported", { type: currentConnection.value.db_type }, `当前连接类型暂不支持会话监控：${currentConnection.value.db_type}`));
    }

    // Identify own session
    if (ownSessionId.value === null) {
      try {
        let idResult;
        try {
          idResult = await api.executeQuery(props.connection.id, "", activeDriver.ownSessionSql, undefined, undefined, { maxRows: 1 });
        } catch (error) {
          if (!activeDriver.fallbackOwnSessionSql || !activeDriver.shouldUseFallbackOwnSessionSql?.(error)) throw error;
          idResult = await api.executeQuery(props.connection.id, "", activeDriver.fallbackOwnSessionSql, undefined, undefined, { maxRows: 1 });
        }
        const raw = idResult?.rows?.[0]?.[0];
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) ownSessionId.value = parsed;
      } catch {
        // Non-fatal
      }
    }

    // Sessions query
    const listSql = fallbackListSql.value ?? activeDriver.listSql;
    let result;
    try {
      result = await api.executeQuery(props.connection.id, "", listSql, undefined, undefined, { maxRows: activeDriver.maxRows });
    } catch (error) {
      if (fallbackListSql.value || !activeDriver.fallbackListSql || !activeDriver.shouldUseFallbackListSql?.(error)) throw error;
      result = await api.executeQuery(props.connection.id, "", activeDriver.fallbackListSql, undefined, undefined, { maxRows: activeDriver.maxRows });
      fallbackListSql.value = activeDriver.fallbackListSql;
    }
    rows.value = activeDriver.mapRows(result);
    truncated.value = result.truncated === true;

    // Optional: Load blocking locks & resource locks if driver supports it
    if (activeDriver.blockingLocksSql && activeDriver.mapBlockingLocks) {
      try {
        const blResult = await api.executeQuery(props.connection.id, "", activeDriver.blockingLocksSql, undefined, undefined, { maxRows: 100 });
        blockingLocks.value = activeDriver.mapBlockingLocks(blResult);
      } catch {
        blockingLocks.value = [];
      }
    }

    if (activeDriver.locksSql && activeDriver.mapLocks) {
      try {
        const lkResult = await api.executeQuery(props.connection.id, "", activeDriver.locksSql, undefined, undefined, { maxRows: 300 });
        resourceLocks.value = activeDriver.mapLocks(lkResult);
      } catch {
        resourceLocks.value = [];
      }
    }

    // Refresh selected session reference if open
    if (selectedSession.value) {
      const match = rows.value.find((r) => r.id === selectedSession.value?.id);
      if (match) selectedSession.value = match;
    }
  } catch (error: any) {
    loadError.value = error?.message || String(error);
  } finally {
    loading.value = false;
    loadCoordinator.finish();
  }
}

function isOwnSession(row: ProcessRow): boolean {
  return ownSessionId.value !== null && row.id === ownSessionId.value;
}

function selectRow(row: ProcessRow) {
  if (selectedSession.value?.id === row.id) {
    selectedSession.value = null;
  } else {
    selectedSession.value = row;
  }
}

function openPreview(value: string | number | null) {
  if (value === null || value === undefined || String(value).length === 0) return;
  previewText.value = String(value);
}

async function copyPreview() {
  if (previewText.value === null) return;
  try {
    await copyToClipboard(previewText.value);
    toast(t("processList.copied", "已复制"), 1500);
  } catch (error: any) {
    toast(error?.message || String(error), 3000);
  }
}

function openInSqlEditor(queryText: string | number | null | undefined) {
  if (!queryText) return;
  const sql = String(queryText).trim();
  if (!sql) return;
  const tabId = queryStore.createTab(props.connection.id, "", "Inspected Query", "query");
  queryStore.updateSql(tabId, sql);
}

// Kill session
function requestKill(row: ProcessRow) {
  if (isOwnSession(row)) return;
  killTarget.value = row;
}

async function confirmKill() {
  const target = killTarget.value;
  const activeDriver = driver.value;
  if (!target || !activeDriver) return;
  killing.value = true;
  try {
    const killSql = activeDriver.buildKillSql(target.id);
    let usedFallbackKillSql = false;
    const executeKillSql = async (sql: string) => {
      const results = await api.executeMulti(props.connection.id, "", sql, undefined, undefined, { maxRows: 1 });
      const executionError = processListExecutionError(results);
      if (executionError) throw new Error(executionError);
      return results;
    };
    const result = await executeWithProductionSqlGuard({
      connection: props.connection,
      database: "",
      sql: killSql,
      source: t("production.sourceAdmin", "会话管理"),
      execute: async () => {
        try {
          return await executeKillSql(killSql);
        } catch (error) {
          if (!activeDriver.buildFallbackKillSql || !activeDriver.shouldUseFallbackKillSql?.(error)) throw error;
          usedFallbackKillSql = true;
          return executeKillSql(activeDriver.buildFallbackKillSql(target.id));
        }
      },
    });
    if (result === undefined) return;
    const killResultError = usedFallbackKillSql ? activeDriver.fallbackKillResultError?.(result) : activeDriver.killResultError?.(result);
    if (killResultError) throw new Error(killResultError);
    toast(t("processList.killSuccess", { id: target.id }), 2500);
    killTarget.value = null;
    if (selectedSession.value?.id === target.id) selectedSession.value = null;
    await load({ silent: true });
  } catch (error: any) {
    toast(t("processList.killFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    killing.value = false;
  }
}

// Cancel running query
function requestCancel(row: ProcessRow) {
  cancelTarget.value = row;
}

async function confirmCancel() {
  const target = cancelTarget.value;
  const activeDriver = driver.value;
  if (!target || !activeDriver || !activeDriver.buildCancelSql) return;
  cancelling.value = true;
  try {
    const cancelSql = activeDriver.buildCancelSql(target.id);
    const result = await executeWithProductionSqlGuard({
      connection: props.connection,
      database: "",
      sql: cancelSql,
      source: t("production.sourceAdmin", "会话管理"),
      execute: async () => {
        const results = await api.executeMulti(props.connection.id, "", cancelSql, undefined, undefined, { maxRows: 1 });
        const executionError = processListExecutionError(results);
        if (executionError) throw new Error(executionError);
        return results;
      },
    });
    if (result === undefined) return;
    toast(t("processList.cancelSuccess", { id: target.id }, `已取消会话 ${target.id} 的当前查询`), 2500);
    cancelTarget.value = null;
    await load({ silent: true });
  } catch (error: any) {
    toast(t("processList.cancelFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    cancelling.value = false;
  }
}

// Timer management
function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

function restartTimer() {
  stopTimer();
  if (!autoRefresh.value) return;
  const seconds = clampInterval(intervalSeconds.value);
  timer = setInterval(() => {
    if (document.hidden) return;
    void load({ silent: true });
  }, seconds * 1000);
}

function onIntervalInput() {
  intervalSeconds.value = clampInterval(Number(intervalSeconds.value));
  if (autoRefresh.value) restartTimer();
}

watch(autoRefresh, restartTimer);
watch(intervalSeconds, () => {
  if (autoRefresh.value) restartTimer();
});

watch(
  () => [props.connection.id, props.connection.db_type, props.connection.driver_profile, currentConnection.value.db_type, currentConnection.value.driver_profile] as const,
  () => {
    rows.value = [];
    blockingLocks.value = [];
    resourceLocks.value = [];
    truncated.value = false;
    ownSessionId.value = null;
    selectedSession.value = null;
    search.value = "";
    stateFilter.value = "all";
    sortKey.value = driver.value?.defaultSortKey ?? "time";
    sortDir.value = "desc";
    void load();
  },
);

onMounted(() => void load());
onBeforeUnmount(stopTimer);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background text-foreground select-text">
    <!-- Top Action Toolbar -->
    <div class="flex flex-wrap items-center justify-between border-b bg-muted/40 px-3 py-1.5 text-xs shrink-0 select-none gap-2">
      <!-- Main Title & Navigation Tabs -->
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-2">
          <Activity class="h-4 w-4 text-primary" />
          <span class="font-semibold text-sm">{{ t("processList.title", "会话与锁监控") }}</span>
          <Badge variant="outline" class="h-5 px-2 text-[11px] font-mono">{{ connection.name }}</Badge>
        </div>

        <!-- Mode Tabs -->
        <div class="flex items-center gap-1 bg-muted/60 p-0.5 rounded-md border">
          <button type="button" class="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all" :class="activeMainTab === 'sessions' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="activeMainTab = 'sessions'">
            <Layers class="h-3.5 w-3.5 text-primary" />
            <span>{{ t("processList.allSessions", "活动会话") }}</span>
            <span class="rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">
              {{ rows.length }}
            </span>
          </button>

          <button
            v-if="supportsLocks"
            type="button"
            class="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all"
            :class="activeMainTab === 'blocking' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            @click="activeMainTab = 'blocking'"
          >
            <ShieldAlert class="h-3.5 w-3.5" :class="blockingLocks.length > 0 ? 'text-destructive animate-pulse' : 'text-amber-500'" />
            <span>{{ t("processList.blockingLocks", "锁与阻塞") }}</span>
            <span v-if="blockingLocks.length > 0" class="rounded-full bg-destructive text-destructive-foreground px-1.5 py-0.2 text-[10px] font-mono font-bold">
              {{ blockingLocks.length }}
            </span>
          </button>

          <button v-if="supportsLocks" type="button" class="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all" :class="activeMainTab === 'locks' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="activeMainTab = 'locks'">
            <Lock class="h-3.5 w-3.5 text-blue-500" />
            <span>{{ t("processList.resourceLocks", "锁详情") }}</span>
            <span v-if="resourceLocks.length" class="rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">
              {{ resourceLocks.length }}
            </span>
          </button>
        </div>
      </div>

      <!-- Controls: Auto-refresh & Search -->
      <div class="flex items-center gap-2">
        <div class="relative w-44">
          <Search class="absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input v-model="search" class="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs outline-none focus:border-ring placeholder:text-muted-foreground" :placeholder="t('processList.filter', '过滤会话 / PID / 用户...')" />
        </div>

        <label class="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input v-model="autoRefresh" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
          <span>{{ t("processList.autoRefresh", "自动刷新") }}</span>
        </label>

        <div class="flex h-7 items-center gap-1 rounded-md border bg-background px-1.5">
          <Input v-model.number="intervalSeconds" type="number" min="1" max="3600" class="h-6 w-12 border-0 px-1 text-xs shadow-none focus-visible:ring-0 text-center" @change="onIntervalInput" />
          <span class="pr-1 text-[11px] text-muted-foreground">{{ t("processList.seconds", "秒") }}</span>
        </div>

        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" :disabled="loading" @click="load()">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          <span>{{ t("grid.refresh", "刷新") }}</span>
        </Button>
      </div>
    </div>

    <!-- Error Banner (if any) -->
    <div v-if="loadError" class="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive flex items-center justify-between">
      <span>{{ loadError }}</span>
      <Button variant="ghost" size="sm" class="h-5 w-5 p-0" @click="loadError = ''"><X class="h-3 w-3" /></Button>
    </div>

    <!-- Privilege Notice Banner (When ordinary user only sees own session) -->
    <div v-if="isPostgresOrOpenGauss && isOnlyOwnSession && !loading" class="flex items-center justify-between border-b bg-amber-500/10 border-amber-500/20 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300">
      <div class="flex items-center gap-2">
        <Info class="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>
          {{ t("processList.ownSessionOnlyHint", { user: currentDbUser }, `当前用户 ${currentDbUser} 仅能查看自身会话。openGauss 安全策略要求 monadmin（监控管理员）或 sysadmin 角色方可查看全库所有用户的进程与 SQL。`) }}
        </span>
      </div>
      <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px] border-amber-500/40 hover:bg-amber-500/20 shrink-0" @click="copyGrantCommand">
        <Copy class="h-3 w-3" />
        <span>{{ t("processList.copyGrantSql", "复制授权 SQL") }} ({{ props.connection.db_type === "opengauss" ? "GRANT monadmin" : "GRANT pg_read_all_stats" }})</span>
      </Button>
    </div>

    <!-- Main Content Area: Tab 1 - Sessions -->
    <div v-if="activeMainTab === 'sessions'" class="flex-1 min-h-0 flex flex-col">
      <!-- Statistics Metric Strip -->
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 px-3 py-2 bg-muted/20 border-b shrink-0 text-xs select-none">
        <div class="flex items-center gap-2 p-1.5 rounded bg-background border">
          <Activity class="h-4 w-4 text-primary" />
          <div>
            <div class="text-[10px] text-muted-foreground">{{ t("processList.statTotal", "总会话数") }}</div>
            <div class="font-bold text-sm font-mono">{{ stats.total }}</div>
          </div>
        </div>

        <div class="flex items-center gap-2 p-1.5 rounded bg-background border">
          <Play class="h-4 w-4 text-emerald-500 fill-current" />
          <div>
            <div class="text-[10px] text-muted-foreground">{{ t("processList.statActive", "活跃查询") }}</div>
            <div class="font-bold text-sm font-mono text-emerald-600 dark:text-emerald-400">{{ stats.active }}</div>
          </div>
        </div>

        <div class="flex items-center gap-2 p-1.5 rounded bg-background border">
          <Lock class="h-4 w-4 text-amber-500" />
          <div>
            <div class="text-[10px] text-muted-foreground">{{ t("processList.statWaiting", "锁等待中") }}</div>
            <div class="font-bold text-sm font-mono" :class="stats.waiting > 0 ? 'text-amber-500 font-bold' : ''">{{ stats.waiting }}</div>
          </div>
        </div>

        <div class="flex items-center gap-2 p-1.5 rounded bg-background border">
          <Clock class="h-4 w-4 text-blue-500" />
          <div>
            <div class="text-[10px] text-muted-foreground">{{ t("processList.statIdleInXact", "事务中空闲") }}</div>
            <div class="font-bold text-sm font-mono text-blue-500">{{ stats.idleInXact }}</div>
          </div>
        </div>

        <div class="flex items-center gap-2 p-1.5 rounded bg-background border">
          <Clock class="h-4 w-4 text-purple-500" />
          <div>
            <div class="text-[10px] text-muted-foreground">{{ t("processList.statMaxTime", "最长耗时") }}</div>
            <div class="font-bold text-sm font-mono">{{ formatDuration(stats.maxTime) }}</div>
          </div>
        </div>
      </div>

      <!-- Quick Status Filter Segment -->
      <div class="flex items-center justify-between border-b bg-muted/10 px-3 py-1 text-xs shrink-0 select-none">
        <div class="flex items-center gap-1">
          <button type="button" class="px-2 py-0.5 rounded text-[11px] font-medium transition-colors" :class="stateFilter === 'all' ? 'bg-primary text-primary-foreground font-semibold' : 'text-muted-foreground hover:bg-muted'" @click="stateFilter = 'all'">
            {{ t("processList.filterAll", "全部") }} ({{ stats.total }})
          </button>
          <button type="button" class="px-2 py-0.5 rounded text-[11px] font-medium transition-colors" :class="stateFilter === 'active' ? 'bg-emerald-600 text-white font-semibold' : 'text-muted-foreground hover:bg-muted'" @click="stateFilter = 'active'">
            {{ t("processList.filterActive", "活跃") }} ({{ stats.active }})
          </button>
          <button type="button" class="px-2 py-0.5 rounded text-[11px] font-medium transition-colors" :class="stateFilter === 'waiting' ? 'bg-amber-500 text-white font-semibold' : 'text-muted-foreground hover:bg-muted'" @click="stateFilter = 'waiting'">
            {{ t("processList.filterWaiting", "等待锁") }} ({{ stats.waiting }})
          </button>
          <button type="button" class="px-2 py-0.5 rounded text-[11px] font-medium transition-colors" :class="stateFilter === 'idle_in_transaction' ? 'bg-blue-600 text-white font-semibold' : 'text-muted-foreground hover:bg-muted'" @click="stateFilter = 'idle_in_transaction'">
            {{ t("processList.filterIdleInXact", "事务空闲") }} ({{ stats.idleInXact }})
          </button>
        </div>

        <div class="text-[11px] text-muted-foreground">{{ t("processList.clickRowHint", "点击行可查看完整 SQL 及会话详情") }}</div>
      </div>

      <!-- Main Sessions Table -->
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="w-full border-collapse text-xs">
          <thead class="sticky top-0 z-10 bg-muted/90 backdrop-blur select-none">
            <tr>
              <th v-for="column in columns" :key="column.key" class="cursor-pointer select-none whitespace-nowrap border-b px-3 py-2 text-left font-medium hover:bg-accent" @click="toggleSort(column.key)">
                <span class="inline-flex items-center gap-1">
                  {{ t(column.labelKey) }}
                  <ArrowUp v-if="sortKey === column.key && sortDir === 'asc'" class="h-3 w-3" />
                  <ArrowDown v-else-if="sortKey === column.key && sortDir === 'desc'" class="h-3 w-3" />
                </span>
              </th>
              <th class="w-28 whitespace-nowrap border-b px-3 py-2 text-right font-medium">{{ t("processList.colActions", "操作") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in filteredRows" :key="row.id" class="border-b transition-colors cursor-pointer" :class="[selectedSession?.id === row.id ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-accent/40', isOwnSession(row) ? 'bg-muted/30' : '']" @click="selectRow(row)">
              <td v-for="column in columns" :key="column.key" class="px-3 py-1.5" :class="[column.mono ? 'font-mono' : '', column.wide ? 'max-w-md truncate' : 'whitespace-nowrap']">
                <!-- PID Column -->
                <template v-if="column.key === 'id'">
                  <span class="font-bold text-foreground font-mono">{{ row.id }}</span>
                  <Badge v-if="isOwnSession(row)" variant="outline" class="ml-1.5 h-4 rounded px-1 text-[9px] border-primary text-primary">
                    {{ t("processList.self", "当前") }}
                  </Badge>
                </template>

                <!-- State Column -->
                <template v-else-if="column.key === 'state'">
                  <span
                    v-if="row.state"
                    :class="[
                      'inline-block px-1.5 py-0.5 rounded text-[10px] font-medium',
                      String(row.state).toLowerCase().includes('active') ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold' : '',
                      String(row.state).toLowerCase().includes('idle in transaction') ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold' : '',
                      String(row.state).toLowerCase() === 'idle' ? 'text-muted-foreground' : '',
                    ]"
                  >
                    {{ row.state }}
                  </span>
                  <span v-else class="text-muted-foreground/40">-</span>
                </template>

                <!-- Wait Event Column -->
                <template v-else-if="column.key === 'wait'">
                  <span v-if="row.wait" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400" :title="String(row.wait)">
                    <Lock class="h-2.5 w-2.5" />
                    <span>{{ row.wait }}</span>
                  </span>
                  <span v-else class="text-muted-foreground/40">-</span>
                </template>

                <!-- Time Column -->
                <template v-else-if="column.key === 'time'">
                  <span :class="Number(row.time) > 30 ? 'font-bold text-amber-600 dark:text-amber-400' : 'text-muted-foreground'">
                    {{ formatDuration(row.time) }}
                  </span>
                </template>

                <!-- Wide Query / Info Column -->
                <template v-else-if="column.wide">
                  <span class="text-foreground/90 font-mono text-[11px] truncate block max-w-lg" :title="String(row[column.key] ?? '')">
                    {{ row[column.key] || "—" }}
                  </span>
                </template>

                <!-- Fallback Column -->
                <template v-else>
                  {{ row[column.key] === null || row[column.key] === undefined ? "—" : row[column.key] }}
                </template>
              </td>

              <!-- Actions Column -->
              <td class="px-3 py-1.5 text-right whitespace-nowrap" @click.stop>
                <div class="flex items-center justify-end gap-1">
                  <!-- Cancel Running Query -->
                  <Button v-if="driver?.buildCancelSql" variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-[11px] text-amber-600 hover:bg-amber-500/10 hover:text-amber-600" :title="t('processList.cancelQueryTitle', '取消当前执行中的查询')" @click="requestCancel(row)">
                    <Ban class="h-3 w-3" />
                    <span>{{ t("processList.cancelShort", "取消") }}</span>
                  </Button>

                  <!-- Kill Session -->
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-6 gap-1 px-1.5 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                    :disabled="isOwnSession(row)"
                    :title="isOwnSession(row) ? t('processList.cannotKillSelf') : t('processList.kill')"
                    @click="requestKill(row)"
                  >
                    <Trash2 class="h-3 w-3" />
                    <span>{{ t("processList.killShort", "终止") }}</span>
                  </Button>
                </div>
              </td>
            </tr>

            <tr v-if="!loading && filteredRows.length === 0">
              <td :colspan="columns.length + 1" class="px-3 py-12 text-center text-muted-foreground">
                {{ search ? t("grid.noSearchResults") : t("processList.empty", "暂无活动会话") }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Lower Session Inspector Drawer (When row selected) -->
      <div v-if="selectedSession" class="border-t bg-muted/20 p-3 flex flex-col gap-2 shrink-0 max-h-56 overflow-hidden">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="font-bold text-xs">{{ t("processList.sessionDetails", { pid: selectedSession.id }, `会话详情 (PID: ${selectedSession.id})`) }}</span>
            <Badge variant="outline" class="text-[10px]">{{ selectedSession.user }} @ {{ selectedSession.client || selectedSession.host || "local" }}</Badge>
            <Badge v-if="selectedSession.db" variant="secondary" class="text-[10px]">{{ selectedSession.db }}</Badge>
            <Badge v-if="selectedSession.state" variant="outline" class="text-[10px]">{{ selectedSession.state }}</Badge>
            <span class="text-muted-foreground text-[11px]">{{ t("processList.elapsed", "耗时") }}: {{ formatDuration(selectedSession.time) }}</span>
          </div>

          <div class="flex items-center gap-1">
            <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-[11px]" @click="openInSqlEditor(selectedSession.query || selectedSession.info)">
              <ExternalLink class="h-3 w-3" />
              <span>{{ t("processList.openInSqlEditor", "在 SQL 编辑器中打开") }}</span>
            </Button>
            <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-[11px]" @click="openPreview(selectedSession.query || selectedSession.info)">
              <Copy class="h-3 w-3" />
              <span>{{ t("processList.copySql", "复制 SQL") }}</span>
            </Button>
            <Button variant="ghost" size="sm" class="h-6 w-6 p-0" @click="selectedSession = null">
              <X class="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <pre class="flex-1 min-h-0 overflow-auto whitespace-pre-wrap break-all rounded bg-background border p-2 font-mono text-xs text-foreground leading-relaxed">{{ selectedSession.query || selectedSession.info || t("processList.noActiveSql", "-- 暂无活跃 SQL") }}</pre>
      </div>
    </div>

    <!-- Main Content Area: Tab 2 - Lock & Blocking Tree -->
    <div v-else-if="activeMainTab === 'blocking'" class="flex-1 min-h-0 flex flex-col p-3 overflow-auto">
      <div v-if="blockingLocks.length === 0" class="flex flex-col items-center justify-center p-16 gap-3 text-muted-foreground">
        <CheckCircle2 class="h-10 w-10 text-emerald-500" />
        <span class="text-sm font-medium text-foreground">{{ t("processList.noBlockingTitle", "数据库当前运行顺畅，未检测到锁阻塞链路") }}</span>
        <span class="text-xs">{{ t("processList.noBlockingDesc", "所有事务正常获取并释放锁，无死锁或排他锁阻塞情况。") }}</span>
      </div>

      <div v-else class="space-y-3">
        <div class="rounded-md border border-destructive/40 bg-destructive/10 p-3 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <AlertTriangle class="h-5 w-5 text-destructive" />
            <span class="font-bold text-sm text-destructive">{{ t("processList.blockingAlert", { count: blockingLocks.length }, `检测到 ${blockingLocks.length} 条锁阻塞链路`) }}</span>
          </div>
          <span class="text-xs text-destructive/80">{{ t("processList.blockingHint", "以下会话正在等待排他锁，可选择一键终止阻塞源会话以解除阻塞。") }}</span>
        </div>

        <div class="w-full overflow-auto rounded-md border">
          <table class="w-full border-collapse text-xs">
            <thead class="bg-muted/50 border-b">
              <tr>
                <th class="py-2 px-3 text-left w-[200px]">{{ t("processList.blockingSource", "阻塞源 (Blocking Session)") }}</th>
                <th class="py-2 px-3 text-left w-[200px]">{{ t("processList.blockedTarget", "被阻塞者 (Blocked Session)") }}</th>
                <th class="py-2 px-3 text-left w-[140px]">{{ t("processList.colRelation", "锁定对象 (Relation)") }}</th>
                <th class="py-2 px-3 text-left w-[140px]">{{ t("processList.colLockMode", "锁模式 (Lock Mode)") }}</th>
                <th class="py-2 px-3 text-left w-[100px]">{{ t("processList.colWaitTime", "等待时长") }}</th>
                <th class="py-2 px-3 text-right w-[120px]">{{ t("processList.colActions", "操作") }}</th>
              </tr>
            </thead>
            <tbody class="divide-y font-mono">
              <tr v-for="(chain, cIdx) in blockingLocks" :key="cIdx" class="hover:bg-muted/40 transition-colors">
                <!-- Blocking Source -->
                <td class="py-2 px-3">
                  <div class="font-bold text-destructive flex items-center gap-1">
                    <span>PID: {{ chain.blockingPid }}</span>
                    <Badge variant="destructive" class="text-[9px] px-1 py-0">{{ t("processList.blockingSourceShort", "阻塞源") }}</Badge>
                  </div>
                  <div class="text-muted-foreground text-[11px]">{{ chain.blockingUser }} @ {{ chain.blockingDb || "db" }}</div>
                  <div class="text-[10px] text-muted-foreground/80 truncate max-w-[200px]" :title="chain.blockingQuery || ''">
                    {{ chain.blockingQuery || "-" }}
                  </div>
                </td>

                <!-- Blocked Target -->
                <td class="py-2 px-3">
                  <div class="font-bold text-amber-600 dark:text-amber-400">PID: {{ chain.blockedPid }}</div>
                  <div class="text-muted-foreground text-[11px]">{{ chain.blockedUser }} @ {{ chain.blockedDb || "db" }}</div>
                  <div class="text-[10px] text-muted-foreground/80 truncate max-w-[200px]" :title="chain.blockedQuery || ''">
                    {{ chain.blockedQuery || "-" }}
                  </div>
                </td>

                <!-- Relation -->
                <td class="py-2 px-3 text-foreground font-semibold">
                  {{ chain.relation }}
                  <span class="block text-[10px] text-muted-foreground font-normal">{{ chain.lockType }}</span>
                </td>

                <!-- Mode -->
                <td class="py-2 px-3">
                  <span class="text-destructive font-semibold">{{ chain.grantedMode }}</span>
                  <span class="text-muted-foreground text-[10px] block">➔ {{ t("processList.waitingFor", { mode: chain.requestedMode }, `等待: ${chain.requestedMode}`) }}</span>
                </td>

                <!-- Wait time -->
                <td class="py-2 px-3 font-bold text-destructive">
                  {{ formatDuration(chain.waitTime) }}
                </td>

                <!-- Action -->
                <td class="py-2 px-3 text-right">
                  <Button variant="destructive" size="sm" class="h-6 px-2 text-[11px]" @click="requestKill({ id: chain.blockingPid, user: chain.blockingUser } as ProcessRow)"> {{ t("processList.killBlockingSource", "终止阻塞源") }} </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Main Content Area: Tab 3 - Resource Locks List -->
    <div v-else-if="activeMainTab === 'locks'" class="flex-1 min-h-0 flex flex-col">
      <div class="flex items-center justify-between border-b bg-muted/15 px-3 py-1.5 text-xs select-none">
        <span class="text-muted-foreground">{{ t("processList.resourceLockSummary", { count: resourceLocks.length }, `其他会话资源锁清单 (共 ${resourceLocks.length} 条记录)`) }}</span>
        <span class="text-[11px] text-muted-foreground">{{ t("processList.resourceLockScopeHint", "当前连接自身的锁不列入此页") }}</span>
      </div>

      <div v-if="resourceLocks.length === 0" class="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-sm text-muted-foreground">
        <CheckCircle2 class="h-8 w-8 text-emerald-500" />
        <span>{{ t("processList.noOtherResourceLocks", "当前没有其他会话持有资源锁") }}</span>
      </div>

      <div v-else class="min-h-0 flex-1 overflow-auto">
        <table class="w-full border-collapse text-xs font-mono">
          <thead class="sticky top-0 bg-muted/90 backdrop-blur border-b select-none font-sans text-muted-foreground">
            <tr>
              <th class="py-1.5 px-3 text-left w-[80px]">PID</th>
              <th class="py-1.5 px-3 text-left w-[120px]">{{ t("processList.colUser", "用户") }}</th>
              <th class="py-1.5 px-3 text-left w-[120px]">{{ t("processList.colLockType", "锁类型") }}</th>
              <th class="py-1.5 px-3 text-left w-[160px]">{{ t("processList.colRelation", "锁定对象 (Relation)") }}</th>
              <th class="py-1.5 px-3 text-left w-[160px]">{{ t("processList.colLockModeShort", "锁模式 (Mode)") }}</th>
              <th class="py-1.5 px-3 text-left w-[90px]">{{ t("processList.colGranted", "状态 (Granted)") }}</th>
              <th class="py-1.5 px-3 text-left w-[90px]">{{ t("processList.colTime", "耗时") }}</th>
              <th class="py-1.5 px-3 text-left">{{ t("processList.colRelatedQuery", "关联查询") }}</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr v-for="(lk, lkIdx) in resourceLocks" :key="lkIdx" class="hover:bg-muted/40 transition-colors">
              <td class="py-1.5 px-3 font-bold text-foreground">{{ lk.pid }}</td>
              <td class="py-1.5 px-3 text-muted-foreground">{{ lk.user }}</td>
              <td class="py-1.5 px-3">{{ lk.lockType }}</td>
              <td class="py-1.5 px-3 font-semibold text-foreground truncate max-w-[160px]" :title="lk.relation">{{ lk.relation }}</td>
              <td class="py-1.5 px-3">{{ lk.mode }}</td>
              <td class="py-1.5 px-3">
                <Badge :variant="lk.granted ? 'outline' : 'destructive'" class="text-[10px] px-1.5 py-0">
                  {{ lk.granted ? t("processList.lockGranted", "已持有") : t("processList.lockWaiting", "等待中") }}
                </Badge>
              </td>
              <td class="py-1.5 px-3 text-muted-foreground">{{ formatDuration(lk.time) }}</td>
              <td class="py-1.5 px-3 truncate max-w-xs text-muted-foreground" :title="lk.query || ''">
                {{ lk.query || "-" }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Kill Session Confirmation Dialog -->
    <Dialog
      :open="killTarget !== null"
      @update:open="
        (open) => {
          if (!open) killTarget = null;
        }
      "
    >
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <AlertTriangle class="h-4 w-4 text-destructive" />
            {{ t("processList.killTitle", "终止会话") }}
          </DialogTitle>
        </DialogHeader>
        <p v-if="killTarget" class="text-sm text-muted-foreground">
          {{ t("processList.killConfirm", { id: killTarget.id, user: killTarget.user || "-" }, `确定终止会话 ${killTarget.id}（${killTarget.user}）？其当前语句将被中止，连接将被关闭。`) }}
        </p>
        <DialogFooter>
          <Button variant="outline" @click="killTarget = null">{{ t("dangerDialog.cancel", "取消") }}</Button>
          <Button variant="destructive" :disabled="killing" @click="confirmKill">
            <Loader2 v-if="killing" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t("processList.kill", "终止会话") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Cancel Query Confirmation Dialog -->
    <Dialog
      :open="cancelTarget !== null"
      @update:open="
        (open) => {
          if (!open) cancelTarget = null;
        }
      "
    >
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <Ban class="h-4 w-4 text-amber-500" />
            <span>{{ t("processList.cancelQuery", "取消查询") }}</span>
          </DialogTitle>
        </DialogHeader>
        <p v-if="cancelTarget" class="text-sm text-muted-foreground">
          {{ t("processList.cancelConfirm", { id: cancelTarget.id, user: cancelTarget.user || "-" }, `确定取消会话 ${cancelTarget.id}（${cancelTarget.user}）当前正在执行的查询？连接将保持打开。`) }}
        </p>
        <DialogFooter>
          <Button variant="outline" @click="cancelTarget = null">{{ t("dangerDialog.cancel", "放弃") }}</Button>
          <Button variant="default" class="bg-amber-600 hover:bg-amber-700 text-white" :disabled="cancelling" @click="confirmCancel">
            <Loader2 v-if="cancelling" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            <span>{{ t("processList.cancelQuery", "取消查询") }}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Statement Full-Text Preview Dialog -->
    <Dialog
      :open="previewText !== null"
      @update:open="
        (open) => {
          if (!open) previewText = null;
        }
      "
    >
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ t("processList.previewTitle", "SQL 语句") }}</DialogTitle>
        </DialogHeader>
        <pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed">{{ previewText }}</pre>
        <div class="text-[11px] text-muted-foreground/80 bg-muted/40 p-2 rounded border border-border/50">
          {{ t("processList.previewTruncationHint", "💡 说明：在 openGauss / PostgreSQL 中，活动会话的 SQL 记录长度受服务端参数 track_activity_query_size 控制。若语句较长被服务端截断，管理员可通过 ALTER SYSTEM SET track_activity_query_size = 4096;（重启生效）增大记录长度。") }}
        </div>
        <DialogFooter>
          <Button variant="outline" class="gap-1.5" @click="copyPreview">
            <Copy class="h-3.5 w-3.5" />
            {{ t("processList.copy", "复制") }}
          </Button>
          <Button variant="secondary" @click="previewText = null">{{ t("dangerDialog.cancel", "关闭") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
