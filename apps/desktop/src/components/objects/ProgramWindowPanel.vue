<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertCircle, Braces, Bug, CheckCircle2, Code2, Copy, ExternalLink, Eye, FileCode, Gauge, GitCompare, Layers, ListTree, Loader2, Network, Package, Play, RefreshCw, RotateCcw, Search, Sparkles, Table2, TerminalSquare, X } from "@lucide/vue";
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
import { buildPackageMemberCallSql, parsePlSqlOutline, type PlSqlOutlineItem, type PlSqlOutlineKind } from "@/lib/sql/plsqlOutline";
import { codeMirrorSqlDialect, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { buildEditableObjectSource, buildExecutableObjectSourceStatements, executeObjectSourceSave, formatObjectSourceSaveError } from "@/lib/table/objectSourceEditor";
import { buildOpenGaussRoutineExecutionSql } from "@/lib/table/routineExecutionSql";
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
const compileSucceeded = ref(false);
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
const packageSourcesLoaded = ref(false);

// Outline Panel State
const showOutlinePanel = ref(false);
const outlineManuallyToggled = ref(false);
const outlineFilter = ref("");
const selectedOutlineId = ref<string | null>(null);
const currentCursorLine = ref<number | null>(null);

// Bottom Splitpanes & Compilation Panel
const showBottomPanel = ref(false);
const bottomTab = ref<"errors" | "logs" | "diff" | "dependencies" | "profiler">("errors");
const splitpanesSize = ref(70);

// Profiler state
const profilerLoading = ref(false);
const profilerResult = ref<api.ProfilerRunResult | null>(null);
const profilerCallSql = ref("");

// Dependencies state
type ObjectReferenceInfo = Awaited<ReturnType<typeof api.listObjectReferences>>[number];
const dependenciesLoading = ref(false);
const dependenciesError = ref("");
const referencesList = ref<ObjectReferenceInfo[]>([]);
const referencedByList = ref<ObjectReferenceInfo[]>([]);

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
const editorRef = ref<InstanceType<typeof QueryEditor> | null>(null);
const editorWrapperRef = ref<HTMLElement | null>(null);
let loadSerial = 0;

// Database Dialects
const programWindowState = computed(() => {
  if (!props.tabId) return undefined;
  return queryStore.tabs.find((tab) => tab.id === props.tabId)?.programWindow;
});
const resolvedDatabaseType = computed(() => props.databaseType ?? (props.connectionId ? effectiveDatabaseTypeForConnection(connectionStore.getConfig(props.connectionId)) : undefined));
const dialect = computed(() => codeMirrorSqlDialect(resolvedDatabaseType.value));
const formatDialect = computed<SqlFormatDialect>(() => sqlFormatDialectForDbType(resolvedDatabaseType.value));
const isOpenGaussRoutine = computed(() => resolvedDatabaseType.value === "opengauss");

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

const compileSuccessBadgeText = computed(() => {
  if (!compileSucceeded.value) return "";
  const duration = compileDurationMs.value ?? 0;
  return t("programWindow.compileSuccessWithDuration", { duration }, "编译成功 ({duration}ms)");
});

// --- PL/SQL Outline Computed & Helpers ---
const outlineItems = computed<PlSqlOutlineItem[]>(() => parsePlSqlOutline(currentActiveDraft.value));

watch(
  outlineItems,
  (items) => {
    if (!outlineManuallyToggled.value) {
      showOutlinePanel.value = items.length >= 1;
    }
  },
  { immediate: true },
);

watch(activePackagePart, () => {
  selectedOutlineId.value = null;
  currentCursorLine.value = null;
});

function outlineBadgeLabel(kind: PlSqlOutlineKind): string {
  switch (kind) {
    case "package":
      return "PKG";
    case "package-body":
      return "BODY";
    case "procedure":
      return "PROC";
    case "function":
      return "FUNC";
    case "trigger":
      return "TRIG";
    case "type":
      return "TYPE";
    case "cursor":
      return "CUR";
    case "constant":
      return "CONST";
    case "variable":
      return "VAR";
    case "exception":
      return "EXC";
  }
}

function outlineBadgeClass(kind: PlSqlOutlineKind): string {
  switch (kind) {
    case "package":
      return "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30";
    case "package-body":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";
    case "procedure":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
    case "function":
      return "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30";
    case "trigger":
      return "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30";
    case "type":
      return "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30";
    case "cursor":
      return "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30";
    case "constant":
      return "bg-teal-500/15 text-teal-600 dark:text-teal-400 border-teal-500/30";
    case "exception":
      return "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30";
    case "variable":
      return "bg-muted text-muted-foreground border-border";
  }
}

const filteredOutlineItems = computed<PlSqlOutlineItem[]>(() => {
  const q = outlineFilter.value.trim().toLowerCase();
  if (!q) return outlineItems.value;
  return outlineItems.value.filter((item) => {
    if (item.name.toLowerCase().includes(q)) return true;
    if (item.signature?.toLowerCase().includes(q)) return true;
    if (outlineBadgeLabel(item.kind).toLowerCase().includes(q)) return true;
    return false;
  });
});

const activeOutlineId = computed<string | null>(() => {
  const cursorLine = currentCursorLine.value;
  if (cursorLine != null && cursorLine >= 1) {
    if (selectedOutlineId.value) {
      const explicit = outlineItems.value.find((i) => i.id === selectedOutlineId.value);
      if (explicit && explicit.line === cursorLine) {
        return explicit.id;
      }
    }
    let best: PlSqlOutlineItem | null = null;
    let bestSpan = Infinity;
    for (const item of outlineItems.value) {
      const end = item.endLine ?? item.line;
      if (cursorLine >= item.line && cursorLine <= end) {
        const span = end - item.line;
        if (span < bestSpan || (span === bestSpan && (!best || item.line >= best.line))) {
          best = item;
          bestSpan = span;
        }
      }
    }
    if (best) return best.id;
  }
  return selectedOutlineId.value;
});

function toggleOutlinePanel() {
  outlineManuallyToggled.value = true;
  showOutlinePanel.value = !showOutlinePanel.value;
}

interface EditorStateAccess {
  selection?: { main?: { head?: number } };
  doc?: { lineAt?: (pos: number) => { number: number } };
}

interface EditorExposedAccess {
  getCursorLine?: () => number;
  view?: { state?: EditorStateAccess } | null;
  editorView?: { state?: EditorStateAccess } | null;
}

function syncCursorFromEditor() {
  const exposed = editorRef.value as unknown as EditorExposedAccess | null;
  if (typeof exposed?.getCursorLine === "function") {
    const line = exposed.getCursorLine();
    if (typeof line === "number" && line >= 1) {
      currentCursorLine.value = line;
      return;
    }
  }
  const cmState = exposed?.view?.state ?? exposed?.editorView?.state;
  const head = cmState?.selection?.main?.head;
  if (typeof head === "number" && typeof cmState?.doc?.lineAt === "function") {
    currentCursorLine.value = cmState.doc.lineAt(head).number;
    return;
  }
  // Fallback: inspect CodeMirror 6 DOM view descriptor if attached on `.cm-content`
  const cmContent = editorWrapperRef.value?.querySelector(".cm-content") as { cmView?: { view?: { state?: EditorStateAccess } } } | null | undefined;
  const domState = cmContent?.cmView?.view?.state;
  const domHead = domState?.selection?.main?.head;
  if (typeof domHead === "number" && typeof domState?.doc?.lineAt === "function") {
    currentCursorLine.value = domState.doc.lineAt(domHead).number;
  }
}

function selectOutlineItem(item: PlSqlOutlineItem) {
  selectedOutlineId.value = item.id;
  jumpToLine(item.line);
}

function runPackageSubprogram(item: PlSqlOutlineItem) {
  const sql = buildPackageMemberCallSql({
    schema: props.schema,
    packageName: props.name,
    item,
  });
  const qualifiedName = `${props.name}.${item.name}`;
  const tabId = queryStore.createTab(props.connectionId, props.database, qualifiedName, "query", props.schema, undefined, props.catalog);
  queryStore.updateSql(tabId, sql);
  toast(t("programWindow.openedSubprogramSql", { name: qualifiedName }, "已在查询窗口生成调用脚本: {name}"), 1800);
}

function debugPackageSubprogram(item: PlSqlOutlineItem) {
  queryStore.openRoutineDebug({
    connectionId: props.connectionId,
    database: props.database,
    schema: props.schema,
    routineName: `${props.name}.${item.name}`,
    routineKind: item.kind === "function" ? "function" : "procedure",
    signature: item.signature,
    catalog: props.catalog,
  });
}

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
    if (packageSourcesLoaded.value) {
      state.packageSpecDraftInitialized = true;
      state.packageBodyDraftInitialized = true;
    }
  } else {
    state.draftSource = draftSource.value;
  }
  state.dirty = isDirty.value;
}

watch([draftSource, packageSpecDraft, packageBodyDraft], syncProgramWindowState, { flush: "sync" });

// --- Load Source ---
async function loadSource(options: { preserveDraft?: boolean } = {}) {
  const preserveDraft = options.preserveDraft !== false;
  packageSourcesLoaded.value = false;
  dependenciesError.value = "";
  referencesList.value = [];
  referencedByList.value = [];
  const serial = ++loadSerial;
  loading.value = true;
  loadError.value = "";
  compileSucceeded.value = false;
  compileErrors.value = [];
  compileDurationMs.value = null;

  try {
    if (!resolvedDatabaseType.value) {
      throw new Error(t("programWindow.dbTypeUnavailable", "数据库连接类型不可用"));
    }
    const schema = props.schema || props.database;

    logEvent("info", t("programWindow.logLoadingSource", { type: props.objectType, target: targetLabel.value }, "[LOAD] 正在读取对象源码: {type} {target}"));

    if (isPackage.value) {
      // Snapshot both drafts before assigning either source. The sync watcher
      // runs immediately; without this snapshot, loading the spec first would
      // persist the body's initial empty string and hide the real body source.
      const storedPackageState = programWindowState.value;
      const storedPackageSpecDraft = preserveDraft ? storedPackageState?.packageSpecDraft : undefined;
      const storedPackageBodyDraft = preserveDraft ? storedPackageState?.packageBodyDraft : undefined;
      const storedPackageSpecDraftInitialized = storedPackageState?.packageSpecDraftInitialized === true;
      const storedPackageBodyDraftInitialized = storedPackageState?.packageBodyDraftInitialized === true;
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
        packageSpecDraft.value = storedPackageSpecDraft === "" && !storedPackageSpecDraftInitialized && specEditable.trim() ? specEditable : (storedPackageSpecDraft ?? specEditable);
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
        packageBodyDraft.value = storedPackageBodyDraft === "" && !storedPackageBodyDraftInitialized && bodyEditable.trim() ? bodyEditable : (storedPackageBodyDraft ?? bodyEditable);
      }
      sourceEditable.value = true;
      resolvedObjectType.value = props.objectType;
      packageSourcesLoaded.value = true;
      syncProgramWindowState();
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

    logEvent("info", t("programWindow.logLoadComplete", "[LOAD] 源码加载完成"));
  } catch (e: unknown) {
    if (serial === loadSerial) {
      const message = e instanceof Error ? e.message : String(e);
      loadError.value = message;
      logEvent("error", t("programWindow.logLoadFailed", { error: message }, "[ERROR] 加载源码失败: {error}"));
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
  compileSucceeded.value = false;
  compileDurationMs.value = null;

  const startTime = performance.now();

  try {
    const objectTypeToSave = isPackage.value ? (activePackagePart.value === "body" ? "PACKAGE_BODY" : "PACKAGE") : resolvedObjectType.value;
    const sourceToSave = currentActiveDraft.value;

    if (!sourceToSave.trim()) {
      toast(t("programWindow.emptySourceError", "源码内容不能为空"), 2000);
      saving.value = false;
      return;
    }

    logEvent("info", t("programWindow.logCompileStart", { type: objectTypeToSave, target: targetLabel.value }, "[COMPILE] 开始编译并保存 {type} {target}..."));

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
    compileSucceeded.value = true;

    logEvent("success", t("programWindow.logCompileSuccess", { duration }, "[SUCCESS] 编译保存成功 ({duration}ms)"));
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
  } catch (err: unknown) {
    const duration = Math.round(performance.now() - startTime);
    compileDurationMs.value = duration;
    const rawError = err instanceof Error ? err.message : String(err);
    const formattedError = formatObjectSourceSaveError(err, databaseType, resolvedObjectType.value, t("objects.postgresViewColumnChangeHint"));

    logEvent("error", t("programWindow.logCompileError", { error: rawError }, "[COMPILE ERROR] {error}"));

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
    const summaryError = formattedError.slice(0, 120);
    toast(t("programWindow.compileFailedToast", { error: summaryError }, "编译失败: {error}"), 4000);
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
    toast(t("programWindow.formatSuccess", "代码格式化完成"), 1000);
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    toast(t("programWindow.formatFailed", { error: errMsg }, "格式化失败: {error}"), 3000);
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
  toast(t("programWindow.revertedToDbSource", "已还原为数据库源码"), 1200);
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
  const suffix = t("programWindow.sourceSuffix", "源码");
  const tabId = queryStore.createTab(props.connectionId, props.database, `${props.name} (${suffix})`, "query", props.schema, undefined, props.catalog);
  queryStore.updateSql(tabId, code);
}

async function copySource() {
  const code = currentActiveDraft.value;
  if (!code) return;
  await copyToClipboard(code);
  toast(t("common.copied", "已复制到剪贴板"), 1500);
}

function jumpToError(err: ParsedCompileError) {
  jumpToLine(err.line);
}

function jumpToLine(lineNumber: number) {
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return;
  const targetLine = Math.floor(lineNumber);
  currentCursorLine.value = targetLine;
  editorRef.value?.focusLine(targetLine);
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

// --- Profiler ---
function routineRequiresProfilerArguments(): boolean {
  const signature = props.signature?.trim() || "";
  return signature.replace(/[()]/g, "").trim().length > 0;
}

function defaultProfilerCallSql(): string {
  if (routineRequiresProfilerArguments()) return "";
  return buildOpenGaussRoutineExecutionSql({
    databaseType: resolvedDatabaseType.value,
    schema: props.schema,
    routineName: props.name,
    parameters: [],
    isFunction: resolvedObjectType.value === "FUNCTION",
    functionReturn: null,
  });
}

async function runProfiler() {
  if (!props.connectionId || !props.database) return;
  profilerLoading.value = true;
  showBottomPanel.value = true;
  bottomTab.value = "profiler";
  try {
    const callSql = profilerCallSql.value.trim() || defaultProfilerCallSql();
    if (!callSql) {
      toast(t("programWindow.profilerRequiresArgs", "当前例程需要参数，请先填写要剖析的调用 SQL"), 3500);
      return;
    }
    const status = await api.opengaussProfilerStatus(props.connectionId, props.database);
    if (!status.installed) {
      toast(status.message || t("programWindow.profilerNotInstalled", "gms_profiler 扩展未安装"), 3500);
      return;
    }
    const res = await api.opengaussProfilerRun(props.connectionId, props.database, props.schema, callSql, `Profile: ${props.name}`);
    profilerResult.value = res;
    const totalMs = Math.round(res.totalTimeMs);
    toast(t("programWindow.profilerCompletedToast", { duration: totalMs }, "性能剖析完成: 总耗时 {duration}ms"), 2000);
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    toast(t("programWindow.profilerErrorToast", { error: errMsg }, "性能剖析提示: {error}"), 3500);
  } finally {
    profilerLoading.value = false;
  }
}

function formatUs(us: number): string {
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(2)} s`;
  if (us >= 1_000) return `${(us / 1_000).toFixed(2)} ms`;
  return `${us.toFixed(1)} µs`;
}

// --- Dependencies ---
async function loadDependencies() {
  if (!props.connectionId || !props.database) return;
  dependenciesLoading.value = true;
  dependenciesError.value = "";
  try {
    const schema = props.schema || props.database;
    const objType = isPackage.value ? (activePackagePart.value === "body" ? "package_body" : "package") : resolvedObjectType.value.toLowerCase();
    const [refs, refBy] = await Promise.all([api.listObjectReferences(props.connectionId, props.database, schema, objType, props.name, "references"), api.listObjectReferences(props.connectionId, props.database, schema, objType, props.name, "referencedBy")]);
    referencesList.value = refs;
    referencedByList.value = refBy;
  } catch (e: unknown) {
    referencesList.value = [];
    referencedByList.value = [];
    dependenciesError.value = e instanceof Error ? e.message : String(e);
    console.warn("[ProgramWindow] failed to load dependencies", e);
  } finally {
    dependenciesLoading.value = false;
  }
}

function openDependenciesTab() {
  showBottomPanel.value = true;
  bottomTab.value = "dependencies";
  void loadDependencies();
}

function jumpToObject(item: ObjectReferenceInfo) {
  const normalizedType = (item.objectType || "").toLowerCase();
  if (normalizedType === "procedure" || normalizedType === "function" || normalizedType === "package" || normalizedType === "package_body" || normalizedType === "package-body") {
    const kind: ObjectSourceKind = normalizedType === "procedure" ? "PROCEDURE" : normalizedType === "function" ? "FUNCTION" : normalizedType === "package_body" || normalizedType === "package-body" ? "PACKAGE_BODY" : "PACKAGE";
    queryStore.openProgramWindow({
      connectionId: props.connectionId,
      database: props.database,
      schema: item.schema,
      name: item.name,
      objectType: kind,
      catalog: props.catalog,
    });
  } else if (normalizedType === "table" || normalizedType === "view" || normalizedType === "materialized_view") {
    queryStore.openTableStructure(props.connectionId, props.database, item.schema, item.name, undefined, undefined, props.catalog);
  }
}

function iconForType(type: string) {
  const normalizedType = (type || "").toLowerCase();
  switch (normalizedType) {
    case "table":
      return Table2;
    case "view":
    case "materialized_view":
      return Eye;
    case "procedure":
    case "function":
      return FileCode;
    case "package":
    case "package_body":
    case "package-body":
      return Package;
    case "type":
      return Braces;
    case "sequence":
      return Layers;
    default:
      return Code2;
  }
}

// Watch props reload
watch(
  () => [props.connectionId, props.database, props.catalog, props.schema, props.name, props.objectType] as const,
  () => {
    profilerCallSql.value = "";
    profilerResult.value = null;
    outlineManuallyToggled.value = false;
    outlineFilter.value = "";
    selectedOutlineId.value = null;
    currentCursorLine.value = null;
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
        <Button size="sm" class="h-7 gap-1.5 px-3 font-medium shadow-sm bg-primary hover:bg-primary/90 text-primary-foreground" :disabled="saving || loading || !canEdit" :title="t('programWindow.compileAndSaveHint', '编译并保存 (F8 / Ctrl+S)')" @click="compileAndSave">
          <Loader2 v-if="saving" class="h-3.5 w-3.5 animate-spin" />
          <Play v-else class="h-3.5 w-3.5 fill-current text-emerald-400" />
          <span>{{ t("programWindow.compileAndSave", "编译保存") }}</span>
          <kbd class="ml-1 rounded bg-black/20 px-1 py-0.2 text-[10px] text-primary-foreground font-mono">F8</kbd>
        </Button>

        <!-- Test / Execute (For Routines) -->
        <Button v-if="isRoutine" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 font-medium hover:bg-muted" :title="t('programWindow.openTestWindowHint', '打开测试运行窗口')" @click="openTestWindow">
          <TerminalSquare class="h-3.5 w-3.5 text-primary" />
          <span>{{ t("programWindow.testRun", "测试运行") }}</span>
        </Button>

        <!-- Debug (For openGauss Routines) -->
        <Button v-if="isRoutine && isOpenGaussRoutine" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 font-medium hover:bg-muted" :title="t('programWindow.openDebuggerHint', '启动 PL/SQL 调试器 (F9)')" @click="openDebugWindow">
          <Bug class="h-3.5 w-3.5 text-amber-500" />
          <span>{{ t("programWindow.debug", "调试") }}</span>
        </Button>

        <!-- Profiler (For openGauss Routines) -->
        <Button v-if="isRoutine && isOpenGaussRoutine" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 font-medium hover:bg-muted" :disabled="profilerLoading || loading" :title="t('programWindow.profilerHint', '逐行性能分析 (gms_profiler)')" @click="runProfiler">
          <Loader2 v-if="profilerLoading" class="h-3.5 w-3.5 animate-spin text-purple-500" />
          <Gauge v-else class="h-3.5 w-3.5 text-purple-500" />
          <span>{{ t("programWindow.profiler", "性能剖析") }}</span>
        </Button>

        <div class="mx-1 h-4 w-px bg-border" />

        <!-- Outline Toggle -->
        <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :class="{ 'bg-muted text-foreground': showOutlinePanel }" :title="t('programWindow.outlineHint', '切换符号大纲面板')" @click="toggleOutlinePanel">
          <ListTree class="h-3.5 w-3.5 text-emerald-500" />
          <span>{{ t("programWindow.outline", "符号大纲") }}</span>
          <span v-if="outlineItems.length > 0" class="rounded-full bg-muted-foreground/15 px-1.5 py-0 text-[10px] font-mono text-foreground">
            {{ outlineItems.length }}
          </span>
        </Button>

        <!-- Beautify / Format -->
        <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :disabled="formatting || loading || !canEdit" :title="t('programWindow.beautifyHint', '美化 / 格式化代码')" @click="beautifySource">
          <Sparkles class="h-3.5 w-3.5 text-amber-500" :class="{ 'animate-spin': formatting }" />
          <span>{{ t("programWindow.beautify", "美化") }}</span>
        </Button>

        <!-- Diff / Compare -->
        <Button
          variant="ghost"
          size="sm"
          class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
          :class="{ 'bg-muted text-foreground': showBottomPanel && bottomTab === 'diff' }"
          :title="t('programWindow.diffHint', '与数据库原有代码比对')"
          @click="
            showBottomPanel = true;
            bottomTab = 'diff';
          "
        >
          <GitCompare class="h-3.5 w-3.5 text-blue-500" />
          <span>{{ t("programWindow.diff", "差异比对") }}</span>
          <span v-if="isDirty" class="h-1.5 w-1.5 rounded-full bg-amber-500" />
        </Button>

        <!-- Dependencies -->
        <Button
          variant="ghost"
          size="sm"
          class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
          :class="{ 'bg-muted text-foreground': showBottomPanel && bottomTab === 'dependencies' }"
          :title="t('programWindow.dependenciesHint', '查看对象的引用与被引用依赖关系')"
          @click="openDependenciesTab"
        >
          <Network class="h-3.5 w-3.5 text-indigo-500" />
          <span>{{ t("programWindow.dependencies", "依赖关系") }}</span>
          <span v-if="referencesList.length + referencedByList.length > 0" class="text-[10px] font-mono text-muted-foreground"> ({{ referencesList.length + referencedByList.length }}) </span>
        </Button>

        <!-- Revert -->
        <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :disabled="!isDirty || loading" :title="t('programWindow.revertHint', '放弃当前未保存的修改，还原为数据库源码')" @click="revertDraft">
          <RotateCcw class="h-3.5 w-3.5" />
          <span>{{ t("programWindow.revert", "还原") }}</span>
        </Button>

        <!-- Refresh Source -->
        <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :disabled="loading" :title="t('programWindow.refreshHint', '从数据库重新拉取最新源码')" @click="loadSource({ preserveDraft: false })">
          <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
          <span>{{ t("programWindow.refresh", "刷新") }}</span>
        </Button>
      </div>

      <!-- Right Status & Object Info -->
      <div class="flex items-center gap-3">
        <!-- Compile Result Status Badge -->
        <div class="flex items-center gap-2">
          <Badge v-if="compileSuccessBadgeText" variant="outline" class="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-sans">
            <CheckCircle2 class="h-3 w-3 text-emerald-500" />
            <span>{{ compileSuccessBadgeText }}</span>
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
            <span>{{ t("programWindow.compileErrorBadge", { count: compileErrors.length }, "编译报错 ({count})") }}</span>
          </Badge>

          <Badge v-else-if="isDirty" variant="outline" class="border-amber-500/40 text-amber-600 dark:text-amber-400 font-mono text-[10px]">
            {{ t("programWindow.modifiedUncompiled", "* 已修改未编译") }}
          </Badge>

          <Badge v-else variant="outline" class="text-muted-foreground text-[10px]">
            {{ t("programWindow.synced", "已同步") }}
          </Badge>
        </div>

        <!-- Object Signature Badge -->
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground font-mono bg-muted/60 px-2 py-0.5 rounded border border-border/50">
          <FileCode class="h-3 w-3 text-primary shrink-0" />
          <span class="font-bold text-foreground">{{ props.objectType }}</span>
          <span class="truncate max-w-[220px]" :title="targetLabel">{{ targetLabel }}</span>
        </div>

        <!-- Quick actions -->
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :title="t('programWindow.openInSqlEditor', '在 SQL 编辑器中打开')" @click="openInSqlEditor">
            <ExternalLink class="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :title="t('programWindow.copySource', '复制代码')" @click="copySource">
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
          <span>{{ t("programWindow.packageSpec", "包规范 (Specification)") }}</span>
          <span v-if="packageSpecDraft !== packageSpecSource" class="text-amber-500 font-bold">*</span>
        </button>

        <button type="button" class="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all" :class="activePackagePart === 'body' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="activePackagePart = 'body'">
          <Package class="h-3.5 w-3.5 text-amber-500" />
          <span>{{ t("programWindow.packageBody", "包体 (Body)") }}</span>
          <span v-if="packageBodyDraft !== packageBodySource" class="text-amber-500 font-bold">*</span>
        </button>
      </div>

      <div class="text-[11px] text-muted-foreground">
        {{ t("programWindow.currentlyEditing", "当前编辑:") }}
        <span class="font-semibold text-foreground">
          {{ activePackagePart === "spec" ? t("programWindow.packageSpecFull", "包规范 (PACKAGE)") : t("programWindow.packageBodyFull", "包体 (PACKAGE BODY)") }}
        </span>
      </div>
    </div>

    <!-- Main Workspace Splitpanes (Top: Outline + CodeMirror Editor, Bottom: Errors & Logs) -->
    <div class="flex-1 min-h-0 relative">
      <Splitpanes horizontal class="program-window-splitpanes h-full w-full" @resized="splitpanesSize = $event.panes?.[0]?.size ?? 70">
        <!-- Upper Code Editor + Outline Pane -->
        <Pane :size="showBottomPanel ? splitpanesSize : 100" min-size="25" class="flex flex-col min-h-0 bg-background">
          <div v-if="loading" class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground gap-2 select-none">
            <Loader2 class="h-5 w-5 animate-spin text-primary" />
            <span>{{ t("programWindow.loadingSource", "正在加载对象源码...") }}</span>
          </div>

          <div v-else-if="loadError" class="flex h-full flex-col items-center justify-center p-8 text-sm text-destructive gap-3">
            <AlertCircle class="h-6 w-6" />
            <span>{{ loadError }}</span>
            <Button variant="outline" size="sm" @click="loadSource()">{{ t("programWindow.retryLoad", "重试加载") }}</Button>
          </div>

          <div v-else class="flex flex-1 min-h-0 w-full">
            <!-- Collapsible Left Symbol Outline Sidebar -->
            <aside v-if="showOutlinePanel" class="w-64 xl:w-72 shrink-0 border-r bg-muted/15 flex flex-col min-h-0 select-none">
              <div class="flex items-center justify-between px-2.5 py-1.5 border-b bg-muted/30 text-xs">
                <div class="flex items-center gap-1.5 font-medium text-foreground">
                  <ListTree class="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  <span>{{ t("programWindow.outlineTitle", "符号大纲") }}</span>
                  <Badge variant="secondary" class="h-4 px-1.5 py-0 text-[10px] font-mono">{{ outlineItems.length }}</Badge>
                </div>
                <Button variant="ghost" size="sm" class="h-5 w-5 p-0 text-muted-foreground hover:text-foreground" :title="t('programWindow.closeOutline', '收起符号大纲')" @click="toggleOutlinePanel">
                  <X class="h-3 w-3" />
                </Button>
              </div>

              <!-- Search Filter -->
              <div class="p-1.5 border-b bg-background/60">
                <div class="relative flex items-center">
                  <Search class="h-3 w-3 text-muted-foreground absolute left-2 pointer-events-none" />
                  <input
                    v-model="outlineFilter"
                    type="text"
                    class="h-6 w-full rounded border bg-background pl-6 pr-6 text-[11px] text-foreground placeholder:text-muted-foreground/70 outline-none focus:border-ring"
                    :placeholder="t('programWindow.outlineSearchPlaceholder', '搜索过程、函数、变量、游标...')"
                  />
                  <button v-if="outlineFilter" type="button" class="absolute right-1.5 text-muted-foreground hover:text-foreground" :title="t('programWindow.clearSearch', '清除搜索')" @click="outlineFilter = ''">
                    <X class="h-3 w-3" />
                  </button>
                </div>
              </div>

              <!-- Outline Symbols List -->
              <div class="flex-1 min-h-0 overflow-y-auto p-1 space-y-0.5">
                <div v-if="outlineItems.length === 0" class="flex h-24 items-center justify-center px-3 text-center text-[11px] text-muted-foreground/70 italic">
                  {{ t("programWindow.outlineEmpty", "未解析到符号定义") }}
                </div>
                <div v-else-if="filteredOutlineItems.length === 0" class="flex h-24 items-center justify-center px-3 text-center text-[11px] text-muted-foreground/70 italic">
                  {{ t("programWindow.outlineNoMatch", "无匹配的符号") }}
                </div>
                <div
                  v-for="item in filteredOutlineItems"
                  :key="item.id"
                  class="group flex items-center justify-between gap-1.5 rounded px-1.5 py-1 text-xs cursor-pointer transition-colors"
                  :class="[activeOutlineId === item.id ? 'bg-primary/15 text-foreground font-medium ring-1 ring-primary/30' : 'hover:bg-muted/70 text-foreground/90', item.isForwardDeclaration ? 'opacity-70' : '']"
                  :title="`${item.name}${item.signature ? ' ' + item.signature : ''} (L${item.line})`"
                  @click="selectOutlineItem(item)"
                >
                  <div class="flex items-center gap-1.5 min-w-0 flex-1">
                    <span class="shrink-0 rounded border px-1 py-0 text-[9px] font-mono font-semibold leading-4" :class="outlineBadgeClass(item.kind)">
                      {{ outlineBadgeLabel(item.kind) }}
                    </span>
                    <div class="min-w-0 flex-1 truncate">
                      <span class="font-mono text-[11px]">{{ item.name }}</span>
                      <span v-if="item.isForwardDeclaration" class="ml-1 rounded bg-muted px-1 text-[9px] text-muted-foreground" :title="t('programWindow.forwardDeclaration', '前向声明')">FWD</span>
                      <span v-if="item.signature" class="ml-1 font-mono text-[10px] text-muted-foreground">{{ item.signature }}</span>
                    </div>
                  </div>

                  <div class="flex items-center gap-0.5 shrink-0">
                    <!-- Hover quick actions for Package Subprograms -->
                    <template v-if="isPackage && item.isExecutableSubprogram">
                      <button type="button" class="hidden group-hover:inline-flex h-5 w-5 items-center justify-center rounded hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400" :title="t('programWindow.runSubprogram', '生成调用 SQL 并打开测试')" @click.stop="runPackageSubprogram(item)">
                        <Play class="h-3 w-3 fill-current" />
                      </button>
                      <button
                        v-if="isOpenGaussRoutine"
                        type="button"
                        class="hidden group-hover:inline-flex h-5 w-5 items-center justify-center rounded hover:bg-amber-500/20 text-amber-600 dark:text-amber-400"
                        :title="t('programWindow.debugSubprogram', '调试此子程序')"
                        @click.stop="debugPackageSubprogram(item)"
                      >
                        <Bug class="h-3 w-3" />
                      </button>
                    </template>
                    <span class="font-mono text-[10px] text-muted-foreground/70 tabular-nums ml-0.5">L{{ item.line }}</span>
                  </div>
                </div>
              </div>
            </aside>

            <!-- Editor Area -->
            <div ref="editorWrapperRef" class="flex-1 min-w-0 min-h-0 flex flex-col" @keyup="syncCursorFromEditor" @mouseup="syncCursorFromEditor">
              <QueryEditor
                ref="editorRef"
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
            </div>
          </div>
        </Pane>

        <!-- Lower Compiler Output & Errors Pane (Collapsible) -->
        <Pane v-if="showBottomPanel" :size="100 - splitpanesSize" min-size="15" class="flex flex-col min-h-0 border-t bg-background">
          <Tabs v-model="bottomTab" class="flex h-full flex-col min-h-0">
            <!-- Subheader Bar -->
            <div class="flex items-center justify-between border-b bg-muted/30 px-3 shrink-0 select-none">
              <TabsList class="h-8 bg-transparent p-0 gap-1">
                <!-- Errors Tab -->
                <TabsTrigger value="errors" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>{{ t("programWindow.tabErrors", "编译错误") }}</span>
                  <span v-if="compileErrors.length" class="ml-1.5 rounded-full bg-destructive/10 text-destructive px-1.5 py-0.2 text-[10px] font-mono font-medium">
                    {{ compileErrors.length }}
                  </span>
                </TabsTrigger>

                <!-- Diff View Tab -->
                <TabsTrigger value="diff" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>{{ t("programWindow.tabDiff", "差异比对") }}</span>
                </TabsTrigger>

                <!-- Dependencies Tab -->
                <TabsTrigger value="dependencies" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm" @click="loadDependencies">
                  <span>{{ t("programWindow.tabDependencies", "依赖关系") }}</span>
                  <span v-if="referencesList.length + referencedByList.length > 0" class="ml-1.5 rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">
                    {{ referencesList.length + referencedByList.length }}
                  </span>
                </TabsTrigger>

                <!-- Profiler Tab -->
                <TabsTrigger value="profiler" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>{{ t("programWindow.tabProfiler", "性能剖析") }}</span>
                  <span v-if="profilerResult" class="ml-1.5 rounded-full bg-purple-500/10 text-purple-600 px-1.5 py-0.2 text-[10px] font-mono font-medium"> {{ Math.round(profilerResult.totalTimeMs) }}ms </span>
                </TabsTrigger>

                <!-- Compile Logs Tab -->
                <TabsTrigger value="logs" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <span>{{ t("programWindow.tabLogs", "编译日志") }}</span>
                  <span v-if="compileLogs.length" class="ml-1.5 rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">
                    {{ compileLogs.length }}
                  </span>
                </TabsTrigger>
              </TabsList>

              <!-- Close Panel Button -->
              <Button variant="ghost" size="sm" class="h-6 w-6 p-0 text-muted-foreground hover:text-foreground" :title="t('programWindow.closeBottomPanel', '关闭底部面板')" @click="showBottomPanel = false">
                <X class="h-3.5 w-3.5" />
              </Button>
            </div>

            <!-- Tab 1: Compile Errors -->
            <TabsContent value="errors" class="m-0 flex-1 min-h-0 overflow-y-auto p-0">
              <div v-if="compileErrors.length === 0" class="flex h-24 items-center justify-center text-xs text-muted-foreground/60 italic">
                {{ t("programWindow.noCompileErrors", "无编译错误") }}
              </div>

              <div v-else class="w-full">
                <table class="w-full text-left text-xs border-collapse font-sans">
                  <thead class="sticky top-0 bg-muted/90 backdrop-blur z-10 border-b text-muted-foreground font-medium select-none">
                    <tr>
                      <th class="py-1.5 px-3 w-[70px]">{{ t("programWindow.colLine", "行号") }}</th>
                      <th class="py-1.5 px-3 w-[70px]">{{ t("programWindow.colColumn", "列号") }}</th>
                      <th class="py-1.5 px-3">{{ t("programWindow.colErrorMessage", "错误信息") }}</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y font-mono">
                    <tr v-for="(err, eIdx) in compileErrors" :key="eIdx" class="hover:bg-destructive/10 cursor-pointer text-destructive transition-colors" @click="jumpToError(err)">
                      <td class="py-1.5 px-3 font-bold underline">{{ t("programWindow.lineLabel", { line: err.line }, "Line {line}") }}</td>
                      <td class="py-1.5 px-3 text-muted-foreground">
                        {{ err.column != null ? t("programWindow.colLabel", { col: err.column }, "Col {col}") : "-" }}
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
              <div v-if="!isDirty" class="flex h-full items-center justify-center text-muted-foreground/60 italic">
                {{ t("programWindow.noDiffChanges", "当前源码与数据库现有版本一致，暂无改动差异") }}
              </div>

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
              <div v-if="compileLogs.length === 0" class="flex h-full items-center justify-center text-muted-foreground/60 italic">
                {{ t("programWindow.noCompileLogs", "暂无编译日志") }}
              </div>
              <div v-for="(log, lIdx) in compileLogs" :key="lIdx" class="leading-relaxed break-all">
                <span class="text-muted-foreground/60 mr-2 select-none">[{{ log.timestamp }}]</span>
                <span v-if="log.level === 'error'" class="text-destructive font-semibold">{{ log.text }}</span>
                <span v-else-if="log.level === 'success'" class="text-emerald-600 dark:text-emerald-400 font-medium">{{ log.text }}</span>
                <span v-else class="text-foreground">{{ log.text }}</span>
              </div>
            </TabsContent>

            <!-- Tab 4: Dependencies -->
            <TabsContent value="dependencies" class="m-0 flex-1 min-h-0 overflow-auto bg-muted/5 p-3 text-xs">
              <div v-if="dependenciesLoading" class="flex h-full items-center justify-center text-muted-foreground gap-2">
                <Loader2 class="h-4 w-4 animate-spin text-primary" />
                <span>{{ t("programWindow.loadingDependencies", "正在加载对象依赖关系...") }}</span>
              </div>

              <div v-else-if="dependenciesError" class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-destructive">
                <AlertCircle class="h-5 w-5" />
                <span class="max-w-2xl break-words">{{ dependenciesError }}</span>
                <Button variant="outline" size="sm" @click="loadDependencies">{{ t("programWindow.reloadDependencies", "重新加载依赖关系") }}</Button>
              </div>

              <div v-else class="flex flex-col h-full gap-3">
                <div class="flex items-center justify-between pb-2 border-b">
                  <span class="font-medium text-muted-foreground text-[11px]">
                    {{ t("programWindow.analyzingTarget", "分析对象:") }}
                    <strong class="text-foreground font-mono">{{ targetLabel }}</strong> ({{ props.objectType }})
                  </span>
                  <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs" :disabled="dependenciesLoading" @click="loadDependencies">
                    <RefreshCw class="h-3 w-3" :class="{ 'animate-spin': dependenciesLoading }" />
                    <span>{{ t("programWindow.refreshDependencies", "刷新依赖") }}</span>
                  </Button>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 min-h-0">
                  <!-- Left: References (Depends On) -->
                  <div class="flex flex-col border rounded-md bg-background min-h-0 overflow-hidden">
                    <div class="flex items-center justify-between bg-muted/40 px-3 py-1.5 border-b shrink-0 select-none">
                      <div class="flex items-center gap-1.5 font-medium">
                        <Code2 class="h-3.5 w-3.5 text-blue-500" />
                        <span>{{ t("programWindow.referencesTitle", "引用的对象 (Depends On)") }}</span>
                      </div>
                      <Badge variant="outline" class="text-[10px] font-mono">{{ referencesList.length }}</Badge>
                    </div>

                    <div class="flex-1 min-h-0 overflow-y-auto p-2 divide-y divide-border/40">
                      <div v-if="referencesList.length === 0" class="flex h-32 items-center justify-center text-muted-foreground/60 italic text-center p-4">
                        {{ t("programWindow.noReferences", "此对象未检测到外部引用的表、函数、包或类型") }}
                      </div>
                      <div v-for="(item, idx) in referencesList" :key="idx" class="flex items-center justify-between py-1.5 px-2 hover:bg-muted/50 rounded group transition-colors cursor-pointer" @click="jumpToObject(item)">
                        <div class="flex items-center gap-2 min-w-0 flex-1">
                          <component :is="iconForType(item.objectType)" class="h-3.5 w-3.5 shrink-0 text-primary" />
                          <span class="font-mono text-xs truncate" :title="`${item.schema}.${item.name}`">
                            <span class="text-muted-foreground text-[11px]">{{ item.schema }}.</span>
                            <span class="font-semibold text-foreground">{{ item.name }}</span>
                          </span>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                          <span v-if="item.detail" class="text-[10px] text-muted-foreground">{{ item.detail }}</span>
                          <Badge variant="secondary" class="text-[9px] uppercase font-mono px-1 py-0">{{ item.objectType }}</Badge>
                          <ExternalLink class="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- Right: Referenced By (Used By) -->
                  <div class="flex flex-col border rounded-md bg-background min-h-0 overflow-hidden">
                    <div class="flex items-center justify-between bg-muted/40 px-3 py-1.5 border-b shrink-0 select-none">
                      <div class="flex items-center gap-1.5 font-medium">
                        <Network class="h-3.5 w-3.5 text-indigo-500" />
                        <span>{{ t("programWindow.referencedByTitle", "被哪些对象引用 (Used By)") }}</span>
                      </div>
                      <Badge variant="outline" class="text-[10px] font-mono">{{ referencedByList.length }}</Badge>
                    </div>

                    <div class="flex-1 min-h-0 overflow-y-auto p-2 divide-y divide-border/40">
                      <div v-if="referencedByList.length === 0" class="flex h-32 items-center justify-center text-muted-foreground/60 italic text-center p-4">
                        {{ t("programWindow.noReferencedBy", "暂无其他存储过程、函数、包体或视图引用此对象") }}
                      </div>
                      <div v-for="(item, idx) in referencedByList" :key="idx" class="flex items-center justify-between py-1.5 px-2 hover:bg-muted/50 rounded group transition-colors cursor-pointer" @click="jumpToObject(item)">
                        <div class="flex items-center gap-2 min-w-0 flex-1">
                          <component :is="iconForType(item.objectType)" class="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                          <span class="font-mono text-xs truncate" :title="`${item.schema}.${item.name}`">
                            <span class="text-muted-foreground text-[11px]">{{ item.schema }}.</span>
                            <span class="font-semibold text-foreground">{{ item.name }}</span>
                          </span>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                          <span v-if="item.detail" class="text-[10px] text-muted-foreground">{{ item.detail }}</span>
                          <Badge variant="secondary" class="text-[9px] uppercase font-mono px-1 py-0">{{ item.objectType }}</Badge>
                          <ExternalLink class="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </TabsContent>

            <!-- Tab 5: Profiler -->
            <TabsContent value="profiler" class="m-0 flex-1 min-h-0 overflow-auto p-3 text-xs bg-background">
              <div v-if="profilerLoading" class="flex h-full items-center justify-center text-muted-foreground gap-2">
                <Loader2 class="h-5 w-5 animate-spin text-purple-500" />
                <span>{{ t("programWindow.profilerRunning", "正在执行 gms_profiler 逐行剖析中...") }}</span>
              </div>

              <div v-else-if="!profilerResult" class="flex flex-col h-full items-center justify-center p-8 gap-3 text-muted-foreground text-center">
                <Gauge class="h-10 w-10 text-purple-500/80" />
                <span class="font-semibold text-foreground text-sm">{{ t("programWindow.profilerTitle", "openGauss PL/SQL 逐行性能剖析器 (gms_profiler)") }}</span>
                <span class="text-xs max-w-md">{{ t("programWindow.profilerDescription", "在数据库内捕获存储过程或包体每行代码的实际执行次数、总耗时、平均耗时与热点占比，定位性能瓶颈。") }}</span>
                <textarea
                  v-model="profilerCallSql"
                  class="min-h-16 w-full max-w-xl resize-y rounded border bg-background px-2 py-1.5 text-left font-mono text-[11px] text-foreground outline-none focus:border-ring"
                  :placeholder="defaultProfilerCallSql()"
                  :aria-label="t('programWindow.profilerCallSqlAria', '性能剖析目标调用 SQL')"
                />
                <span class="max-w-xl text-[10px] text-muted-foreground">{{ t("programWindow.profilerArgsHint", "默认调用仅适用于无参例程；有必填参数时，请在上方调用 SQL 中补充参数。") }}</span>
                <Button size="sm" class="h-7 gap-1.5 bg-purple-600 hover:bg-purple-700 text-white font-medium shadow-sm" @click="runProfiler">
                  <Play class="h-3 w-3 fill-current" />
                  <span>{{ t("programWindow.startProfiler", "启动性能剖析") }}</span>
                </Button>
              </div>

              <div v-else class="flex flex-col h-full gap-3">
                <textarea
                  v-model="profilerCallSql"
                  class="min-h-14 w-full shrink-0 resize-y rounded border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground outline-none focus:border-ring"
                  :placeholder="defaultProfilerCallSql()"
                  :aria-label="t('programWindow.profilerCallSqlAria', '性能剖析目标调用 SQL')"
                />
                <!-- Summary Strip -->
                <div class="flex items-center justify-between p-2.5 rounded-md border bg-purple-500/5 border-purple-500/20 shrink-0">
                  <div class="flex items-center gap-3">
                    <Gauge class="h-4 w-4 text-purple-600 dark:text-purple-400" />
                    <div>
                      <span class="font-bold text-xs text-foreground">{{ profilerResult.runComment }}</span>
                      <span class="text-muted-foreground text-[11px] ml-2">({{ t("programWindow.profilerRunNumber", { id: profilerResult.runId }, "Run #{id}") }})</span>
                    </div>
                    <Badge variant="outline" class="font-mono text-[10px] border-purple-500/40 text-purple-600">
                      {{ t("programWindow.profilerTotalDuration", { duration: profilerResult.totalTimeMs.toFixed(1) }, "总耗时: {duration} ms") }}
                    </Badge>
                  </div>
                  <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-xs" @click="runProfiler">
                    <RotateCcw class="h-3 w-3 text-purple-500" />
                    <span>{{ t("programWindow.rerunProfiler", "重新剖析") }}</span>
                  </Button>
                </div>

                <!-- Units and Lines Table -->
                <div class="flex-1 min-h-0 overflow-auto border rounded-md">
                  <table class="w-full text-left text-xs border-collapse font-sans">
                    <thead class="sticky top-0 bg-muted/90 backdrop-blur z-10 border-b text-muted-foreground font-medium select-none">
                      <tr>
                        <th class="py-2 px-3 w-[70px]">{{ t("programWindow.colLine", "行号") }}</th>
                        <th class="py-2 px-3 w-[90px]">{{ t("programWindow.colExecCount", "执行次数") }}</th>
                        <th class="py-2 px-3 w-[110px]">{{ t("programWindow.colTotalTime", "总耗时") }}</th>
                        <th class="py-2 px-3 w-[110px]">{{ t("programWindow.colAvgTime", "平均耗时") }}</th>
                        <th class="py-2 px-3 w-[130px]">{{ t("programWindow.colMinMaxTime", "最小/最大耗时") }}</th>
                        <th class="py-2 px-3">{{ t("programWindow.colHeatmap", "耗时占比") }}</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y font-mono">
                      <template v-for="unit in profilerResult.units" :key="unit.unitName">
                        <tr class="bg-muted/40 font-bold font-sans text-[11px] text-foreground select-none">
                          <td colspan="6" class="py-1.5 px-3">
                            <span class="text-purple-600 mr-2">[{{ unit.unitType }}]</span>
                            <span>{{ unit.unitOwner }}.{{ unit.unitName }}</span>
                          </td>
                        </tr>
                        <tr
                          v-for="line in unit.lines"
                          :key="line.lineNumber"
                          class="hover:bg-muted/30 transition-colors"
                          :class="[line.percentage >= 60 ? 'bg-red-500/15 text-red-700 dark:text-red-300 font-semibold' : line.percentage >= 30 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : line.percentage >= 10 ? 'bg-sky-500/10' : '']"
                        >
                          <td class="py-1.5 px-3 font-bold underline cursor-pointer" @click="jumpToLine(line.lineNumber)">
                            {{ t("programWindow.lineLabel", { line: line.lineNumber }, "Line {line}") }}
                          </td>
                          <td class="py-1.5 px-3 tabular-nums">{{ line.totalOccur }}</td>
                          <td class="py-1.5 px-3 tabular-nums font-semibold">{{ formatUs(line.totalTimeUs) }}</td>
                          <td class="py-1.5 px-3 tabular-nums text-muted-foreground">{{ formatUs(line.avgTimeUs) }}</td>
                          <td class="py-1.5 px-3 tabular-nums text-muted-foreground text-[10px]">{{ formatUs(line.minTimeUs) }} / {{ formatUs(line.maxTimeUs) }}</td>
                          <td class="py-1.5 px-3">
                            <div class="flex items-center gap-2">
                              <div class="flex-1 h-2 rounded-full bg-muted overflow-hidden max-w-[200px]">
                                <div class="h-full rounded-full transition-all" :class="[line.percentage >= 60 ? 'bg-red-500' : line.percentage >= 30 ? 'bg-amber-500' : line.percentage >= 10 ? 'bg-sky-500' : 'bg-emerald-500']" :style="{ width: `${Math.min(100, Math.max(2, line.percentage))}%` }" />
                              </div>
                              <span class="text-[11px] tabular-nums font-bold">{{ line.percentage }}%</span>
                            </div>
                          </td>
                        </tr>
                      </template>
                    </tbody>
                  </table>
                </div>
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
