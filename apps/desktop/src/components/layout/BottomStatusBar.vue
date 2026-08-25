<script setup lang="ts">
import { computed, watchEffect } from "vue";
import { Loader2, Minus, Plus, ShieldAlert, ShieldCheck, Zap } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useSchemaOptions } from "@/composables/useSchemaOptions";
import { isSingleDatabase, supportsClearableQuerySchema, supportsTransaction } from "@/lib/database/databaseCapabilities";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { editorCursorLocation, latestQueryExecutionFeedback, sqlLineEnding, statusBarConnectionLabel } from "@/lib/app/bottomStatusBar";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const props = defineProps<{
  activeTab?: QueryTab;
  activeConnection?: ConnectionConfig;
  connected: boolean;
  cursorPos: number;
  uiScale: number;
}>();

const emit = defineEmits<{
  changeSchema: [schema: string | undefined];
  toggleAutoCommit: [];
  setUiScale: [scale: number];
}>();

const { t } = useI18n();
const { loadSchemaOptions, getSchemaOptionsForDb, isLoadingSchemas, isSchemaAware } = useSchemaOptions();
const connectionLabel = computed(() => statusBarConnectionLabel(props.activeConnection));
const productionContext = computed(() => productionContextForDatabase(props.activeConnection, props.activeTab?.database));
const isQueryTab = computed(() => props.activeTab?.mode === "query");
const schemaDatabaseKey = computed(() => props.activeTab?.database || (isSingleDatabase(props.activeConnection?.db_type) ? "_" : ""));
const showSchemaSelector = computed(() => !!props.activeConnection && !!props.activeTab && isQueryTab.value && !!schemaDatabaseKey.value && isSchemaAware(props.activeConnection.id));
const schemaOptions = computed(() => {
  if (!props.activeConnection) return [];
  const options = getSchemaOptionsForDb(props.activeConnection.id, schemaDatabaseKey.value);
  const current = props.activeTab?.schema;
  return current && !options.includes(current) ? [current, ...options] : options;
});
const loadingSchemas = computed(() => !!props.activeConnection && isLoadingSchemas(props.activeConnection.id, schemaDatabaseKey.value));
const cursorLocation = computed(() => editorCursorLocation(isQueryTab.value ? (props.activeTab?.sql ?? "") : "", isQueryTab.value ? props.cursorPos : 0));
const executionFeedback = computed(() => latestQueryExecutionFeedback(props.activeTab));
const lineEnding = computed(() => sqlLineEnding(props.activeTab?.sql ?? ""));
const zoomPercent = computed(() => Math.round(props.uiScale * 100));
const transactionSupported = computed(() => isQueryTab.value && supportsTransaction(props.activeConnection?.db_type));
const zoomOptions = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

watchEffect(() => {
  const connection = props.activeConnection;
  if (!connection || !showSchemaSelector.value) return;
  void loadSchemaOptions(connection.id, schemaDatabaseKey.value).catch(() => {});
});

function onSchemaChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  emit("changeSchema", value || undefined);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 2 : 1)} s`;
}
</script>

<template>
  <footer data-bottom-status-bar class="relative z-40 isolate h-6 min-h-6 shrink-0 border-t border-border/80 bg-muted/95 text-[11px] text-muted-foreground flex items-center overflow-hidden select-none" :aria-label="t('statusBar.label')">
    <div class="flex min-w-0 flex-1 items-center self-stretch overflow-hidden">
      <div class="flex h-full min-w-0 items-center gap-1.5 border-r border-border/70 px-2" :title="connectionLabel || t('statusBar.noConnection')">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="connected ? 'bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.65)]' : 'bg-muted-foreground/45'" />
        <span class="truncate font-medium text-foreground/85">{{ connectionLabel || t("statusBar.noConnection") }}</span>
      </div>

      <label v-if="showSchemaSelector" class="flex h-full min-w-0 max-w-52 items-center gap-1 border-r border-border/70 px-1.5" :title="t('statusBar.schemaTooltip')">
        <span class="shrink-0 text-muted-foreground/80">{{ t("statusBar.schema") }}:</span>
        <Loader2 v-if="loadingSchemas" class="h-3 w-3 shrink-0 animate-spin" />
        <select v-else class="h-full min-w-0 max-w-32 cursor-pointer appearance-none truncate border-0 bg-transparent pr-1 font-medium text-foreground/85 outline-none" :value="activeTab?.schema || ''" :aria-label="t('statusBar.schemaTooltip')" @change="onSchemaChange">
          <option v-if="supportsClearableQuerySchema(activeConnection?.db_type)" value="" class="bg-popover text-popover-foreground">{{ t("statusBar.defaultSchema") }}</option>
          <option v-for="schema in schemaOptions" :key="schema" :value="schema" class="bg-popover text-popover-foreground">{{ schema }}</option>
        </select>
      </label>

      <button
        v-if="transactionSupported"
        type="button"
        class="flex h-full shrink-0 items-center gap-1 border-r border-border/70 px-2 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        :class="activeTab?.autoCommit === false ? 'text-amber-600 dark:text-amber-300' : ''"
        :disabled="activeTab?.isExecuting"
        :title="activeTab?.autoCommit === false ? t('statusBar.manualTransaction') : t('statusBar.autoCommit')"
        @click="emit('toggleAutoCommit')"
      >
        <Zap class="h-3 w-3" />
        <span>{{ activeTab?.autoCommit === false ? t("statusBar.manualTransaction") : t("statusBar.autoCommit") }}</span>
      </button>

      <span v-if="activeConnection?.read_only" class="flex h-full shrink-0 items-center gap-1 border-r border-border/70 px-2 text-sky-700 dark:text-sky-300" :title="t('statusBar.readOnlyTooltip')"> <ShieldCheck class="h-3 w-3" />{{ t("statusBar.readOnly") }} </span>
      <span v-if="productionContext.active" class="flex h-full shrink-0 items-center gap-1 border-r border-border/70 px-2 font-medium text-red-600 dark:text-red-300" :title="t('statusBar.productionTooltip')"> <ShieldAlert class="h-3 w-3" />{{ t("statusBar.production") }} </span>
    </div>

    <div class="hidden min-w-0 flex-1 items-center justify-center px-3 text-center md:flex" aria-live="polite">
      <span v-if="activeTab?.isExecuting" class="flex items-center gap-1.5"><Loader2 class="h-3 w-3 animate-spin" />{{ t("statusBar.executing") }}</span>
      <span v-else-if="executionFeedback" class="truncate">{{ t("statusBar.lastExecution", { duration: formatDuration(executionFeedback.durationMs), rows: executionFeedback.affectedRows.toLocaleString() }) }}</span>
      <span v-else class="text-muted-foreground/55">{{ t("statusBar.noExecution") }}</span>
    </div>

    <div class="ml-auto flex h-full shrink-0 items-center justify-end">
      <span v-if="isQueryTab" class="flex h-full items-center border-l border-border/70 px-2 font-mono text-foreground/75" :title="t('statusBar.cursorTooltip')">
        {{ t("statusBar.cursor", { line: cursorLocation.line, column: cursorLocation.column }) }}
      </span>
      <span class="flex h-full items-center border-l border-border/70 px-2" :title="t('statusBar.encodingTooltip')">UTF-8</span>
      <span class="flex h-full items-center border-l border-border/70 px-2" :title="t('statusBar.lineEndingTooltip')">{{ lineEnding }}</span>
      <div class="flex h-full items-center border-l border-border/70" :title="t('statusBar.zoomTooltip')">
        <button type="button" class="flex h-full w-5 items-center justify-center hover:bg-accent hover:text-foreground disabled:opacity-35" :disabled="uiScale <= 0.75" :aria-label="t('statusBar.zoomOut')" @click="emit('setUiScale', uiScale - 0.1)">
          <Minus class="h-2.5 w-2.5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button type="button" class="h-full min-w-10 px-1 font-mono text-foreground/75 hover:bg-accent hover:text-foreground" :aria-label="t('statusBar.zoomTooltip')">{{ zoomPercent }}%</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" class="w-28 min-w-28">
            <DropdownMenuItem v-for="scale in zoomOptions" :key="scale" class="text-xs" @select="emit('setUiScale', scale)">
              <span class="flex-1">{{ Math.round(scale * 100) }}%</span>
              <span v-if="Math.abs(scale - uiScale) < 0.005">✓</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" class="flex h-full w-5 items-center justify-center hover:bg-accent hover:text-foreground disabled:opacity-35" :disabled="uiScale >= 2" :aria-label="t('statusBar.zoomIn')" @click="emit('setUiScale', uiScale + 0.1)">
          <Plus class="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  </footer>
</template>
