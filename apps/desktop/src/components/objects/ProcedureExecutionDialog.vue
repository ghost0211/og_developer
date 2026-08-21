<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Bug, Check, Copy, ExternalLink, Loader2, Play, RotateCcw, TerminalSquare } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";
import { copyToClipboard } from "@/lib/common/clipboard";
import { editorFontTheme, loadEditorTheme } from "@/lib/editor/editorThemes";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import * as langSql from "@codemirror/lang-sql";
import { loadRoutineParameters, loadRoutineReturnInfo } from "@/lib/table/routineParameters";
import { acceptsRoutineInput, buildOpenGaussRoutineDebugCallSql, buildOpenGaussRoutineExecutionSql, buildProcedureExecutionSql, buildProcedureExecutionSqlFromValues, type RoutineParameterValue, type RoutineReturnInfo } from "@/lib/table/routineExecutionSql";
import * as api from "@/lib/backend/api";
import type { DatabaseType, QueryResult } from "@/types/database";

const { t } = useI18n();
const { toast } = useToast();
const { isDark, themePalette } = useTheme();
const settingsStore = useSettingsStore();

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  connectionId: string;
  database: string;
  databaseType?: DatabaseType;
  schema?: string;
  routineName: string;
  routineKind?: "procedure" | "function";
  /** identity arguments（pg_get_function_identity_arguments），用于同名重载的精确匹配 */
  signature?: string;
}>();

const emit = defineEmits<{
  execute: [sql: string];
  openSql: [sql: string];
  debug: [sql: string];
}>();

// --- State ---
const loading = ref(false);
const executing = ref(false);
const loadError = ref("");
const parametersLoaded = ref(false);
const parameters = ref<RoutineParameterValue[]>([]);
const functionReturn = ref<RoutineReturnInfo | null>(null);
const outputResults = ref<Record<string, string>>({});
const serverLogs = ref<string[]>([]);
const resultData = ref<QueryResult | null>(null);
const activeTab = ref<"variables" | "output" | "result">("variables");
const executionStats = ref<{ durationMs?: number; affectedRows?: number; error?: string } | null>(null);

const manualSqlDirty = ref(false);
let loadToken = 0;
let editorInitSeq = 0;
// 程序化写入编辑器（参数同步/重置）不算用户修改，否则会永久阻断后续同步
let applyingProgrammaticEdit = false;

// Splitpanes memory
const splitpanesSize = ref(45);

// CodeMirror
const editorContainer = ref<HTMLDivElement>();
const editorView = shallowRef<EditorView | null>(null);

const isOpenGaussRoutine = computed(() => props.databaseType === "opengauss" || props.databaseType === "gaussdb");

const generatedSql = computed(() => {
  if (isOpenGaussRoutine.value) {
    return buildOpenGaussRoutineExecutionSql({
      databaseType: props.databaseType,
      schema: props.schema,
      routineName: props.routineName,
      parameters: parameters.value,
      isFunction: props.routineKind === "function",
      functionReturn: functionReturn.value,
    });
  }
  if (parameters.value.length) {
    return buildProcedureExecutionSqlFromValues({
      databaseType: props.databaseType,
      schema: props.schema,
      routineName: props.routineName,
      parameters: parameters.value,
    });
  }
  return buildProcedureExecutionSql({
    databaseType: props.databaseType,
    schema: props.schema,
    routineName: props.routineName,
  });
});

const openGaussDebugCallSql = computed(() =>
  buildOpenGaussRoutineDebugCallSql({
    databaseType: props.databaseType,
    schema: props.schema,
    routineName: props.routineName,
    parameters: parameters.value,
  }),
);

const inputParameterCount = computed(() => parameters.value.filter(acceptsRoutineInput).length);
const outputParameterCount = computed(() => parameters.value.filter((p) => p.mode === "OUT" || p.mode === "INOUT").length);

// Watch open / targets to reload
watch(
  () => [open.value, props.connectionId, props.database, props.databaseType, props.schema, props.routineName] as const,
  ([isOpen]) => {
    if (!isOpen || !props.connectionId || !props.database || !props.routineName) return;
    void refreshParameters();
  },
  { immediate: true },
);

watch(
  () => [parameters.value] as const,
  () => {
    if (!manualSqlDirty.value) {
      updateEditorText(generatedSql.value);
    }
  },
  { deep: true },
);

// Watch theme & font changes
watch([isDark, themePalette, () => settingsStore.editorSettings.theme, () => settingsStore.editorSettings.fontFamily, () => settingsStore.editorSettings.fontSize], () => {
  if (editorView.value) {
    const currentText = getEditorText();
    void initEditor(currentText);
  }
});

async function refreshParameters() {
  const token = ++loadToken;
  loading.value = true;
  loadError.value = "";
  parameters.value = [];
  outputResults.value = {};
  serverLogs.value = [];
  resultData.value = null;
  executionStats.value = null;
  parametersLoaded.value = false;
  manualSqlDirty.value = false;

  try {
    const loaded = await loadRoutineParameters({
      connectionId: props.connectionId,
      database: props.database,
      databaseType: props.databaseType,
      schema: props.schema,
      routineName: props.routineName,
      routineKind: props.routineKind,
      signature: props.signature,
    });
    if (token !== loadToken) return;

    // 函数额外探测返回形态：标量返回用变量接收 + NOTICE 回显
    functionReturn.value =
      props.routineKind === "function"
        ? await loadRoutineReturnInfo({
            connectionId: props.connectionId,
            database: props.database,
            databaseType: props.databaseType,
            schema: props.schema,
            routineName: props.routineName,
            routineKind: props.routineKind,
            signature: props.signature,
          })
        : null;
    if (token !== loadToken) return;

    parameters.value = loaded.map((parameter) => ({
      ...parameter,
      value: "",
      useNull: false,
      useDefault: !!parameter.hasDefault,
    }));
    parametersLoaded.value = true;
    await nextTick();
    void initEditor(generatedSql.value);
  } catch (e: any) {
    if (token !== loadToken) return;
    loadError.value = e?.message || String(e);
    await nextTick();
    void initEditor(generatedSql.value);
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

async function initEditor(text: string) {
  const seq = ++editorInitSeq;
  if (!editorContainer.value) return;
  if (editorView.value) {
    editorView.value.destroy();
    editorView.value = null;
  }

  const settings = settingsStore.editorSettings;
  const themeExt = await loadEditorTheme(settings.theme, isDark.value ? "dark" : "light", undefined, themePalette.value);
  // 主题加载是异步的：若期间发起了更新的 initEditor（例如参数加载完成后），
  // 本次初始化必须放弃，否则旧文本会覆盖新文本。
  if (seq !== editorInitSeq) return;
  if (!editorContainer.value) return;
  const fontExt = editorFontTheme(EditorView, settings.fontSize, settings.fontFamily, { scrollable: true });
  const dialect = createDbxCodeMirrorSqlDialect(langSql, "postgres", props.databaseType || "opengauss");

  const startState = EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      langSql.sql({ dialect }),
      themeExt,
      fontExt,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingProgrammaticEdit) {
          manualSqlDirty.value = true;
        }
      }),
      EditorView.theme({
        "&": { height: "100%" },
        ".cm-scroller": { overflow: "auto" },
      }),
    ],
  });

  editorView.value = new EditorView({
    state: startState,
    parent: editorContainer.value,
  });
}

function getEditorText(): string {
  return editorView.value?.state.doc.toString() ?? "";
}

function updateEditorText(text: string) {
  if (!editorView.value) {
    void initEditor(text);
    return;
  }
  const current = editorView.value.state.doc.toString();
  if (current !== text) {
    applyingProgrammaticEdit = true;
    try {
      editorView.value.dispatch({
        changes: { from: 0, to: current.length, insert: text },
      });
    } finally {
      applyingProgrammaticEdit = false;
    }
  }
}

function resetSqlScript() {
  manualSqlDirty.value = false;
  updateEditorText(generatedSql.value);
  toast(t("contextMenu.resetSqlPreview"), 1500);
}

async function copyScript() {
  const code = getEditorText();
  if (!code) return;
  await copyToClipboard(code);
  toast(t("common.copied"), 1500);
}

function canEditParameter(parameter: RoutineParameterValue): boolean {
  return acceptsRoutineInput(parameter);
}

// --- Execution & Notice parsing ---
async function runTestExecution() {
  const sql = getEditorText().trim();
  if (!sql) return;

  executing.value = true;
  executionStats.value = null;
  outputResults.value = {};
  serverLogs.value = [];
  resultData.value = null;

  const startTime = performance.now();

  try {
    const res = await api.executeQuery(props.connectionId, props.database, sql, props.schema);
    const durationMs = Math.round(performance.now() - startTime);

    executionStats.value = {
      durationMs,
      affectedRows: res.affected_rows,
    };
    resultData.value = res;

    // Collect Notice messages & parse [DBX_OUT] tags
    if (res.messages && res.messages.length > 0) {
      const logs: string[] = [];
      const parsedOut: Record<string, string> = {};

      for (const msg of res.messages) {
        logs.push(msg);
        // Look for pattern: [DBX_OUT] <param_name>=<value>
        const match = msg.match(/\[DBX_OUT\]\s+([^=]+)=(.*)$/);
        if (match) {
          const varName = match[1].trim();
          const varVal = match[2].trim();
          parsedOut[varName] = varVal;
        }
      }

      serverLogs.value = logs;
      outputResults.value = parsedOut;

      // If OUT parameters parsed, keep variable tab or switch to output if logs exist
      if (Object.keys(parsedOut).length > 0) {
        // Updated OUT variables will be visible in the variables table
      }
    }

    // If query returned tabular rows, switch to result tab
    if (res.columns && res.columns.length > 0 && res.rows && res.rows.length > 0) {
      activeTab.value = "result";
    } else if (serverLogs.value.length > 0 && Object.keys(outputResults.value).length === 0) {
      activeTab.value = "output";
    }
  } catch (err: any) {
    const durationMs = Math.round(performance.now() - startTime);
    executionStats.value = {
      durationMs,
      error: err?.message || String(err),
    };
    serverLogs.value.push(`[ERROR] ${err?.message || String(err)}`);
    activeTab.value = "output";
  } finally {
    executing.value = false;
  }
}

function openInSqlEditor() {
  const sql = getEditorText().trim();
  if (!sql) return;
  open.value = false;
  emit("openSql", sql);
}

function startDebugging() {
  const sql = (isOpenGaussRoutine.value ? openGaussDebugCallSql.value : getEditorText()).trim();
  if (!sql) return;
  open.value = false;
  emit("debug", sql);
}

function close() {
  open.value = false;
}

onMounted(() => {
  if (open.value && props.routineName) {
    void refreshParameters();
  }
});

onUnmounted(() => {
  if (editorView.value) {
    editorView.value.destroy();
    editorView.value = null;
  }
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[88vh] max-h-[900px] flex-col gap-0 overflow-hidden border border-border !bg-background p-0 text-foreground shadow-2xl !backdrop-blur-none sm:max-w-[920px]">
      <!-- Header -->
      <DialogHeader class="border-b px-4 py-3 shrink-0">
        <div class="flex items-center justify-between gap-3 pr-6">
          <div class="flex items-center gap-2 min-w-0">
            <TerminalSquare class="h-4 w-4 text-primary shrink-0" />
            <DialogTitle class="text-base font-semibold truncate">
              {{ t("contextMenu.confirmExecuteProcedureTitle") }}
            </DialogTitle>
            <Badge variant="outline" class="font-mono text-xs">
              {{ props.schema ? `${props.schema}.${props.routineName}` : props.routineName }}
            </Badge>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <Badge v-if="inputParameterCount" variant="secondary" class="text-xs">
              {{ t("contextMenu.inputParameters", { count: inputParameterCount }) }}
            </Badge>
            <Badge v-if="outputParameterCount" variant="outline" class="text-xs border-primary/40 text-primary">
              {{ t("contextMenu.outputParameters", { count: outputParameterCount }) }}
            </Badge>
          </div>
        </div>
      </DialogHeader>

      <!-- Main Action Toolbar -->
      <div class="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5 text-xs shrink-0">
        <div class="flex items-center gap-1.5">
          <Button size="sm" class="h-7 gap-1.5 px-3 font-medium shadow-sm" :disabled="executing || loading" @click="runTestExecution">
            <Loader2 v-if="executing" class="h-3.5 w-3.5 animate-spin" />
            <Play v-else class="h-3.5 w-3.5 fill-current text-emerald-500" />
            <span>{{ t("contextMenu.executeProcedure") }}</span>
            <kbd class="ml-1 rounded bg-primary-foreground/20 px-1 py-0.2 text-[10px] text-primary-foreground">F8</kbd>
          </Button>

          <Button v-if="props.databaseType === 'opengauss' || props.databaseType === 'gaussdb'" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5" :disabled="executing || loading" @click="startDebugging">
            <Bug class="h-3.5 w-3.5 text-amber-500" />
            <span>{{ t("contextMenu.debugProcedure") }}</span>
          </Button>

          <Button variant="ghost" size="sm" class="h-7 gap-1.5 px-2" @click="openInSqlEditor">
            <ExternalLink class="h-3.5 w-3.5 text-muted-foreground" />
            <span>{{ t("contextMenu.openInSqlEditor") }}</span>
          </Button>
        </div>

        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" :disabled="!manualSqlDirty" @click="resetSqlScript">
            <RotateCcw class="h-3.5 w-3.5" />
            <span>{{ t("contextMenu.resetSqlPreview") }}</span>
          </Button>
          <Button variant="ghost" size="sm" class="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" @click="copyScript">
            <Copy class="h-3.5 w-3.5" />
            <span>{{ t("common.copy") }}</span>
          </Button>
        </div>
      </div>

      <!-- Split Layout Area (Top: CodeBlock, Bottom: Tabs) -->
      <div class="flex-1 min-h-0 relative">
        <Splitpanes horizontal class="test-window-splitpanes h-full w-full" @resized="splitpanesSize = $event.panes?.[0]?.size ?? 45">
          <!-- Upper Editor Pane -->
          <Pane :size="splitpanesSize" min-size="20" class="flex flex-col min-h-0 bg-background">
            <div class="flex items-center justify-between border-b bg-muted/20 px-3 py-1 text-[11px] font-medium text-muted-foreground shrink-0 select-none">
              <span>PL/SQL Anonymous Block</span>
              <span v-if="manualSqlDirty" class="text-amber-500 font-mono text-[10px]">* modified</span>
            </div>
            <div ref="editorContainer" class="flex-1 min-h-0 overflow-hidden" />
          </Pane>

          <!-- Lower Tabs Pane -->
          <Pane :size="100 - splitpanesSize" min-size="25" class="flex flex-col min-h-0 border-t bg-background">
            <Tabs v-model="activeTab" class="flex h-full flex-col min-h-0">
              <div class="flex items-center justify-between border-b bg-muted/30 px-3 shrink-0">
                <TabsList class="h-8 bg-transparent p-0 gap-1">
                  <TabsTrigger value="variables" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                    变量与参数
                    <span v-if="parameters.length" class="ml-1.5 rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono">
                      {{ parameters.length }}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger value="output" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                    DBMS / Notice 输出
                    <span v-if="serverLogs.length" class="ml-1.5 rounded-full bg-primary/10 text-primary px-1.5 py-0.2 text-[10px] font-mono font-medium">
                      {{ serverLogs.length }}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger value="result" class="h-7 px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
                    结果集
                    <span v-if="resultData?.rows?.length" class="ml-1.5 rounded-full bg-emerald-500/10 text-emerald-600 px-1.5 py-0.2 text-[10px] font-mono font-medium">
                      {{ resultData.rows.length }}
                    </span>
                  </TabsTrigger>
                </TabsList>

                <!-- Status indicators -->
                <div v-if="executionStats" class="flex items-center gap-3 text-[11px] font-mono">
                  <span v-if="executionStats.error" class="text-destructive flex items-center gap-1 font-sans"> 执行失败 </span>
                  <span v-else class="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                    <Check class="h-3 w-3" />
                    执行成功
                  </span>
                  <span class="text-muted-foreground">{{ executionStats.durationMs }}ms</span>
                </div>
              </div>

              <!-- Tab Content: Variables Grid -->
              <TabsContent value="variables" class="m-0 flex-1 min-h-0 overflow-y-auto p-0">
                <div v-if="loading" class="flex items-center justify-center p-8 text-sm text-muted-foreground gap-2">
                  <Loader2 class="h-4 w-4 animate-spin" />
                  {{ t("contextMenu.loadingProcedureParameters") }}
                </div>

                <div v-else-if="parameters.length" class="w-full">
                  <table class="w-full text-left text-xs border-collapse font-sans">
                    <thead class="sticky top-0 bg-muted/90 backdrop-blur z-10 border-b text-muted-foreground font-medium select-none">
                      <tr>
                        <th class="py-2 px-3 w-[150px]">{{ t("contextMenu.parameterName") }}</th>
                        <th class="py-2 px-3 w-[120px]">{{ t("contextMenu.parameterType") }}</th>
                        <th class="py-2 px-3 w-[70px]">{{ t("contextMenu.parameterMode") }}</th>
                        <th class="py-2 px-3">{{ t("contextMenu.parameterValue") }}</th>
                        <th class="py-2 px-3 w-[160px]">输出回显 (Out Result)</th>
                        <th class="py-2 px-2 w-[50px] text-center">{{ t("contextMenu.parameterNull") }}</th>
                        <th class="py-2 px-2 w-[60px] text-center">Default</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y font-mono">
                      <tr v-for="parameter in parameters" :key="`${parameter.ordinal}:${parameter.name}`" class="hover:bg-muted/40 transition-colors">
                        <td class="py-1.5 px-3 font-medium text-foreground truncate font-sans">
                          {{ parameter.name }}
                        </td>
                        <td class="py-1.5 px-3 text-muted-foreground truncate">
                          {{ parameter.dataType || "-" }}
                        </td>
                        <td class="py-1.5 px-3 font-sans">
                          <span
                            :class="[
                              'inline-block px-1.5 py-0.5 rounded text-[10px] font-medium',
                              parameter.mode === 'IN' ? 'bg-muted text-muted-foreground' : parameter.mode === 'OUT' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20',
                            ]"
                          >
                            {{ parameter.mode }}
                          </span>
                        </td>
                        <td class="py-1 px-3">
                          <Input
                            v-model="parameter.value"
                            class="h-7 font-mono text-xs bg-background"
                            :disabled="!canEditParameter(parameter) || parameter.useNull || parameter.useDefault"
                            :placeholder="canEditParameter(parameter) ? t('contextMenu.parameterValuePlaceholder') : t('contextMenu.outputOnly')"
                          />
                        </td>
                        <td class="py-1.5 px-3">
                          <span v-if="outputResults[parameter.name] !== undefined" class="font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded text-xs inline-block max-w-[150px] truncate" :title="outputResults[parameter.name]">
                            {{ outputResults[parameter.name] }}
                          </span>
                          <span v-else-if="parameter.mode === 'OUT' || parameter.mode === 'INOUT'" class="text-muted-foreground/60 italic text-[11px]"> (待执行) </span>
                          <span v-else class="text-muted-foreground/40">-</span>
                        </td>
                        <td class="py-1.5 px-2 text-center">
                          <input type="checkbox" class="h-3.5 w-3.5 accent-primary cursor-pointer" :checked="!!parameter.useNull" :disabled="!canEditParameter(parameter) || parameter.useDefault" @change="(e: Event) => (parameter.useNull = (e.target as HTMLInputElement).checked)" />
                        </td>
                        <td class="py-1.5 px-2 text-center">
                          <input
                            type="checkbox"
                            class="h-3.5 w-3.5 accent-primary cursor-pointer"
                            :checked="!!parameter.useDefault"
                            :disabled="!canEditParameter(parameter) || !parameter.hasDefault || parameter.useNull"
                            @change="(e: Event) => (parameter.useDefault = (e.target as HTMLInputElement).checked)"
                          />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div v-else-if="loadError" class="p-4 text-xs text-destructive">
                  {{ loadError }}
                </div>
                <div v-else class="p-6 text-center text-xs text-muted-foreground">
                  {{ t("contextMenu.noParameters") }}
                </div>
              </TabsContent>

              <!-- Tab Content: Server Output / Notices -->
              <TabsContent value="output" class="m-0 flex-1 min-h-0 overflow-y-auto bg-muted/10 p-3 font-mono text-xs">
                <div v-if="serverLogs.length > 0" class="space-y-1">
                  <div v-for="(log, idx) in serverLogs" :key="idx" class="leading-relaxed break-all">
                    <span v-if="log.startsWith('[ERROR]')" class="text-destructive font-semibold">{{ log }}</span>
                    <span v-else-if="log.includes('[DBX_OUT]')" class="text-emerald-600 dark:text-emerald-400">{{ log }}</span>
                    <span v-else class="text-foreground">{{ log }}</span>
                  </div>
                </div>
                <div v-else class="flex h-full items-center justify-center text-muted-foreground/60 italic">无 Server Output / RAISE NOTICE 打印日志</div>
              </TabsContent>

              <!-- Tab Content: Result Sets -->
              <TabsContent value="result" class="m-0 flex-1 min-h-0 overflow-auto p-0">
                <div v-if="resultData?.columns?.length && resultData?.rows?.length" class="w-full">
                  <table class="w-full text-left text-xs border-collapse font-mono">
                    <thead class="sticky top-0 bg-muted/90 backdrop-blur z-10 border-b text-muted-foreground font-medium select-none">
                      <tr>
                        <th class="py-2 px-3 w-[48px] text-center text-[10px] text-muted-foreground/60 border-r">#</th>
                        <th v-for="col in resultData.columns" :key="col" class="py-2 px-3 border-r last:border-r-0">
                          {{ col }}
                        </th>
                      </tr>
                    </thead>
                    <tbody class="divide-y">
                      <tr v-for="(row, rIdx) in resultData.rows" :key="rIdx" class="hover:bg-muted/40 transition-colors">
                        <td class="py-1 px-2 text-center text-[10px] text-muted-foreground/60 bg-muted/20 border-r select-none">
                          {{ rIdx + 1 }}
                        </td>
                        <td v-for="(cell, cIdx) in row" :key="cIdx" class="py-1 px-3 border-r last:border-r-0 truncate max-w-[200px]" :title="String(cell ?? '')">
                          <span v-if="cell === null" class="text-muted-foreground/50 italic">NULL</span>
                          <span v-else>{{ cell }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-else class="flex h-full items-center justify-center text-muted-foreground/60 italic p-6">未返回结果集表格</div>
              </TabsContent>
            </Tabs>
          </Pane>
        </Splitpanes>
      </div>

      <!-- Footer -->
      <div class="flex items-center justify-between border-t bg-muted/20 px-4 py-2 text-xs shrink-0">
        <div class="text-muted-foreground flex items-center gap-2">
          <span>{{ props.routineKind === "function" ? "函数 (Function)" : "存储过程 (Procedure)" }}</span>
          <span v-if="props.signature" class="font-mono text-[10px] text-muted-foreground/70">({{ props.signature }})</span>
        </div>
        <Button variant="outline" size="sm" class="h-7 px-3" @click="close">
          {{ t("dangerDialog.cancel") }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
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
