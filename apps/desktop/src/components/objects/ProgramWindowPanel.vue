<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertCircle, Bug, CheckCircle2, Code2, Copy, ExternalLink, FileCode, GitCompare, Loader2, Package, Play, RefreshCw, RotateCcw, Sparkles, TerminalSquare, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import QueryEditor from "@/components/editor/QueryEditor.vue";

import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatSqlForDisplay, sqlFormatDialectForDbType, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import { codeMirrorSqlDialect, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { buildEditableObjectSource, buildExecutableObjectSourceStatements, executeObjectSourceSave, formatObjectSourceSaveError } from "@/lib/table/objectSourceEditor";
import { loadObjectSourceWithRoutineFallback } from "@/lib/table/objectSourceLoad";
import { parseSqlErrorLocation, type SqlErrorLocation } from "@/lib/sql/sqlDiagnostics";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import * as api from "@/lib/backend/api";
import type { DatabaseType, ObjectSourceKind } from "@/types/database";

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
  catalog?: string;
  schema?: string;
  name: string;
  objectType: ObjectSourceKind;
  signature?: string;
  relationName?: string;
}>();

const emit = defineEmits<{
  saved: [];
}>();

// --- State ---
const loading = ref(false);
const saving = ref(false);
const formatting = ref(false);
const loadError = ref("");
const compileSuccessMessage = ref("");
const compileDurationMs = ref<number | null>(null);

// Source & Draft States
const originalSource = ref("");
const draftSource = ref("");
const sourceEditable = ref(true);
const resolvedObjectType = ref<ObjectSourceKind>(props.objectType);

// Package Dual-Tab Support (Spec & Body)
const isPackage = computed(() => props.objectType === "PACKAGE" || props.objectType === "PACKAGE_BODY" || resolvedObjectType.value === "PACKAGE" || resolvedObjectType.value === "PACKAGE_BODY");
const activePackagePart = ref<"spec" | "body">(props.objectType === "PACKAGE_BODY" ? "body" : "spec");
const packageSpecSource = ref("");
const packageSpecDraft = ref("");
const packageBodySource = ref("");
const packageBodyDraft = ref("");

// Bottom Splitpanes & Compilation Panel
const showBottomPanel = ref(false);
const bottomTab = ref<"errors" | "logs" | "diff">("errors");
const splitpanesSize = ref(70);

// Parsed Errors
interface ParsedCompileError {
  line: number; // 1-based
  column?: number;
  message: string;
  raw: string;
}
const compileErrors = ref<ParsedCompileError[]>([]);
const compileLogs = ref<{ timestamp: string; level: "info" | "success" | "error"; text: string }[]>([]);

// Editor state
let loadSerial = 0;

// Database Dialects
const programWindowState = computed(() => {
  if (!props.tabId) return undefined;
  return queryStore.tabs.find((tab) => tab.id === props.tabId)?.programWindow;
});
const resolvedDatabaseType = computed(() => props.databaseType ?? (props.connectionId ? effectiveDatabaseTypeForConnection(connectionStore.getConfig(props.connectionId)) : undefined));
const dialect = computed(() => codeMirrorSqlDialect(resolvedDatabaseType.value));
const formatDialect = computed<SqlFormatDialect>(() => sqlFormatDialectForDbType(resolvedDatabaseType.value));
const isOpenGaussRoutine = computed(() => resolvedDatabaseType.value === "opengauss" || resolvedDatabaseType.value === "gaussdb");

const canEdit = computed(() => sourceEditable.value && props.objectType !== "SEQUENCE");

const isDirty = computed(() => {
  if (isPackage.value) {
    return packageSpecDraft.value !== packageSpecSource.value || packageBodyDraft.value !== packageBodySource.value;
  }
  return draftSource.value !== originalSource.value;
});

const currentActiveDraft = computed({
  get() {
    if (isPackage.value) {
      return activePackagePart.value === "body" ? packageBodyDraft.value : packageSpecDraft.value;
    }
    return draftSource.value;
  },
  set(val: string) {
    if (isPackage.value) {
      if (activePackagePart.value === "body") packageBodyDraft.value = val;
      else packageSpecDraft.value = val;
    } else {
      draftSource.value = val;
    }
  },
});

const currentActiveOriginal = computed(() => {
  if (isPackage.value) {
    return activePackagePart.value === "body" ? packageBodySource.value : packageSpecSource.value;
  }
  return originalSource.value;
});

const targetLabel = computed(() => {
  const prefix = props.schema ? `${props.schema}.` : "";
  return `${prefix}${props.name}`;
});

function logEvent(level: "info" | "success" | "error", text: string) {
  const timestamp = new Date().toLocaleTimeString();
  compileLogs.value.push({ timestamp, level, text });
}

function syncProgramWindowState() {
  const state = programWindowState.value;
  if (!state) return;
  if (isPackage.value) {
    state.packageSpecDraft = packageSpecDraft.value;
    state.packageBodyDraft = packageBodyDraft.value;
  } else {
    state.draftSource = draftSource.value;
  }
  state.dirty = isDirty.value;
}

watch([draftSource, packageSpecDraft, packageBodyDraft], syncProgramWindowState, { flush: "sync" });

// --- Load Source ---
async function loadSource(options: { preserveDraft?: boolean } = {}) {
  const preserveDraft = options.preserveDraft !== false;
  const serial = ++loadSerial;
  loading.value = true;
  loadError.value = "";
  compileSuccessMessage.value = "";
  compileErrors.value = [];
  compileDurationMs.value = null;

  try {
    if (!resolvedDatabaseType.value) throw new Error("数据库连接类型不可用");
    const schema = props.schema || props.database;

    logEvent("info", `[LOAD] 正在读取对象源码: ${props.objectType} ${targetLabel.value}`);

    if (isPackage.value) {
      // Load both Spec and Body for packages
      const [specRes, bodyRes] = await Promise.allSettled([
        loadObjectSourceWithRoutineFallback(api.getObjectSource, props.connectionId, props.database, schema, props.name, "PACKAGE", props.signature, props.relationName),
        loadObjectSourceWithRoutineFallback(api.getObjectSource, props.connectionId, props.database, schema, props.name, "PACKAGE_BODY", props.signature, props.relationName),
      ]);
      if (serial !== loadSerial) return;

      if (specRes.status === "fulfilled") {
        const specEditable = await buildEditableObjectSource({
          databaseType: resolvedDatabaseType.value,
          objectType: "PACKAGE",
          schema,
          name: props.name,
          source: specRes.value.source.source,
        });
        packageSpecSource.value = specEditable;
        packageSpecDraft.value = preserveDraft ? (programWindowState.value?.packageSpecDraft ?? specEditable) : specEditable;
      }
      if (bodyRes.status === "fulfilled") {
        const bodyEditable = await buildEditableObjectSource({
          databaseType: resolvedDatabaseType.value,
          objectType: "PACKAGE_BODY",
          schema,
          name: props.name,
          source: bodyRes.value.source.source,
        });
        packageBodySource.value = bodyEditable;
        packageBodyDraft.value = preserveDraft ? (programWindowState.value?.packageBodyDraft ?? bodyEditable) : bodyEditable;
      }
      sourceEditable.value = true;
      resolvedObjectType.value = props.objectType;
    } else {
      const { source: result, objectType: resolvedType } = await loadObjectSourceWithRoutineFallback(api.getObjectSource, props.connectionId, props.database, schema, props.name, props.objectType, props.signature, props.relationName);
      if (serial !== loadSerial) return;

      const editableAllowed = result.editable !== false;
      const editable = await buildEditableObjectSource({
        databaseType: resolvedDatabaseType.value,
        objectType: resolvedType,
        schema,
        name: props.name,
        source: result.source,
      });
      if (serial !== loadSerial) return;

      resolvedObjectType.value = resolvedType;
      sourceEditable.value = editableAllowed;
      originalSource.value = editable;
      draftSource.value = preserveDraft ? (programWindowState.value?.draftSource ?? editable) : editable;
    }

    logEvent("info", `[LOAD] 源码加载完成`);
  } catch (e: any) {
    if (serial === loadSerial) {
      loadError.value = e?.message || String(e);
      logEvent("error", `[ERROR] 加载源码失败: ${loadError.value}`);
    }
  } finally {
    if (serial === loadSerial) loading.value = false;
  }
}

// --- Compile & Save ---
async function compileAndSave() {
  if (!canEdit.value) {
    toast(t("objects.sourceReadOnly", "该对象源码为只读"), 3000);
    return;
  }

  const databaseType = resolvedDatabaseType.value;
  if (!databaseType) return;
  const schema = props.schema || props.database;

  saving.value = true;
  compileErrors.value = [];
  compileSuccessMessage.value = "";
  compileDurationMs.value = null;

  const startTime = performance.now();

  try {
    const objectTypeToSave = isPackage.value ? (activePackagePart.value === "body" ? "PACKAGE_BODY" : "PACKAGE") : resolvedObjectType.value;
    const sourceToSave = currentActiveDraft.value;

    if (!sourceToSave.trim()) {
      toast("源码内容不能为空", 2000);
      saving.value = false;
      return;
    }

    logEvent("info", `[COMPILE] 开始编译并保存 ${objectTypeToSave} ${targetLabel.value}...`);

    const statements = await buildExecutableObjectSourceStatements({
      databaseType,
      objectType: objectTypeToSave,
      schema,
      name: props.name,
      source: sourceToSave,
    });

    const executableSql = statements.filter((sql) => sql.trim()).join(";\n");

    if (executableSql.trim()) {
      const saved = await executeWithProductionSqlGuard({
        connection: connectionStore.getConfig(props.connectionId),
        database: props.database,
        sql: executableSql,
        source: t("production.sourceObjectSource", "保存对象源码"),
        execute: async () => {
          await executeObjectSourceSave(props.connectionId, props.database, databaseType, statements, schema);
          return true;
        },
      });
      if (!saved) {
        saving.value = false;
        return;
      }
    } else {
      await executeObjectSourceSave(props.connectionId, props.database, databaseType, statements, schema);
    }

    const duration = Math.round(performance.now() - startTime);
    compileDurationMs.value = duration;
    compileSuccessMessage.value = `编译成功 (${duration}ms)`;

    logEvent("success", `[SUCCESS] 编译保存成功 (${duration}ms)`);
    toast(t("objects.sourceSaved", "编译并保存成功"), 1500);

    // Update original state to reflect saved draft
    if (isPackage.value) {
      if (activePackagePart.value === "body") {
        packageBodySource.value = packageBodyDraft.value;
      } else {
        packageSpecSource.value = packageSpecDraft.value;
      }
    } else {
      originalSource.value = draftSource.value;
    }
    syncProgramWindowState();

    emit("saved");
  } catch (err: any) {
    const duration = Math.round(performance.now() - startTime);
    compileDurationMs.value = duration;
    const rawError = err?.message || String(err);
    const formattedError = formatObjectSourceSaveError(err, databaseType, resolvedObjectType.value, t("objects.postgresViewColumnChangeHint"));

    logEvent("error", `[COMPILE ERROR] ${rawError}`);

    // Parse error location (line, column)
    const loc: SqlErrorLocation | null = parseSqlErrorLocation(rawError);
    const parsedLine = loc ? loc.line + 1 : 1;
    const parsedCol = loc ? loc.column + 1 : undefined;

    compileErrors.value = [
      {
        line: parsedLine,
        column: parsedCol,
        message: formattedError,
        raw: rawError,
      },
    ];

    showBottomPanel.value = true;
    bottomTab.value = "errors";
    toast(`编译失败: ${formattedError.slice(0, 120)}`, 4000);
  } finally {
    saving.value = false;
  }
}

// --- Beautify / Format SQL ---
async function beautifySource() {
  if (!currentActiveDraft.value) return;
  formatting.value = true;
  try {
    const formatted = await formatSqlForDisplay(currentActiveDraft.value, formatDialect.value, settingsStore.editorSettings.sqlFormatter);
    currentActiveDraft.value = formatted;
    toast("代码格式化完成", 1000);
  } catch (e: any) {
    toast(`格式化失败: ${e?.message || String(e)}`, 3000);
  } finally {
    formatting.value = false;
  }
}

// --- Revert Draft ---
function revertDraft() {
  if (isPackage.value) {
    if (activePackagePart.value === "body") packageBodyDraft.value = packageBodySource.value;
    else packageSpecDraft.value = packageSpecSource.value;
  } else {
    draftSource.value = originalSource.value;
  }
  syncProgramWindowState();
  compileErrors.value = [];
  toast("已还原为数据库源码", 1200);
}

// --- Navigation & Quick Actions ---
function openTestWindow() {
  queryStore.openRoutineTest({
    connectionId: props.connectionId,
    database: props.database,
    schema: props.schema,
    routineName: props.name,
    routineKind: props.objectType === "FUNCTION" ? "function" : "procedure",
    signature: props.signature,
    catalog: props.catalog,
  });
}

function openDebugWindow() {
  queryStore.openRoutineDebug({
    connectionId: props.connectionId,
    database: props.database,
    schema: props.schema,
    routineName: props.name,
    routineKind: props.objectType === "FUNCTION" ? "function" : "procedure",
    signature: props.signature,
    catalog: props.catalog,
  });
}

function openInSqlEditor() {
  const code = currentActiveDraft.value;
  if (!code) return;
  const tabId = queryStore.createTab(props.connectionId, props.database, `${props.name} (Source)`, "query", props.schema, undefined, props.catalog);
  queryStore.updateSql(tabId, code);
}

async function copySource() {
  const code = currentActiveDraft.value;
  if (!code) return;
  await copyToClipboard(code);
  toast(t("common.copied", "已复制到剪贴板"), 1500);
}

function jumpToError(_err: ParsedCompileError) {
  // Jump editor to line
}

// Simple line-by-line diff
interface DiffLine {
  type: "added" | "removed" | "same";
  text: string;
  lineNoOrig?: number;
  lineNoDraft?: number;
}

const diffLines = computed<DiffLine[]>(() => {
  const orig = currentActiveOriginal.value.split(/\r?\n/);
  const draft = currentActiveDraft.value.split(/\r?\n/);
  const lines: DiffLine[] = [];

  const max = Math.max(orig.length, draft.length);
  for (let i = 0; i < max; i++) {
    const o = orig[i];
    const d = draft[i];
    if (o === undefined) {
      lines.push({ type: "added", text: d, lineNoDraft: i + 1 });
    } else if (d === undefined) {
      lines.push({ type: "removed", text: o, lineNoOrig: i + 1 });
    } else if (o !== d) {
      lines.push({ type: "removed", text: o, lineNoOrig: i + 1 });
      lines.push({ type: "added", text: d, lineNoDraft: i + 1 });
    } else {
      lines.push({ type: "same", text: o, lineNoOrig: i + 1, lineNoDraft: i + 1 });
    }
  }
  return lines;
});

const isRoutine = computed(() => props.objectType === "PROCEDURE" || props.objectType === "FUNCTION" || resolvedObjectType.value === "PROCEDURE" || resolvedObjectType.value === "FUNCTION");

// Watch props reload
watch(
  () => [props.connectionId, props.database, props.catalog, props.schema, props.name, props.objectType] as const,
  () => {
    void loadSource();
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex h-full w-full flex-col min-h-0 bg-background text-foreground select-text">
    <!-- PL/SQL Developer Style Main Program Window Action Toolbar -->
    <div class="flex flex-wrap items-center justify-between border-b bg-muted/40 px-3 py-1 text-xs shrink-0 select-none gap-2">
      <!-- Main Actions -->
      <div class="flex items-center gap-1">
        <!-- Compile & Save -->
        <Button size="sm" class="h-7 gap-1.5 px-3 font-medium shadow-sm bg-primary hover:bg-primary/90 text-primary-foreground" :disabled="saving || loading || !canEdit" :title="'编译并保存 (F8 / Ctrl+S)'" @click="compileAndSave">
          <Loader2 v-if="saving" class="h-3.5 w-3.5 animate-spin" />
          <Play v-else class="h-3.5 w-3.5 fill-current text-emerald-400" />
          <span>编译保存</span>
          <kbd class="ml-1 rounded bg-black/20 px-1 py-0.2 text-[10px] text-primary-foreground font-mono">F8</kbd>
        </Button>

        <!-- Test / Execute (For Routines) -->
        <Button v-if="isRoutine" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 font-medium hover:bg-muted" :title="'打开测试运行窗口'" @click="openTestWindow">
          <TerminalSquare class="h-3.5 w-3.5 text-primary" />
          <span>测试运行</span>
        </Button>

        <!-- Debug (For openGauss Routines) -->
        <Button v-if="isRoutine && isOpenGaussRoutine" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 font-medium hover:bg-muted" :title="'启动 PL/SQL 调试器 (F9)'" @click="openDebugWindow">
          <Bug class="h-3.5 w-3.5 text-amber-500" />
          <span>调试</span>
        </Button>

        <div class="mx-1 h-4 w-px bg-border" />

        <!-- Beautify / Format -->
        <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :disabled="formatting || loading || !canEdit" :title="'美化 / 格式化代码'" @click="beautifySource">
          <Sparkles class="h-3.5 w-3.5 text-amber-500" :class="{ 'animate-spin': formatting }" />
          <span>美化</span>
        </Button>

        <!-- Diff / Compare -->
        <Button
          variant="ghost"
          size="sm"
          class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
          :class="{ 'bg-muted text-foreground': showBottomPanel && bottomTab === 'diff' }"
          :title="'与数据库原有代码比对'"
          @click="
            showBottomPanel = true;
            bottomTab = 'diff';
          "
        >
          <GitCompare class="h-3.5 w-3.5 text-blue-500" />
          <span>差异比对</span>
          <span v-if="isDirty" class="h-1.5 w-1.5 rounded-full bg-amber-500" />
        </Button>

        <!-- Revert -->
        <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :disabled="!isDirty || loading" :title="'放弃当前未保存的修改，还原为数据库源'" @click="revertDraft">
          <RotateCcw class="h-3.5 w-3.5" />
          <span>还原</span>
        </Button>

        <!-- Refresh Source -->
        <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :disabled="loading" :title="'从数据库重新拉取最新源码'" @click="loadSource({ preserveDraft: false })">
          <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
          <span>刷新</span>
        </Button>
      </div>

      <!-- Right Status & Object Info -->
      <div class="flex items-center gap-3">
        <!-- Compile Result Status Badge -->
        <div class="flex items-center gap-2">
          <Badge v-if="compileSuccessMessage" variant="outline" class="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-sans">
            <CheckCircle2 class="h-3 w-3 text-emerald-500" />
            <span>{{ compileSuccessMessage }}</span>
          </Badge>

          <Badge
            v-else-if="compileErrors.length > 0"
            variant="destructive"
            class="gap-1.5 cursor-pointer"
            @click="
              showBottomPanel = true;
              bottomTab = 'errors';
            "
          >
            <AlertCircle class="h-3 w-3" />
            <span>编译报错 ({{ compileErrors.length }})</span>
          </Badge>

          <Badge v-else-if="isDirty" variant="outline" class="border-amber-500/40 text-amber-600 dark:text-amber-400 font-mono text-[10px]"> * 已修改未编译 </Badge>

          <Badge v-else variant="outline" class="text-muted-foreground text-[10px]"> 已同步 </Badge>
        </div>

        <!-- Object Signature Badge -->
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground font-mono bg-muted/60 px-2 py-0.5 rounded border border-border/50">
          <FileCode class="h-3 w-3 text-primary shrink-0" />
          <span class="font-bold text-foreground">{{ props.objectType }}</span>
          <span class="truncate max-w-[220px]" :title="targetLabel">{{ targetLabel }}</span>
        </div>

        <!-- Quick actions -->
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :title="'在 SQL 编辑器中打开'" @click="openInSqlEditor">
            <ExternalLink class="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :title="'复制代码'" @click="copySource">
            <Copy class="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>

    <!-- Package Spec & Body Segmented Tabs (For Package Objects) -->
    <div v-if="isPackage" class="flex items-center justify-between border-b bg-muted/20 px-3 py-1 text-xs shrink-0 select-none">
      <div class="flex items-center gap-1 bg-muted/60 p-0.5 rounded-md border">
        <button type="button" class="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all" :class="activePackagePart === 'spec' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="activePackagePart = 'spec'">
          <Code2 class="h-3.5 w-3.5 text-blue-500" />
          <span>包规范 (Specification)</span>
          <span v-if="packageSpecDraft !== packageSpecSource" class="text-amber-500 font-bold">*</span>
        </button>

        <button type="button" class="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all" :class="activePackagePart === 'body' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="activePackagePart = 'body'">
          <Package class="h-3.5 w-3.5 text-amber-500" />
          <span>包体 (Body)</span>
          <span v-if="packageBodyDraft !== packageBodySource" class="text-amber-500 font-bold">*</span>
        </button>
      </div>

      <div class="text-[11px] text-muted-foreground">
        当前编辑: <span class="font-semibold text-foreground">{{ activePackagePart === "spec" ? "包规范 (PACKAGE)" : "包体 (PACKAGE BODY)" }}</span>
      </div>
    </div>

    <!-- Main Workspace Splitpanes (Top: CodeMirror Editor, Bottom: Errors & Logs) -->
    <div class="flex-1 min-h-0 relative">
      <Splitpanes horizontal class="program-window-splitpanes h-full w-full" @resized="splitpanesSize = $event.panes?.[0]?.size ?? 70">
        <!-- Upper Code Editor Pane -->
        <Pane :size="showBottomPanel ? splitpanesSize : 100" min-size="25" class="flex flex-col min-h-0 bg-background">
          <div v-if="loading" class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground gap-2 select-none">
            <Loader2 class="h-5 w-5 animate-spin text-primary" />
            <span>正在加载对象源码...</span>
          </div>

          <div v-else-if="loadError" class="flex h-full flex-col items-center justify-center p-8 text-sm text-destructive gap-3">
            <AlertCircle class="h-6 w-6" />
            <span>{{ loadError }}</span>
            <Button variant="outline" size="sm" @click="loadSource">重试加载</Button>
          </div>

          <QueryEditor
            v-else
            v-model="currentActiveDraft"
            class="min-h-0 flex-1"
            :connection-id="props.connectionId"
            :database="props.database"
            :schema="props.schema || props.database"
            :database-type="resolvedDatabaseType"
            :dialect="dialect"
            :format-dialect="formatDialect"
            :read-only="!canEdit"
            force-word-wrap
            hide-execution-controls
            @save="compileAndSave"
          />
        </Pane>

        <!-- Lower Compiler Output & Errors Pane (Collapsible) -->
        <Pane v-if="showBottomPanel" :size="100 - splitpanesSize" min-size="15" class="flex flex-col min-h-0 border-t bg-background">
          <Tabs v-model="bottomTab" class="flex h-full flex-col min-h-0">
            <!-- Subheader Bar -->
            <div class="flex items-center justify-between border-b bg-muted/30 px-3 shrink-0 select-none">
              <TabsList class="h-8 bg-transparent p-0 gap-1">
                <!-- Errors Tab -->
                <TabsTrigger value="errors" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>编译错误</span>
                  <span v-if="compileErrors.length" class="ml-1.5 rounded-full bg-destructive/10 text-destructive px-1.5 py-0.2 text-[10px] font-mono font-medium">
                    {{ compileErrors.length }}
                  </span>
                </TabsTrigger>

                <!-- Diff View Tab -->
                <TabsTrigger value="diff" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>差异比对 (Diff)</span>
                </TabsTrigger>

                <!-- Compile Logs Tab -->
                <TabsTrigger value="logs" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>编译日志</span>
                  <span v-if="compileLogs.length" class="ml-1.5 rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">
                    {{ compileLogs.length }}
                  </span>
                </TabsTrigger>
              </TabsList>

              <!-- Close Panel Button -->
              <Button variant="ghost" size="sm" class="h-6 w-6 p-0 text-muted-foreground hover:text-foreground" @click="showBottomPanel = false">
                <X class="h-3.5 w-3.5" />
              </Button>
            </div>

            <!-- Tab 1: Compile Errors -->
            <TabsContent value="errors" class="m-0 flex-1 min-h-0 overflow-y-auto p-0">
              <div v-if="compileErrors.length === 0" class="flex h-24 items-center justify-center text-xs text-muted-foreground/60 italic">无编译错误 (Compiled without errors)</div>

              <div v-else class="w-full">
                <table class="w-full text-left text-xs border-collapse font-sans">
                  <thead class="sticky top-0 bg-muted/90 backdrop-blur z-10 border-b text-muted-foreground font-medium select-none">
                    <tr>
                      <th class="py-1.5 px-3 w-[70px]">行号</th>
                      <th class="py-1.5 px-3 w-[70px]">列号</th>
                      <th class="py-1.5 px-3">错误信息 (Error Message)</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y font-mono">
                    <tr v-for="(err, eIdx) in compileErrors" :key="eIdx" class="hover:bg-destructive/10 cursor-pointer text-destructive transition-colors" @click="jumpToError(err)">
                      <td class="py-1.5 px-3 font-bold underline">Line {{ err.line }}</td>
                      <td class="py-1.5 px-3 text-muted-foreground">
                        {{ err.column != null ? `Col ${err.column}` : "-" }}
                      </td>
                      <td class="py-1.5 px-3 whitespace-pre-wrap font-sans font-medium">
                        {{ err.message }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </TabsContent>

            <!-- Tab 2: Diff View -->
            <TabsContent value="diff" class="m-0 flex-1 min-h-0 overflow-auto bg-muted/10 p-3 font-mono text-xs">
              <div v-if="!isDirty" class="flex h-full items-center justify-center text-muted-foreground/60 italic">当前源码与数据库现有版本一致，暂无改动差异</div>

              <div v-else class="space-y-0.5">
                <div
                  v-for="(line, lIdx) in diffLines"
                  :key="lIdx"
                  class="flex items-stretch leading-5 px-2 py-0.5 rounded text-[11px]"
                  :class="[line.type === 'added' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-medium' : '', line.type === 'removed' ? 'bg-destructive/15 text-destructive line-through' : '', line.type === 'same' ? 'text-muted-foreground' : '']"
                >
                  <span class="w-6 shrink-0 select-none text-[10px] opacity-60">
                    {{ line.type === "added" ? "+" : line.type === "removed" ? "-" : " " }}
                  </span>
                  <span class="whitespace-pre flex-1">{{ line.text }}</span>
                </div>
              </div>
            </TabsContent>

            <!-- Tab 3: Compile Logs -->
            <TabsContent value="logs" class="m-0 flex-1 min-h-0 overflow-y-auto p-3 font-mono text-xs space-y-1">
              <div v-if="compileLogs.length === 0" class="flex h-full items-center justify-center text-muted-foreground/60 italic">暂无编译日志</div>
              <div v-for="(log, lIdx) in compileLogs" :key="lIdx" class="leading-relaxed break-all">
                <span class="text-muted-foreground/60 mr-2 select-none">[{{ log.timestamp }}]</span>
                <span v-if="log.level === 'error'" class="text-destructive font-semibold">{{ log.text }}</span>
                <span v-else-if="log.level === 'success'" class="text-emerald-600 dark:text-emerald-400 font-medium">{{ log.text }}</span>
                <span v-else class="text-foreground">{{ log.text }}</span>
              </div>
            </TabsContent>
          </Tabs>
        </Pane>
      </Splitpanes>
    </div>
  </div>
</template>

<style scoped>
.program-window-splitpanes :deep(.splitpanes--horizontal > .splitpanes__splitter) {
  height: 6px;
  background-color: var(--border);
  position: relative;
  transition: background-color 0.15s ease;
}

.program-window-splitpanes :deep(.splitpanes--horizontal > .splitpanes__splitter:hover) {
  background-color: var(--ring);
}
</style>
