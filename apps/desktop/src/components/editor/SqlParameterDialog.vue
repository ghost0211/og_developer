<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Braces, Copy, FileCode, RotateCcw, Save, Trash2, WandSparkles, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import TruncatedTextTooltip from "@/components/ui/TruncatedTextTooltip.vue";
import { deleteSqlParameterPreset, inferSqlParameterKind, loadSqlParameterHistory, loadSqlParameterPresets, rememberSqlParameterValues, removeSqlParameterHistoryEntry, saveSqlParameterPreset, type SqlParameterPreset } from "@/lib/sql/sqlParameterHistory";
import { formatSqlForDisplay, sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { substituteSqlParameters, type SqlParameterDescriptor, type SqlParameterInput, type SqlParameterSyntax, type SqlParameterValueKind } from "@/lib/sql/sqlParameters";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { DatabaseType } from "@/types/database";

const { t } = useI18n();
const { highlight } = useSqlHighlighter();
const { toast } = useToast();

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  sql: string;
  parameters: SqlParameterDescriptor[];
  databaseType?: DatabaseType;
  enabledSyntaxes?: SqlParameterSyntax[];
}>();

const emit = defineEmits<{
  execute: [sql: string];
  replaceInEditor: [sql: string];
}>();

const values = ref<Record<string, SqlParameterInput>>({});
const histories = ref<Record<string, SqlParameterInput[]>>({});
const presets = ref<SqlParameterPreset[]>([]);
const selectedPresetId = ref("");
const savePresetOpen = ref(false);
const presetNameDraft = ref("");
const formatPreview = ref(false);
const formattedResolvedSql = ref("");
const activeHistoryName = ref("");
let closeHistoryTimer: ReturnType<typeof setTimeout> | undefined;
let formatRequestSeq = 0;

const parameterKinds: SqlParameterValueKind[] = ["string", "number", "boolean", "null", "raw"];

const syntaxLabels: Record<SqlParameterSyntax, string> = {
  positional: "?",
  postgres: "$n",
  named: ":name",
  shell: "${name}",
  mybatis: "#{name}",
  sqlserver: "@name",
};

const currentParameterKeys = computed(() => props.parameters.map((parameter) => parameter.key));
const currentSqlSignature = computed(() =>
  props.parameters
    .map((parameter) => parameter.key.trim().toLowerCase())
    .sort()
    .join(","),
);

const resolvedSql = computed(() => substituteSqlParameters(props.sql, values.value, { databaseType: props.databaseType, enabledSyntaxes: props.enabledSyntaxes }));
const previewSql = computed(() => (formatPreview.value ? formattedResolvedSql.value || resolvedSql.value : resolvedSql.value));
const highlightedSql = computed(() => highlight(previewSql.value));

function refreshPresets() {
  const loaded = loadSqlParameterPresets(currentParameterKeys.value);
  presets.value = loaded;
  if (selectedPresetId.value && !loaded.some((preset) => preset.id === selectedPresetId.value)) {
    selectedPresetId.value = "";
  }
}

watch(
  () => [open.value, props.parameters] as const,
  ([isOpen]) => {
    if (!isOpen) {
      savePresetOpen.value = false;
      activeHistoryName.value = "";
      return;
    }
    const next: Record<string, SqlParameterInput> = {};
    const nextHistories: Record<string, SqlParameterInput[]> = {};
    for (const parameter of props.parameters) {
      const history = loadSqlParameterHistory(parameter.key);
      nextHistories[parameter.key] = history;
      const existing = values.value[parameter.key];
      const hasExistingValue = existing && (existing.kind === "null" || existing.value !== "");
      next[parameter.key] = hasExistingValue ? existing : (history[0] ?? { kind: "string", value: "" });
    }
    values.value = next;
    histories.value = nextHistories;
    refreshPresets();
  },
  { immediate: true },
);

watch(
  () => [open.value, formatPreview.value, resolvedSql.value, props.databaseType] as const,
  async ([isOpen, shouldFormat, rawSql, dbType]) => {
    const seq = ++formatRequestSeq;
    if (!isOpen || !shouldFormat) {
      formattedResolvedSql.value = rawSql;
      return;
    }
    const formatted = await formatSqlForDisplay(rawSql, sqlFormatDialectForDbType(dbType));
    if (seq === formatRequestSeq) {
      formattedResolvedSql.value = formatted;
    }
  },
  { immediate: true },
);

function updateKind(name: string, kind: SqlParameterValueKind) {
  const current = values.value[name] ?? { value: "" };
  const value = kind === "null" ? "NULL" : current.kind === "null" ? "" : current.value;
  values.value[name] = { ...current, kind, value };
}

function updateValue(name: string, value: string) {
  const matchedHistory = histories.value[name]?.find((entry) => entry.value === value);
  values.value[name] = { ...(values.value[name] ?? { kind: "string" }), ...(matchedHistory ? { kind: matchedHistory.kind } : {}), value };
}

function filteredSqlParameterHistory(name: string): SqlParameterInput[] {
  const history = histories.value[name] ?? [];
  const query = values.value[name]?.value?.trim().toLowerCase() ?? "";
  if (!query) return history;
  return history.filter((entry) => entry.value.toLowerCase().includes(query));
}

function focusParameterInput(name: string, event: FocusEvent) {
  if (closeHistoryTimer) clearTimeout(closeHistoryTimer);
  activeHistoryName.value = name;
  const input = event.target as HTMLInputElement;
  void nextTick(() => input.focus());
}

function closeParameterHistory(name: string) {
  closeHistoryTimer = setTimeout(() => {
    if (activeHistoryName.value === name) activeHistoryName.value = "";
  }, 120);
}

function selectHistoryEntry(name: string, entry: SqlParameterInput) {
  if (closeHistoryTimer) clearTimeout(closeHistoryTimer);
  values.value[name] = { ...entry };
  activeHistoryName.value = "";
}

function deleteHistoryEntry(name: string, entry: SqlParameterInput) {
  if (closeHistoryTimer) clearTimeout(closeHistoryTimer);
  const nextList = removeSqlParameterHistoryEntry(name, entry);
  histories.value = { ...histories.value, [name]: nextList };
  if (nextList.length === 0 && activeHistoryName.value === name) {
    activeHistoryName.value = "";
  }
}

function applyPresetById(presetId: string) {
  const preset = presets.value.find((item) => item.id === presetId);
  if (!preset) return;
  selectedPresetId.value = presetId;

  const byNormalizedKey = new Map<string, SqlParameterInput>();
  for (const [key, input] of Object.entries(preset.values)) {
    byNormalizedKey.set(key.trim().toLowerCase(), input);
  }

  const nextValues: Record<string, SqlParameterInput> = { ...values.value };
  for (const parameter of props.parameters) {
    const matched = preset.values[parameter.key] ?? byNormalizedKey.get(parameter.key.trim().toLowerCase());
    if (matched) {
      nextValues[parameter.key] = { ...matched };
    }
  }
  values.value = nextValues;
}

function prepareSavePreset() {
  const selected = presets.value.find((item) => item.id === selectedPresetId.value);
  presetNameDraft.value = selected?.name ?? "";
  void nextTick(() => {
    const inputEl = document.getElementById("sql-parameter-preset-name-input") as HTMLInputElement | null;
    inputEl?.focus();
    inputEl?.select();
  });
}

function confirmSavePreset() {
  const trimmed = presetNameDraft.value.trim();
  if (!trimmed) return;
  saveSqlParameterPreset(trimmed, values.value, currentSqlSignature.value);
  refreshPresets();
  const saved = presets.value.find((item) => item.name.trim().toLowerCase() === trimmed.toLowerCase());
  if (saved) {
    selectedPresetId.value = saved.id;
  }
  savePresetOpen.value = false;
  toast(t("sqlParameters.presetSaved", "已保存参数预设"));
}

function removeSelectedPreset() {
  if (!selectedPresetId.value) return;
  deleteSqlParameterPreset(selectedPresetId.value);
  selectedPresetId.value = "";
  refreshPresets();
  toast(t("sqlParameters.presetDeleted", "已删除参数预设"));
}

function inferAllParameterKinds() {
  const nextValues: Record<string, SqlParameterInput> = { ...values.value };
  for (const parameter of props.parameters) {
    const current = nextValues[parameter.key];
    if (!current || (current.kind !== "null" && !current.value.trim())) continue;
    const inferredKind = current.kind === "null" ? "null" : inferSqlParameterKind(current.value);
    nextValues[parameter.key] = {
      kind: inferredKind,
      value: inferredKind === "null" ? "NULL" : current.value.trim(),
    };
  }
  values.value = nextValues;
}

function clearCurrentValues() {
  const cleared: Record<string, SqlParameterInput> = {};
  for (const parameter of props.parameters) {
    cleared[parameter.key] = { kind: "string", value: "" };
  }
  values.value = cleared;
  selectedPresetId.value = "";
}

function persistCurrentParameterHistory() {
  histories.value = { ...histories.value, ...rememberSqlParameterValues(values.value) };
}

async function resolveOutputSql(): Promise<string> {
  if (!formatPreview.value) return resolvedSql.value;
  const formatted = await formatSqlForDisplay(resolvedSql.value, sqlFormatDialectForDbType(props.databaseType));
  formattedResolvedSql.value = formatted;
  return formatted;
}

function execute() {
  persistCurrentParameterHistory();
  open.value = false;
  emit("execute", resolvedSql.value);
}

async function copyExecutableSql() {
  try {
    const sqlToCopy = await resolveOutputSql();
    persistCurrentParameterHistory();
    await copyToClipboard(sqlToCopy);
    toast(t("sqlParameters.copiedExecutableSql", "已复制可执行 SQL"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function replaceInEditor() {
  const sqlToReplace = await resolveOutputSql();
  persistCurrentParameterHistory();
  open.value = false;
  emit("replaceInEditor", sqlToReplace);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[86vh] border border-border !bg-background text-foreground shadow-2xl !backdrop-blur-none sm:max-w-[760px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Braces class="h-5 w-5 text-primary" />
          {{ t("sqlParameters.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="grid max-h-[calc(86vh-8rem)] gap-3.5 overflow-y-auto pr-1">
        <p class="text-sm text-muted-foreground">{{ t("sqlParameters.description") }}</p>

        <div class="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-2">
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <Select :model-value="selectedPresetId" :disabled="presets.length === 0" @update:model-value="(value) => applyPresetById(String(value))">
              <SelectTrigger class="h-7 w-[220px] bg-background text-xs">
                <SelectValue :placeholder="presets.length ? t('sqlParameters.selectPreset', '选择参数预设…') : t('sqlParameters.noPresets', '暂无参数预设')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="preset in presets" :key="preset.id" :value="preset.id" class="text-xs">
                  <div class="flex w-full items-center justify-between gap-2">
                    <span class="truncate">{{ preset.name }}</span>
                    <Badge variant="secondary" class="h-4 shrink-0 px-1.5 font-mono text-[10px]"> {{ preset.matchedCount ?? 0 }}/{{ parameters.length }} </Badge>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>

            <Popover v-model:open="savePresetOpen">
              <PopoverTrigger as-child>
                <Button type="button" variant="outline" size="sm" class="h-7 px-2.5 text-xs" @click="prepareSavePreset">
                  <Save class="mr-1 h-3.5 w-3.5" />
                  {{ t("sqlParameters.savePreset", "保存预设") }}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" class="z-[80] w-64 space-y-2 p-2.5">
                <div class="text-xs font-medium">{{ t("sqlParameters.savePresetTitle", "保存当前参数为预设") }}</div>
                <Input id="sql-parameter-preset-name-input" v-model="presetNameDraft" class="h-8 text-xs" autocomplete="off" :placeholder="t('sqlParameters.presetNamePlaceholder', '输入预设名称')" @keydown.enter.prevent="confirmSavePreset" />
                <div class="flex justify-end gap-1.5">
                  <Button type="button" variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="savePresetOpen = false">
                    {{ t("dangerDialog.cancel") }}
                  </Button>
                  <Button type="button" size="sm" class="h-7 px-2.5 text-xs" :disabled="!presetNameDraft.trim()" @click="confirmSavePreset">
                    {{ t("sqlParameters.confirmSavePreset", "保存") }}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>

            <Button v-if="selectedPresetId" type="button" variant="ghost" size="sm" class="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" :title="t('sqlParameters.deletePreset', '删除当前预设')" @click="removeSelectedPreset">
              <Trash2 class="h-3.5 w-3.5" />
            </Button>
          </div>

          <div class="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" class="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" :title="t('sqlParameters.inferTypesHint', '根据输入值自动识别 NULL、布尔值、数字与 SQL 表达式')" @click="inferAllParameterKinds">
              <WandSparkles class="mr-1 h-3.5 w-3.5" />
              {{ t("sqlParameters.inferTypes", "智能推断类型") }}
            </Button>
            <Button type="button" variant="ghost" size="sm" class="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" @click="clearCurrentValues">
              <RotateCcw class="mr-1 h-3.5 w-3.5" />
              {{ t("sqlParameters.clearValues", "清空当前值") }}
            </Button>
          </div>
        </div>

        <div class="relative z-20 max-h-[280px] overflow-auto rounded-md border bg-background">
          <div class="min-w-[680px]">
            <div class="sticky top-0 z-10 grid grid-cols-[minmax(140px,1fr)_104px_132px_minmax(180px,1.5fr)] border-b bg-muted px-3 py-2 text-xs font-medium text-muted-foreground">
              <div>{{ t("sqlParameters.name") }}</div>
              <div>{{ t("sqlParameters.syntax") }}</div>
              <div>{{ t("sqlParameters.type") }}</div>
              <div>{{ t("sqlParameters.value") }}</div>
            </div>
            <div v-for="parameter in parameters" :key="parameter.key" class="grid grid-cols-[minmax(140px,1fr)_104px_132px_minmax(180px,1.5fr)] items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0">
              <div class="min-w-0 truncate font-mono text-xs">{{ parameter.name }}</div>
              <div class="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{{ syntaxLabels[parameter.syntax] }}</div>
              <Select :model-value="values[parameter.key]?.kind || 'string'" @update:model-value="(value) => updateKind(parameter.key, value as SqlParameterValueKind)">
                <SelectTrigger class="h-8 bg-background text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="kind in parameterKinds" :key="kind" :value="kind">
                    {{ t(`sqlParameters.kind.${kind}`) }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <div class="relative min-w-0">
                <Popover :open="activeHistoryName === parameter.key && filteredSqlParameterHistory(parameter.key).length > 0">
                  <PopoverAnchor as-child>
                    <Input
                      :model-value="values[parameter.key]?.value || ''"
                      class="h-8 bg-background font-mono text-xs"
                      :disabled="values[parameter.key]?.kind === 'null'"
                      autocomplete="off"
                      data-lpignore="true"
                      data-form-type="other"
                      :placeholder="t('sqlParameters.valuePlaceholder')"
                      @focus="focusParameterInput(parameter.key, $event)"
                      @blur="closeParameterHistory(parameter.key)"
                      @update:model-value="(value) => updateValue(parameter.key, String(value))"
                    />
                  </PopoverAnchor>
                  <PopoverContent align="start" side="bottom" class="z-[80] w-[var(--reka-popover-trigger-width)] max-h-40 gap-0 overflow-auto p-1" @open-auto-focus.prevent>
                    <div
                      v-for="entry in filteredSqlParameterHistory(parameter.key)"
                      :key="`${entry.kind}:${entry.value}`"
                      role="option"
                      class="group flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                      @mousedown.prevent="selectHistoryEntry(parameter.key, entry)"
                    >
                      <TruncatedTextTooltip :text="entry.value" class="min-w-0 flex-1 font-mono" side="top" :delay="150" />
                      <span class="shrink-0 text-[10px] uppercase text-muted-foreground">{{ t(`sqlParameters.kind.${entry.kind}`) }}</span>
                      <button
                        type="button"
                        class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-destructive/15 hover:text-destructive"
                        :title="t('sqlParameters.removeHistoryItem', '删除此历史值')"
                        @mousedown.stop.prevent="deleteHistoryEntry(parameter.key, entry)"
                      >
                        <X class="h-3 w-3" />
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>
        </div>

        <div class="relative z-10 grid gap-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-xs font-medium text-muted-foreground">{{ t("sqlParameters.preview") }}</div>
            <div class="flex items-center gap-3">
              <label class="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none hover:text-foreground">
                <Switch v-model="formatPreview" size="sm" />
                <span>{{ t("sqlParameters.formatPreview", "格式化预览") }}</span>
              </label>
              <Button type="button" variant="ghost" size="sm" class="h-6 px-2 text-xs text-muted-foreground hover:text-foreground" @click="copyExecutableSql">
                <Copy class="mr-1 h-3 w-3" />
                {{ t("sqlParameters.copyExecutableSql", "复制可执行 SQL") }}
              </Button>
            </div>
          </div>
          <pre class="max-h-48 min-w-0 overflow-auto rounded-md bg-muted px-3 py-3 text-xs font-mono whitespace-pre" v-html="highlightedSql" />
        </div>
      </div>

      <DialogFooter class="flex-wrap gap-2 sm:justify-between">
        <Button type="button" variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <div class="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" @click="copyExecutableSql">
            <Copy class="mr-1.5 h-4 w-4" />
            {{ t("sqlParameters.copyExecutableSql", "复制可执行 SQL") }}
          </Button>
          <Button type="button" variant="outline" @click="replaceInEditor">
            <FileCode class="mr-1.5 h-4 w-4" />
            {{ t("sqlParameters.replaceInEditor", "替换到编辑器") }}
          </Button>
          <Button type="button" @click="execute">{{ t("sqlParameters.execute") }}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
