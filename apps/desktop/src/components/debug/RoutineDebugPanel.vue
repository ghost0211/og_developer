<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from "vue";
import { AlertCircle, Bug, CheckCircle2, CircleDot, Copy, CornerDownRight, CornerUpLeft, ExternalLink, Loader2, Play, RefreshCw, RotateCcw, Search, Square, StepForward, TerminalSquare, Trash2, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { copyToClipboard } from "@/lib/common/clipboard";
import { loadRoutineParameters } from "@/lib/table/routineParameters";
import { buildOpenGaussRoutineDebugCallSql } from "@/lib/table/routineExecutionSql";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import * as api from "@/lib/backend/api";
import type { DatabaseType } from "@/types/database";
import type { OpenGaussDebugBacktraceFrame, OpenGaussDebugBreakpoint, OpenGaussDebugCodeLine, OpenGaussDebugLocal, OpenGaussDebugPosition } from "@/lib/backend/tauri";

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const queryStore = useQueryStore();
const connectionStore = useConnectionStore();

const props = defineProps<{
  tabId?: string;
  connectionId: string;
  database: string;
  databaseType?: DatabaseType;
  schema?: string;
  routineName: string;
  routineKind?: "procedure" | "function";
  signature?: string;
  callSql?: string;
}>();

const emit = defineEmits<{
  close?: [];
}>();

type DebugPhase = "starting" | "running" | "finished" | "error" | "stopped";

// --- State ---
const phase = ref<DebugPhase>("starting");
const errorMessage = ref("");
const sessionId = ref("");
const position = ref<OpenGaussDebugPosition | null>(null);
const code = ref<OpenGaussDebugCodeLine[]>([]);
const locals = ref<OpenGaussDebugLocal[]>([]);
const backtrace = ref<OpenGaussDebugBacktraceFrame[]>([]);
const breakpoints = ref<OpenGaussDebugBreakpoint[]>([]);
const busy = ref(false);
const callResult = ref<string | null>(null);
const serverLogs = ref<{ timestamp: string; level: "info" | "notice" | "warn" | "error" | "step"; text: string }[]>([]);
const resolvedCallSql = ref(props.callSql || "");
const executionDurationMs = ref<number | null>(null);
let startTime = 0;

// Variables filtering & editing
const varSearchQuery = ref("");
const editingLocal = ref<string | null>(null);
const editingLocalValue = ref("");

// Code searching
const codeSearchQuery = ref("");
const codeLineRefs = new Map<number, HTMLElement>();

// Tabs & Splitpanes
const activeTab = ref<"locals" | "backtrace" | "breakpoints" | "output" | "script">("locals");
const splitpanesSize = ref(54);

// Token for cancelling out-of-order session initializations
let sessionToken = 0;

const resolvedDatabaseType = computed(() => props.databaseType ?? (props.connectionId ? effectiveDatabaseTypeForConnection(connectionStore.getConfig(props.connectionId)) : undefined));
const debugTabExists = computed(() => !props.tabId || queryStore.tabs.some((tab) => tab.id === props.tabId));

const targetLabel = computed(() => {
  const prefix = props.schema ? `${props.schema}.` : "";
  return `${prefix}${props.routineName}`;
});

const currentLineno = computed(() => position.value?.lineno ?? null);
const isBusy = computed(() => busy.value || phase.value === "starting");
const breakpointLines = computed<Map<number, OpenGaussDebugBreakpoint>>(() => new Map(breakpoints.value.map((bp: OpenGaussDebugBreakpoint) => [bp.lineno, bp])));

const filteredLocals = computed<OpenGaussDebugLocal[]>(() => {
  const q = varSearchQuery.value.trim().toLowerCase();
  if (!q) return locals.value;
  return locals.value.filter((item: OpenGaussDebugLocal) => item.varname.toLowerCase().includes(q) || (item.vartype && item.vartype.toLowerCase().includes(q)) || (item.value && item.value.toLowerCase().includes(q)) || (item.packageName && item.packageName.toLowerCase().includes(q)));
});

const matchedLineNumbers = computed(() => {
  const q = codeSearchQuery.value.trim().toLowerCase();
  if (!q) return new Set<number>();
  const matched = new Set<number>();
  for (const line of code.value) {
    if (line.query && line.query.toLowerCase().includes(q)) {
      if (line.lineno != null) matched.add(line.lineno);
    }
  }
  return matched;
});

const fontStyle = computed(() => ({
  fontFamily: settingsStore.editorSettings.fontFamily || "var(--font-mono, monospace)",
  fontSize: `${settingsStore.editorSettings.fontSize || 13}px`,
}));

// --- Log Helper ---
function logEvent(level: "info" | "notice" | "warn" | "error" | "step", text: string) {
  const time = new Date().toLocaleTimeString();
  serverLogs.value.push({ timestamp: time, level, text });
}

// --- Debug Session Lifecycle ---
async function startSession() {
  const currentToken = ++sessionToken;
  phase.value = "starting";
  errorMessage.value = "";
  callResult.value = null;
  position.value = null;
  locals.value = [];
  backtrace.value = [];
  breakpoints.value = [];
  serverLogs.value = [];
  executionDurationMs.value = null;

  logEvent("info", `[DEBUG] 初始化 openGauss PL/SQL 调试器: ${targetLabel.value}`);

  try {
    // If callSql wasn't passed in, generate a default one by loading parameters
    let callSqlToUse = resolvedCallSql.value.trim();
    if (!callSqlToUse) {
      logEvent("info", "[DEBUG] 正在读取存储过程/函数参数定义...");
      const loadedParams = await loadRoutineParameters({
        connectionId: props.connectionId,
        database: props.database,
        databaseType: resolvedDatabaseType.value,
        schema: props.schema,
        routineName: props.routineName,
        routineKind: props.routineKind,
        signature: props.signature,
      }).catch(() => []);
      if (currentToken !== sessionToken) return;

      callSqlToUse = buildOpenGaussRoutineDebugCallSql({
        databaseType: resolvedDatabaseType.value,
        schema: props.schema,
        routineName: props.routineName,
        parameters: loadedParams.map((p) => ({
          ...p,
          value: "",
          useNull: false,
          useDefault: !!p.hasDefault,
        })),
      });
      resolvedCallSql.value = callSqlToUse;
    }

    logEvent("info", `[DEBUG] 启动调试目标: ${props.routineName} (${props.routineKind || "procedure"})`);
    startTime = performance.now();

    const started = await api.opengaussDebugStart({
      connectionId: props.connectionId,
      database: props.database,
      schema: props.schema ?? "",
      kind: props.routineKind || "procedure",
      name: props.routineName,
      signature: props.signature,
      callSql: callSqlToUse,
    });
    if (currentToken !== sessionToken || !debugTabExists.value) {
      await api.opengaussDebugStop(started.sessionId).catch(() => undefined);
      return;
    }

    sessionId.value = started.sessionId;
    position.value = started.position;
    code.value = started.code || [];
    breakpoints.value = started.breakpoints || [];
    phase.value = started.position.finished ? "finished" : "running";

    logEvent("info", `[DEBUG] 调试会话已建立 (Session ID: ${started.sessionId})`);
    if (started.position.lineno != null) {
      logEvent("step", `[DEBUG] 停在入口位置: 第 ${started.position.lineno} 行`);
    }

    await refreshState();
    await nextTick();
    scrollToActiveLine(true);
  } catch (error: any) {
    if (currentToken !== sessionToken) return;
    phase.value = "error";
    const msg = error?.message || String(error);
    errorMessage.value = msg;
    logEvent("error", `[ERROR] 调试启动失败: ${msg}`);
  }
}

async function refreshState() {
  if (!sessionId.value) return;
  try {
    const [nextLocals, nextBacktrace, nextBreakpoints] = await Promise.all([
      api.opengaussDebugLocals(sessionId.value).catch(() => [] as OpenGaussDebugLocal[]),
      api.opengaussDebugBacktrace(sessionId.value).catch(() => [] as OpenGaussDebugBacktraceFrame[]),
      api.opengaussDebugBreakpoints(sessionId.value).catch(() => [] as OpenGaussDebugBreakpoint[]),
    ]);
    locals.value = nextLocals;
    backtrace.value = nextBacktrace;
    breakpoints.value = nextBreakpoints;
  } catch (err: any) {
    console.warn("[DBX][Debug] refresh state warning:", err);
  }
}

async function step(action: "next" | "step" | "finish" | "continue") {
  if (!sessionId.value || busy.value || phase.value !== "running") return;
  busy.value = true;
  errorMessage.value = "";

  const actionLabels: Record<string, string> = {
    next: "单步跳过 (Step Over)",
    step: "单步进入 (Step Into)",
    finish: "单步跳出 (Step Out)",
    continue: "继续运行 (Continue)",
  };

  logEvent("step", `[ACTION] 执行 ${actionLabels[action] || action}`);

  try {
    const next = await api.opengaussDebugStep(sessionId.value, action);
    position.value = next;

    if (next.finished) {
      phase.value = "finished";
      if (startTime > 0) {
        executionDurationMs.value = Math.round(performance.now() - startTime);
      }
      logEvent("info", `[DEBUG] 调试执行已结束 (耗时 ${executionDurationMs.value ?? 0}ms)`);
      await fetchCallResult();
      toast(t("plDebug.finished", "调试完成"), 2000);
    } else {
      if (next.lineno != null) {
        logEvent("step", `[PAUSED] 停在第 ${next.lineno} 行: ${next.query || ""}`);
      }
    }

    await refreshState();
    await nextTick();
    scrollToActiveLine();
  } catch (error: any) {
    const msg = error?.message || String(error);
    errorMessage.value = msg;
    logEvent("error", `[ERROR] 调试单步执行出错: ${msg}`);
    toast(msg, 4000);
  } finally {
    busy.value = false;
  }
}

async function fetchCallResult() {
  if (!sessionId.value) return;
  try {
    const res = await api.opengaussDebugCallResult(sessionId.value);
    callResult.value = res;
    if (res) {
      logEvent("notice", `[RESULT] 返回结果: ${res}`);
    }
  } catch (error: any) {
    callResult.value = error?.message || String(error);
  }
}

async function toggleBreakpoint(line: OpenGaussDebugCodeLine) {
  if (!sessionId.value || line.canbreak === false || line.lineno == null) return;
  const existing = breakpointLines.value.get(line.lineno);
  try {
    if (existing) {
      breakpoints.value = await api.opengaussDebugDeleteBreakpoint(sessionId.value, existing.breakpointno);
      logEvent("info", `[BREAKPOINT] 移除断点: 第 ${line.lineno} 行`);
      toast(`已移除第 ${line.lineno} 行断点`, 1000);
    } else {
      breakpoints.value = await api.opengaussDebugAddBreakpoint(sessionId.value, line.lineno);
      logEvent("info", `[BREAKPOINT] 添加断点: 第 ${line.lineno} 行`);
      toast(`已在第 ${line.lineno} 行设置断点`, 1000);
    }
  } catch (error: any) {
    const msg = error?.message || String(error);
    errorMessage.value = msg;
    logEvent("error", `[ERROR] 断点操作失败: ${msg}`);
  }
}

async function setBreakpointEnabled(bp: OpenGaussDebugBreakpoint, enable: boolean) {
  if (!sessionId.value) return;
  try {
    breakpoints.value = await api.opengaussDebugToggleBreakpoint(sessionId.value, bp.breakpointno, enable);
    logEvent("info", `[BREAKPOINT] ${enable ? "启用" : "禁用"}断点: 第 ${bp.lineno} 行`);
  } catch (error: any) {
    errorMessage.value = error?.message || String(error);
  }
}

async function removeBreakpoint(bp: OpenGaussDebugBreakpoint) {
  if (!sessionId.value) return;
  try {
    breakpoints.value = await api.opengaussDebugDeleteBreakpoint(sessionId.value, bp.breakpointno);
    logEvent("info", `[BREAKPOINT] 删除断点: 第 ${bp.lineno} 行`);
    toast(`已删除第 ${bp.lineno} 行断点`, 1000);
  } catch (error: any) {
    errorMessage.value = error?.message || String(error);
  }
}

async function clearAllBreakpoints() {
  if (!sessionId.value || breakpoints.value.length === 0) return;
  const list = [...breakpoints.value];
  try {
    for (const bp of list) {
      await api.opengaussDebugDeleteBreakpoint(sessionId.value, bp.breakpointno).catch(() => undefined);
    }
    breakpoints.value = await api.opengaussDebugBreakpoints(sessionId.value).catch(() => []);
    logEvent("info", "[BREAKPOINT] 已清空所有断点");
    toast("已清空所有断点", 1500);
  } catch (error: any) {
    errorMessage.value = error?.message || String(error);
  }
}

function beginEditLocal(local: OpenGaussDebugLocal) {
  if (local.isconst || phase.value !== "running") return;
  editingLocal.value = local.varname;
  editingLocalValue.value = local.value ?? "";
}

async function commitEditLocal(local: OpenGaussDebugLocal) {
  if (editingLocal.value !== local.varname) return;
  try {
    const ok = await api.opengaussDebugSetVar(sessionId.value, local.varname, editingLocalValue.value);
    if (!ok) {
      const msg = t("plDebug.setVarFailed", { name: local.varname });
      errorMessage.value = msg;
      logEvent("warn", `[WARN] 修改变量值未成功: ${local.varname}`);
      toast(msg, 3000);
    } else {
      logEvent("info", `[VAR] 变量 ${local.varname} 已修改为: ${editingLocalValue.value}`);
      toast(`已更新变量 ${local.varname}`, 1500);
    }
    locals.value = await api.opengaussDebugLocals(sessionId.value).catch(() => locals.value);
  } catch (error: any) {
    const msg = error?.message || String(error);
    errorMessage.value = msg;
    logEvent("error", `[ERROR] 修改变量异常: ${msg}`);
  } finally {
    editingLocal.value = null;
  }
}

function cancelEditLocal() {
  editingLocal.value = null;
}

async function stopSession() {
  const id = sessionId.value;
  sessionId.value = "";
  phase.value = "stopped";
  logEvent("info", "[DEBUG] 调试会话已终止");
  if (id) {
    await api.opengaussDebugStop(id).catch(() => undefined);
  }
}

function attachKeyboardShortcuts() {
  window.addEventListener("keydown", handleKeydown);
}

function detachKeyboardShortcuts() {
  window.removeEventListener("keydown", handleKeydown);
}

async function restartSession() {
  await stopSession();
  await startSession();
}

function scrollToActiveLine(instant = false) {
  const lineNo = currentLineno.value;
  if (lineNo == null) return;
  const el = codeLineRefs.get(lineNo);
  if (el) {
    el.scrollIntoView({
      block: "center",
      behavior: instant ? "auto" : "smooth",
    });
  }
}

function jumpToLine(lineNo: number | null | undefined) {
  if (lineNo == null) return;
  const el = codeLineRefs.get(lineNo);
  if (el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function registerLineRef(lineNo: number | null | undefined, el: any) {
  if (lineNo != null) {
    if (el) {
      codeLineRefs.set(lineNo, el as HTMLElement);
    } else {
      codeLineRefs.delete(lineNo);
    }
  }
}

function openInSqlEditor() {
  const sql = resolvedCallSql.value.trim();
  if (!sql) return;
  const tabId = queryStore.createTab(props.connectionId, props.database, `Debug Script - ${props.routineName}`, "query", props.schema);
  queryStore.updateSql(tabId, sql);
}

async function copySourceCode() {
  const text = code.value.map((l) => `${l.lineno ? `${l.lineno}\t` : ""}${l.query || ""}`).join("\n");
  if (!text) return;
  await copyToClipboard(text);
  toast(t("common.copied", "已复制"), 1500);
}

async function copyCallScript() {
  if (!resolvedCallSql.value) return;
  await copyToClipboard(resolvedCallSql.value);
  toast(t("common.copied", "已复制"), 1500);
}

async function copyServerLogs() {
  const text = serverLogs.value.map((l) => `[${l.timestamp}] ${l.text}`).join("\n");
  if (!text) return;
  await copyToClipboard(text);
  toast(t("common.copied", "已复制"), 1500);
}

function clearLogs() {
  serverLogs.value = [];
}

// --- Syntax Highlighting Helpers ---
const PLSQL_KEYWORDS = new Set([
  "DECLARE",
  "BEGIN",
  "END",
  "IF",
  "THEN",
  "ELSE",
  "ELSIF",
  "LOOP",
  "WHILE",
  "FOR",
  "IN",
  "REVERSE",
  "RETURN",
  "EXIT",
  "CONTINUE",
  "WHEN",
  "CASE",
  "EXCEPTION",
  "RAISE",
  "NOTICE",
  "WARNING",
  "INFO",
  "LOG",
  "SELECT",
  "INTO",
  "INSERT",
  "UPDATE",
  "DELETE",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IS",
  "NULL",
  "TRUE",
  "FALSE",
  "CURSOR",
  "OPEN",
  "FETCH",
  "CLOSE",
  "EXECUTE",
  "IMMEDIATE",
  "PERFORM",
  "CALL",
  "FUNCTION",
  "PROCEDURE",
  "PACKAGE",
  "BODY",
  "AS",
  "IS",
  "CREATE",
  "REPLACE",
  "ALTER",
  "DROP",
  "GRANT",
  "REVOKE",
  "COMMIT",
  "ROLLBACK",
  "PRAGMA",
  "EXCEPTION_INIT",
  "OTHERS",
  "SQLCODE",
  "SQLERRM",
  "STRICT",
  "RETURNING",
  "BULK",
  "COLLECT",
  "USING",
]);

const PLSQL_TYPES = new Set([
  "VARCHAR",
  "VARCHAR2",
  "NVARCHAR2",
  "CHAR",
  "NCHAR",
  "NUMBER",
  "NUMERIC",
  "INTEGER",
  "INT",
  "BIGINT",
  "SMALLINT",
  "FLOAT",
  "DOUBLE",
  "PRECISION",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP",
  "TIME",
  "INTERVAL",
  "CLOB",
  "BLOB",
  "TEXT",
  "BYTEA",
  "RAW",
  "RECORD",
  "TABLE",
  "TYPE",
  "ROWTYPE",
  "OID",
  "DECIMAL",
  "REAL",
  "SERIAL",
  "BIGSERIAL",
  "JSON",
  "JSONB",
]);

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatPlSqlLine(raw: string): string {
  if (!raw) return "&nbsp;";
  const trimmed = raw.trimStart();

  // Full line comment
  if (trimmed.startsWith("--")) {
    return `<span class="text-muted-foreground/60 italic">${escapeHtml(raw)}</span>`;
  }

  // Tokenize line
  let result = "";
  let i = 0;
  while (i < raw.length) {
    // String literal
    if (raw[i] === "'") {
      let str = "'";
      i++;
      while (i < raw.length) {
        if (raw[i] === "'") {
          str += "'";
          i++;
          if (raw[i] === "'") {
            str += "'";
            i++;
          } else {
            break;
          }
        } else {
          str += raw[i];
          i++;
        }
      }
      result += `<span class="text-emerald-600 dark:text-emerald-400 font-medium">${escapeHtml(str)}</span>`;
      continue;
    }

    // Inline comment
    if (raw[i] === "-" && raw[i + 1] === "-") {
      const rest = raw.slice(i);
      result += `<span class="text-muted-foreground/60 italic">${escapeHtml(rest)}</span>`;
      break;
    }

    // Word (Identifier / Keyword / Type)
    if (/[a-zA-Z_#$]/.test(raw[i])) {
      let word = "";
      while (i < raw.length && /[a-zA-Z0-9_#$]/.test(raw[i])) {
        word += raw[i];
        i++;
      }
      const upper = word.toUpperCase();
      if (PLSQL_KEYWORDS.has(upper)) {
        result += `<span class="text-blue-600 dark:text-sky-400 font-bold">${escapeHtml(word)}</span>`;
      } else if (PLSQL_TYPES.has(upper)) {
        result += `<span class="text-amber-600 dark:text-amber-400 font-semibold">${escapeHtml(word)}</span>`;
      } else {
        result += escapeHtml(word);
      }
      continue;
    }

    // Numbers
    if (/[0-9]/.test(raw[i])) {
      let num = "";
      while (i < raw.length && /[0-9.]/.test(raw[i])) {
        num += raw[i];
        i++;
      }
      result += `<span class="text-purple-600 dark:text-purple-400">${escapeHtml(num)}</span>`;
      continue;
    }

    // Default char
    result += escapeHtml(raw[i]);
    i++;
  }

  return result;
}

// --- Keyboard Shortcuts ---
function handleKeydown(event: KeyboardEvent) {
  // If editing a variable inline, let Enter/Esc handle it
  if (editingLocal.value) return;

  // F7: Step Into
  if (event.key === "F7" && !event.shiftKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    void step("step");
    return;
  }
  // Shift + F7: Step Out
  if (event.key === "F7" && event.shiftKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    void step("finish");
    return;
  }
  // F8: Step Over
  if (event.key === "F8" && !event.shiftKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    void step("next");
    return;
  }
  // F9: Continue / Run
  if (event.key === "F9" && !event.shiftKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    void step("continue");
    return;
  }
  // Ctrl + U or Escape: Stop Debugging
  if ((event.ctrlKey && event.key.toLowerCase() === "u") || event.key === "Escape") {
    if (phase.value === "running" || phase.value === "starting") {
      event.preventDefault();
      void stopSession();
    }
  }
}

watch(debugTabExists, (exists) => {
  if (!exists) {
    sessionToken++;
    void stopSession();
  }
});

onMounted(() => {
  attachKeyboardShortcuts();
  void startSession();
});

onActivated(attachKeyboardShortcuts);
onDeactivated(detachKeyboardShortcuts);

onUnmounted(() => {
  sessionToken++;
  detachKeyboardShortcuts();
  if (sessionId.value) {
    void api.opengaussDebugStop(sessionId.value).catch(() => undefined);
  }
});
</script>

<template>
  <div class="flex h-full w-full flex-col min-h-0 bg-background text-foreground select-text">
    <!-- PL/SQL Developer Style Main Debugger Toolbar -->
    <div class="flex flex-wrap items-center justify-between border-b bg-muted/40 px-3 py-1 text-xs shrink-0 select-none gap-2">
      <!-- Action Command Buttons -->
      <div class="flex items-center gap-1">
        <!-- Continue / Run -->
        <Button size="sm" class="h-7 gap-1.5 px-3 font-medium shadow-sm bg-emerald-600 hover:bg-emerald-700 text-white dark:bg-emerald-600 dark:hover:bg-emerald-500" :disabled="isBusy || phase !== 'running'" :title="t('plDebug.continue', '继续执行 (F9)')" @click="step('continue')">
          <Play class="h-3.5 w-3.5 fill-current" />
          <span>{{ t("plDebug.continue", "继续") }}</span>
          <kbd class="ml-1 rounded bg-black/20 px-1 py-0.2 text-[10px] text-white font-mono">F9</kbd>
        </Button>

        <!-- Step Over -->
        <Button size="sm" variant="outline" class="h-7 gap-1.5 px-2.5 font-medium hover:bg-muted" :disabled="isBusy || phase !== 'running'" :title="t('plDebug.next', '单步跳过 (F8)')" @click="step('next')">
          <StepForward class="h-3.5 w-3.5 text-blue-500" />
          <span>{{ t("plDebug.next", "单步跳过") }}</span>
          <kbd class="ml-1 rounded bg-muted-foreground/15 px-1 py-0.2 text-[10px] text-muted-foreground font-mono">F8</kbd>
        </Button>

        <!-- Step Into -->
        <Button size="sm" variant="outline" class="h-7 gap-1.5 px-2.5 font-medium hover:bg-muted" :disabled="isBusy || phase !== 'running'" :title="t('plDebug.step', '单步进入 (F7)')" @click="step('step')">
          <CornerDownRight class="h-3.5 w-3.5 text-indigo-500" />
          <span>{{ t("plDebug.step", "单步进入") }}</span>
          <kbd class="ml-1 rounded bg-muted-foreground/15 px-1 py-0.2 text-[10px] text-muted-foreground font-mono">F7</kbd>
        </Button>

        <!-- Step Out -->
        <Button size="sm" variant="outline" class="h-7 gap-1.5 px-2.5 font-medium hover:bg-muted" :disabled="isBusy || phase !== 'running'" :title="t('plDebug.finish', '单步跳出 (Shift+F7)')" @click="step('finish')">
          <CornerUpLeft class="h-3.5 w-3.5 text-purple-500" />
          <span>{{ t("plDebug.finish", "单步跳出") }}</span>
          <kbd class="ml-1 rounded bg-muted-foreground/15 px-1 py-0.2 text-[9px] text-muted-foreground font-mono">⇧F7</kbd>
        </Button>

        <div class="mx-1 h-4 w-px bg-border" />

        <!-- Refresh -->
        <Button size="sm" variant="ghost" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :disabled="isBusy" :title="t('plDebug.refresh', '刷新变量与堆栈')" @click="refreshState">
          <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': busy }" />
          <span>{{ t("plDebug.refresh", "刷新") }}</span>
        </Button>

        <!-- Restart -->
        <Button size="sm" variant="ghost" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :disabled="busy" :title="t('contextMenu.restartDebug', '重新开始调试')" @click="restartSession">
          <RotateCcw class="h-3.5 w-3.5 text-amber-500" />
          <span>重新调试</span>
        </Button>

        <!-- Stop -->
        <Button size="sm" variant="destructive" class="h-7 gap-1 px-2.5 shadow-sm" :disabled="!sessionId" :title="t('plDebug.stop', '终止调试 (Ctrl+U)')" @click="stopSession">
          <Square class="h-3 w-3 fill-current" />
          <span>{{ t("plDebug.stop", "停止调试") }}</span>
        </Button>
      </div>

      <!-- Session & Target Status Info -->
      <div class="flex items-center gap-3">
        <!-- Status Indicator Badge -->
        <div class="flex items-center gap-2">
          <Badge v-if="phase === 'starting'" variant="outline" class="gap-1.5 border-amber-500/40 text-amber-600 dark:text-amber-400">
            <Loader2 class="h-3 w-3 animate-spin" />
            <span>{{ t("plDebug.starting", "正在启动...") }}</span>
          </Badge>

          <Badge v-else-if="phase === 'running'" variant="outline" class="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-mono">
            <CircleDot class="h-3 w-3 animate-pulse text-emerald-500" />
            <span v-if="currentLineno != null">第 {{ currentLineno }} 行</span>
            <span v-else>{{ t("plDebug.running", "调试中") }}</span>
          </Badge>

          <Badge v-else-if="phase === 'finished'" variant="secondary" class="gap-1.5 bg-muted text-foreground">
            <CheckCircle2 class="h-3 w-3 text-emerald-500" />
            <span>{{ t("plDebug.finished", "执行完成") }}</span>
            <span v-if="executionDurationMs" class="font-mono text-muted-foreground text-[10px]">({{ executionDurationMs }}ms)</span>
          </Badge>

          <Badge v-else-if="phase === 'error'" variant="destructive" class="gap-1.5">
            <AlertCircle class="h-3 w-3" />
            <span>{{ t("plDebug.error", "错误") }}</span>
          </Badge>

          <Badge v-else-if="phase === 'stopped'" variant="outline" class="text-muted-foreground">
            <span>调试已终止</span>
          </Badge>
        </div>

        <!-- Target Routine Object Badge -->
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground font-mono bg-muted/60 px-2 py-0.5 rounded border border-border/50">
          <Bug class="h-3 w-3 text-amber-500 shrink-0" />
          <span class="truncate max-w-[220px]" :title="targetLabel">{{ targetLabel }}</span>
        </div>

        <!-- Quick actions -->
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :title="t('contextMenu.openInSqlEditor', '在 SQL 编辑器中打开脚本')" @click="openInSqlEditor">
            <ExternalLink class="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :title="t('common.copy', '复制代码')" @click="copySourceCode">
            <Copy class="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>

    <!-- Error Banner (if any) -->
    <div v-if="errorMessage" class="flex items-center justify-between border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
      <div class="flex items-center gap-2 font-mono truncate">
        <AlertCircle class="h-4 w-4 shrink-0" />
        <span class="truncate">{{ errorMessage }}</span>
      </div>
      <Button variant="ghost" size="sm" class="h-6 w-6 p-0 text-destructive hover:bg-destructive/20" @click="errorMessage = ''">
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>

    <!-- Splitpanes Layout: Top Code Tracing, Bottom Inspector Tabs -->
    <div class="flex-1 min-h-0 relative">
      <Splitpanes horizontal class="test-window-splitpanes h-full w-full" @resized="splitpanesSize = $event.panes?.[0]?.size ?? 54">
        <!-- Upper Pane: Source Code Tracing & Gutter -->
        <Pane :size="splitpanesSize" min-size="20" class="flex flex-col min-h-0 bg-background">
          <!-- Code View Subheader -->
          <div class="flex items-center justify-between border-b bg-muted/25 px-3 py-1 text-[11px] font-medium text-muted-foreground shrink-0 select-none">
            <div class="flex items-center gap-2">
              <TerminalSquare class="h-3.5 w-3.5 text-primary" />
              <span class="font-mono text-foreground font-semibold">{{ targetLabel }}</span>
              <span class="text-muted-foreground text-[10px]">({{ code.length }} lines)</span>
            </div>

            <!-- Code Search Input -->
            <div class="flex items-center gap-2">
              <div class="relative w-48">
                <Search class="absolute left-2 top-1.5 h-3 w-3 text-muted-foreground/60 pointer-events-none" />
                <input v-model="codeSearchQuery" type="text" placeholder="在代码中搜索..." class="h-6 w-full rounded border border-border/80 bg-background pl-6 pr-2 text-[11px] font-mono outline-none focus:border-ring placeholder:text-muted-foreground/50" />
              </div>
              <span v-if="codeSearchQuery && matchedLineNumbers.size > 0" class="text-[10px] font-mono text-muted-foreground"> {{ matchedLineNumbers.size }} 行匹配 </span>
            </div>
          </div>

          <!-- Code View Lines Container -->
          <div class="flex-1 min-h-0 overflow-auto bg-background/50 font-mono" :style="fontStyle">
            <div v-if="phase === 'starting' && code.length === 0" class="flex h-full items-center justify-center p-8 text-xs text-muted-foreground gap-2 select-none">
              <Loader2 class="h-4 w-4 animate-spin text-primary" />
              <span>{{ t("plDebug.starting", "正在加载存储过程源码与断点...") }}</span>
            </div>

            <div v-else-if="code.length === 0" class="flex h-full items-center justify-center p-8 text-xs text-muted-foreground italic select-none">
              <span>无源代码行或已结束</span>
            </div>

            <div v-else class="py-1 min-w-max">
              <div
                v-for="(line, idx) in code"
                :key="idx"
                :ref="(el) => registerLineRef(line.lineno, el)"
                class="group flex items-stretch leading-6 transition-colors select-text hover:bg-muted/30"
                :class="[
                  line.lineno != null && line.lineno === currentLineno && phase === 'running' ? 'bg-amber-500/20 dark:bg-amber-400/25 border-y border-amber-500/40 text-foreground font-semibold' : breakpointLines.has(line.lineno ?? -1) ? 'bg-destructive/5' : '',
                  line.lineno != null && matchedLineNumbers.has(line.lineno) ? 'bg-primary/10' : '',
                ]"
              >
                <!-- Breakpoint Gutter (Clickable) -->
                <div
                  class="w-7 shrink-0 flex items-center justify-center select-none"
                  :class="line.canbreak !== false && line.lineno != null ? 'cursor-pointer' : 'cursor-default'"
                  :title="line.canbreak !== false && line.lineno != null ? (breakpointLines.has(line.lineno) ? '点击移除断点' : '点击设置断点') : ''"
                  @click="toggleBreakpoint(line)"
                >
                  <!-- Active Enabled Breakpoint: Solid Red Circle -->
                  <span v-if="breakpointLines.get(line.lineno ?? -1)?.enable" class="h-3 w-3 rounded-full bg-red-500 ring-2 ring-red-500/30 shadow-sm" />
                  <!-- Disabled Breakpoint: Hollow Circle -->
                  <span v-else-if="breakpointLines.has(line.lineno ?? -1)" class="h-3 w-3 rounded-full border-2 border-red-500 bg-background" />
                  <!-- Breakable hover ghost circle -->
                  <span v-else-if="line.canbreak !== false && line.lineno != null" class="h-2.5 w-2.5 rounded-full border border-transparent group-hover:border-red-400/60 group-hover:bg-red-400/20 transition-all" />
                </div>

                <!-- Execution Pointer Arrow (▶) -->
                <div class="w-5 shrink-0 flex items-center justify-center select-none font-bold text-xs">
                  <span v-if="line.lineno != null && line.lineno === currentLineno && phase === 'running'" class="text-amber-500 animate-pulse"> ▶ </span>
                </div>

                <!-- Line Number -->
                <div class="w-12 shrink-0 border-r border-border/40 pr-2.5 text-right text-muted-foreground/60 select-none text-[11px]" :class="{ '!text-amber-600 dark:!text-amber-400 font-bold': line.lineno != null && line.lineno === currentLineno }">
                  {{ line.lineno ?? "" }}
                </div>

                <!-- Code Text (PL/SQL Syntax Colored) -->
                <div class="flex-1 px-3 whitespace-pre font-mono text-[12px]" :class="{ 'text-muted-foreground/70': line.canbreak === false }" v-html="formatPlSqlLine(line.query)" />
              </div>
            </div>
          </div>
        </Pane>

        <!-- Lower Pane: Inspector Tabs (PL/SQL Developer Tabs) -->
        <Pane :size="100 - splitpanesSize" min-size="25" class="flex flex-col min-h-0 border-t bg-background">
          <Tabs v-model="activeTab" class="flex h-full flex-col min-h-0">
            <!-- Tabs Navigation Bar -->
            <div class="flex items-center justify-between border-b bg-muted/30 px-3 shrink-0 select-none">
              <TabsList class="h-8 bg-transparent p-0 gap-1">
                <!-- Variables / Locals -->
                <TabsTrigger value="locals" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>{{ t("plDebug.locals", "变量 (Locals)") }}</span>
                  <span v-if="locals.length" class="ml-1.5 rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">
                    {{ locals.length }}
                  </span>
                </TabsTrigger>

                <!-- Call Stack / Backtrace -->
                <TabsTrigger value="backtrace" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>{{ t("plDebug.backtrace", "调用栈 (Call Stack)") }}</span>
                  <span v-if="backtrace.length" class="ml-1.5 rounded-full bg-primary/10 text-primary px-1.5 py-0.2 text-[10px] font-mono font-medium">
                    {{ backtrace.length }}
                  </span>
                </TabsTrigger>

                <!-- Breakpoints -->
                <TabsTrigger value="breakpoints" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>{{ t("plDebug.breakpoints", "断点 (Breakpoints)") }}</span>
                  <span v-if="breakpoints.length" class="ml-1.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400 px-1.5 py-0.2 text-[10px] font-mono font-medium">
                    {{ breakpoints.length }}
                  </span>
                </TabsTrigger>

                <!-- DBMS / Server Logs -->
                <TabsTrigger value="output" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>DBMS / 调试输出</span>
                  <span v-if="serverLogs.length" class="ml-1.5 rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">
                    {{ serverLogs.length }}
                  </span>
                </TabsTrigger>

                <!-- Call Script & Result -->
                <TabsTrigger value="script" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>调用脚本与结果</span>
                  <span v-if="callResult" class="ml-1.5 rounded-full bg-emerald-500/10 text-emerald-600 px-1.5 py-0.2 text-[10px] font-mono"> Result </span>
                </TabsTrigger>
              </TabsList>

              <!-- Tab Right Side Quick Info -->
              <div class="flex items-center gap-2 text-[11px] text-muted-foreground font-mono">
                <span v-if="sessionId" class="text-[10px] text-muted-foreground/70">Session: {{ sessionId }}</span>
              </div>
            </div>

            <!-- Tab Content: Variables / Locals Grid -->
            <TabsContent value="locals" class="m-0 flex-1 min-h-0 overflow-y-auto p-0">
              <!-- Variables Filter Bar -->
              <div class="flex items-center justify-between border-b bg-muted/15 px-3 py-1 text-xs shrink-0">
                <div class="relative w-56">
                  <Search class="absolute left-2 top-1.5 h-3 w-3 text-muted-foreground/60 pointer-events-none" />
                  <input v-model="varSearchQuery" type="text" placeholder="过滤变量名 / 类型 / 值..." class="h-6 w-full rounded border border-border bg-background pl-6 pr-2 text-xs font-mono outline-none focus:border-ring placeholder:text-muted-foreground/50" />
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-[11px] text-muted-foreground">双击数值单元格可直接修改</span>
                  <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs text-muted-foreground" :disabled="isBusy" @click="refreshState">
                    <RefreshCw class="h-3 w-3" />
                    <span>刷新</span>
                  </Button>
                </div>
              </div>

              <div v-if="locals.length === 0" class="flex h-32 items-center justify-center text-xs text-muted-foreground italic">
                {{ t("plDebug.noLocals", "当前执行上下文暂无局部变量") }}
              </div>

              <div v-else class="w-full">
                <table class="w-full text-left text-xs border-collapse font-sans">
                  <thead class="sticky top-0 bg-muted/90 backdrop-blur z-10 border-b text-muted-foreground font-medium select-none">
                    <tr>
                      <th class="py-1.5 px-3 w-[40px] text-center">#</th>
                      <th class="py-1.5 px-3 w-[180px]">变量名 (Variable)</th>
                      <th class="py-1.5 px-3 w-[140px]">类型 (Type)</th>
                      <th class="py-1.5 px-3 w-[140px]">包 / 作用域 (Scope)</th>
                      <th class="py-1.5 px-3">当前值 (Value)</th>
                      <th class="py-1.5 px-3 w-[80px] text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y font-mono">
                    <tr v-for="(local, vIdx) in filteredLocals" :key="local.varname" class="hover:bg-muted/40 transition-colors" :class="{ 'bg-muted/20': editingLocal === local.varname }">
                      <td class="py-1.5 px-3 text-center text-muted-foreground/60 text-[10px] select-none">
                        {{ vIdx + 1 }}
                      </td>
                      <td class="py-1.5 px-3 font-semibold text-foreground truncate" :title="local.varname">
                        <div class="flex items-center gap-1.5">
                          <span>{{ local.varname }}</span>
                          <Badge v-if="local.isconst" variant="outline" class="text-[9px] px-1 py-0 border-amber-500/40 text-amber-600 dark:text-amber-400"> CONST </Badge>
                        </div>
                      </td>
                      <td class="py-1.5 px-3 text-muted-foreground truncate" :title="local.vartype">
                        <span class="bg-muted px-1.5 py-0.5 rounded text-[11px]">
                          {{ local.vartype || "unknown" }}
                        </span>
                      </td>
                      <td class="py-1.5 px-3 text-muted-foreground truncate text-[11px]">
                        {{ local.packageName || "local" }}
                      </td>
                      <td class="py-1 px-3">
                        <!-- Inline Edit Mode -->
                        <div v-if="editingLocal === local.varname" class="flex items-center gap-1">
                          <input v-model="editingLocalValue" class="h-6 w-full max-w-[280px] rounded border border-ring bg-background px-1.5 font-mono text-xs outline-none shadow-sm" autofocus @keydown.enter.prevent="commitEditLocal(local)" @keydown.esc.prevent="cancelEditLocal" />
                          <Button size="sm" class="h-6 px-2 text-[11px] bg-primary" @click="commitEditLocal(local)"> 保存 </Button>
                          <Button size="sm" variant="ghost" class="h-6 px-2 text-[11px]" @click="cancelEditLocal"> 取消 </Button>
                        </div>

                        <!-- Read / Display Mode -->
                        <div v-else class="cursor-pointer hover:underline inline-block max-w-[400px] truncate" :title="local.isconst ? '常量不可修改' : '双击修改变量值'" @dblclick="beginEditLocal(local)">
                          <span v-if="local.value === null || local.value === undefined" class="text-muted-foreground/50 italic"> NULL </span>
                          <span v-else-if="local.value === ''" class="text-muted-foreground/50 italic"> '' (empty string) </span>
                          <span v-else class="text-foreground font-medium">
                            {{ local.value }}
                          </span>
                        </div>
                      </td>
                      <td class="py-1 px-3 text-center">
                        <Button v-if="!local.isconst && phase === 'running' && editingLocal !== local.varname" variant="ghost" size="sm" class="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground" @click="beginEditLocal(local)"> 修改 </Button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </TabsContent>

            <!-- Tab Content: Call Stack / Backtrace -->
            <TabsContent value="backtrace" class="m-0 flex-1 min-h-0 overflow-y-auto p-0">
              <div v-if="backtrace.length === 0" class="flex h-32 items-center justify-center text-xs text-muted-foreground italic">
                {{ t("plDebug.backtrace", "无调用栈数据") }}
              </div>

              <div v-else class="w-full">
                <table class="w-full text-left text-xs border-collapse font-sans">
                  <thead class="sticky top-0 bg-muted/90 backdrop-blur z-10 border-b text-muted-foreground font-medium select-none">
                    <tr>
                      <th class="py-1.5 px-3 w-[60px]">Frame</th>
                      <th class="py-1.5 px-3 w-[220px]">函数 / 过程 (Function)</th>
                      <th class="py-1.5 px-3 w-[90px]">行号 (Line)</th>
                      <th class="py-1.5 px-3">调用语句 (Statement)</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y font-mono">
                    <tr v-for="frame in backtrace" :key="frame.frameno" class="hover:bg-muted/40 transition-colors cursor-pointer" @click="jumpToLine(frame.lineno)">
                      <td class="py-1.5 px-3 font-semibold text-primary">#{{ frame.frameno }}</td>
                      <td class="py-1.5 px-3 font-medium text-foreground truncate" :title="frame.funcname">
                        {{ frame.funcname }}
                      </td>
                      <td class="py-1.5 px-3 text-muted-foreground">
                        <span v-if="frame.lineno != null" class="underline decoration-dotted"> L{{ frame.lineno }} </span>
                        <span v-else>-</span>
                      </td>
                      <td class="py-1.5 px-3 text-muted-foreground truncate max-w-[450px]" :title="frame.query">
                        {{ frame.query }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </TabsContent>

            <!-- Tab Content: Breakpoints Management -->
            <TabsContent value="breakpoints" class="m-0 flex-1 min-h-0 overflow-y-auto p-0">
              <div class="flex items-center justify-between border-b bg-muted/15 px-3 py-1 text-xs shrink-0">
                <span class="text-muted-foreground text-[11px]">共 {{ breakpoints.length }} 个断点 (点击行号可在代码中定位)</span>
                <Button v-if="breakpoints.length > 0" variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs text-destructive hover:bg-destructive/10" @click="clearAllBreakpoints">
                  <Trash2 class="h-3 w-3" />
                  <span>清空所有断点</span>
                </Button>
              </div>

              <div v-if="breakpoints.length === 0" class="flex h-32 items-center justify-center text-xs text-muted-foreground italic">
                {{ t("plDebug.noBreakpoints", "点击代码行号左侧可设置断点") }}
              </div>

              <div v-else class="w-full">
                <table class="w-full text-left text-xs border-collapse font-sans">
                  <thead class="sticky top-0 bg-muted/90 backdrop-blur z-10 border-b text-muted-foreground font-medium select-none">
                    <tr>
                      <th class="py-1.5 px-3 w-[60px] text-center">启用</th>
                      <th class="py-1.5 px-3 w-[80px]">行号</th>
                      <th class="py-1.5 px-3">代码 (Statement)</th>
                      <th class="py-1.5 px-3 w-[70px] text-center">删除</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y font-mono">
                    <tr v-for="bp in breakpoints" :key="bp.breakpointno" class="hover:bg-muted/40 transition-colors">
                      <td class="py-1.5 px-3 text-center">
                        <input type="checkbox" class="h-3.5 w-3.5 accent-primary cursor-pointer" :checked="bp.enable" @change="(e: Event) => setBreakpointEnabled(bp, (e.target as HTMLInputElement).checked)" />
                      </td>
                      <td class="py-1.5 px-3">
                        <button type="button" class="font-semibold text-primary hover:underline" @click="jumpToLine(bp.lineno)">第 {{ bp.lineno }} 行</button>
                      </td>
                      <td class="py-1.5 px-3 text-foreground truncate max-w-[500px]" :title="bp.query">
                        {{ bp.query }}
                      </td>
                      <td class="py-1.5 px-3 text-center">
                        <button type="button" class="text-muted-foreground hover:text-destructive p-1 rounded transition-colors" :title="t('common.delete', '删除断点')" @click="removeBreakpoint(bp)">
                          <Trash2 class="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </TabsContent>

            <!-- Tab Content: Server Output / Console & Notice -->
            <TabsContent value="output" class="m-0 flex-1 min-h-0 flex flex-col bg-muted/10">
              <div class="flex items-center justify-between border-b bg-muted/20 px-3 py-1 text-xs shrink-0">
                <span class="text-muted-foreground text-[11px]">调试执行日志与 Notice 输出</span>
                <div class="flex items-center gap-2">
                  <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs text-muted-foreground" @click="copyServerLogs">
                    <Copy class="h-3 w-3" />
                    <span>复制日志</span>
                  </Button>
                  <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs text-muted-foreground" @click="clearLogs">
                    <Trash2 class="h-3 w-3" />
                    <span>清空</span>
                  </Button>
                </div>
              </div>

              <div class="flex-1 min-h-0 overflow-y-auto p-3 font-mono text-xs space-y-1">
                <div v-if="serverLogs.length === 0" class="flex h-full items-center justify-center text-muted-foreground/60 italic">暂无调试输出日志</div>
                <div v-for="(log, idx) in serverLogs" :key="idx" class="leading-relaxed break-all">
                  <span class="text-muted-foreground/60 mr-2 select-none">[{{ log.timestamp }}]</span>
                  <span v-if="log.level === 'error'" class="text-destructive font-semibold">{{ log.text }}</span>
                  <span v-else-if="log.level === 'step'" class="text-sky-600 dark:text-sky-400 font-medium">{{ log.text }}</span>
                  <span v-else-if="log.level === 'notice'" class="text-emerald-600 dark:text-emerald-400 font-medium">{{ log.text }}</span>
                  <span v-else-if="log.level === 'warn'" class="text-amber-500">{{ log.text }}</span>
                  <span v-else class="text-foreground">{{ log.text }}</span>
                </div>
              </div>
            </TabsContent>

            <!-- Tab Content: Call Script & Result -->
            <TabsContent value="script" class="m-0 flex-1 min-h-0 overflow-y-auto p-3 space-y-3 font-mono text-xs">
              <!-- Finished Call Result Banner -->
              <div v-if="callResult" class="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
                <div class="flex items-center gap-2 font-sans font-semibold text-emerald-600 dark:text-emerald-400 text-xs mb-1.5">
                  <CheckCircle2 class="h-4 w-4" />
                  <span>执行返回结果 (Call Result)</span>
                </div>
                <pre class="whitespace-pre-wrap break-all text-xs font-mono text-foreground">{{ callResult }}</pre>
              </div>

              <!-- Invocation PL/SQL Block Script -->
              <div class="rounded-md border bg-muted/20 p-3 space-y-2">
                <div class="flex items-center justify-between font-sans text-xs text-muted-foreground">
                  <span class="font-semibold">调试调用块 (PL/SQL Block)</span>
                  <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs" @click="copyCallScript">
                    <Copy class="h-3 w-3" />
                    <span>复制代码</span>
                  </Button>
                </div>
                <pre class="overflow-auto max-h-48 whitespace-pre p-2 rounded bg-background border text-xs leading-relaxed">{{ resolvedCallSql || "-- 自动生成的调试调用块" }}</pre>
              </div>
            </TabsContent>
          </Tabs>
        </Pane>
      </Splitpanes>
    </div>
  </div>
</template>

<style scoped>
.test-window-splitpanes :deep(.splitpanes--horizontal > .splitpanes__splitter) {
  height: 6px;
  background-color: var(--border);
  position: relative;
  transition: background-color 0.15s ease;
}

.test-window-splitpanes :deep(.splitpanes--horizontal > .splitpanes__splitter:hover) {
  background-color: var(--ring);
}
</style>
