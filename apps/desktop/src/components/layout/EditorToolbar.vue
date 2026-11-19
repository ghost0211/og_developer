<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Play, Loader2, Square, Check, AlignLeft, GitBranch, Save, FolderOpen, Download, RotateCcw, AlertTriangle, ClipboardPaste, Minimize2, ChevronDown, Braces, CaseUpper, CaseLower } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import EditorContextPicker from "@/components/layout/EditorContextPicker.vue";
import { supportsSqlInListPaste, supportsTransaction as supportsTransactionFeature } from "@/lib/database/databaseCapabilities";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { hexToRgba } from "@/lib/common/color";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import type { QueryTab, ConnectionConfig } from "@/types/database";

export type ToolbarExplainMode = "explain" | "autotrace" | "sandbox" | "performance";

const props = defineProps<{
  activeTab: QueryTab;
  activeConnection?: ConnectionConfig;
  executableSql: string;
  explainMode?: ToolbarExplainMode;
  sqlKeywordCase: "preserve" | "upper" | "lower";
  databaseRequiredSignal?: number;
  autoCommit?: boolean;
  txnSessionId?: string;
  txnAutoRolledBack?: boolean;
}>();

const emit = defineEmits<{
  execute: [];
  cancel: [];
  explain: [];
  "update:explainMode": [mode: ToolbarExplainMode];
  openParameters: [];
  formatSql: [];
  compressSql: [];
  toggleSqlKeywordCase: [];
  saveSql: [];
  openSql: [];
  importResultArchive: [];
  pasteSqlInCondition: [];
  changeConnection: [connectionId: string];
  changeDatabase: [database: string];
  changeSchema: [schema: string | undefined];
  setDefaultDatabase: [];
  clearDefaultDatabase: [];
  "update:autoCommit": [value: boolean];
  commit: [];
  rollback: [];
  dismissTxnRolledBack: [];
}>();

const { t } = useI18n();

const activeProductionContext = computed(() => productionContextForDatabase(props.activeConnection, props.activeTab.database));
const supportsExplain = computed(() => !!props.activeConnection);
const supportsExPaste = computed(() => supportsSqlInListPaste(props.activeConnection?.db_type));
const supportsTransaction = computed(() => supportsTransactionFeature(props.activeConnection?.db_type));
const saveTooltip = computed(() => (props.activeTab.objectSource ? t("objects.saveSource") : t("toolbar.saveSql")));
// Postgres/openGauss EXPLAIN ANALYZE executes the statement.
const supportsExplainAnalyze = computed(() => {
  const dbType = effectiveDatabaseTypeForConnection(props.activeConnection);
  return dbType === "postgres" || dbType === "opengauss";
});
const isOpenGaussExplain = computed(() => effectiveDatabaseTypeForConnection(props.activeConnection) === "opengauss");
const explainModeBadge = computed(() => {
  if (!supportsExplainAnalyze.value) return "";
  if (props.explainMode === "performance") return t("toolbar.explainModePerfShort");
  if (props.explainMode === "sandbox") return t("toolbar.explainModeSandboxShort");
  if (props.explainMode === "autotrace") return t("toolbar.explainModeAnalyzeShort");
  return "";
});
const explainPrimaryTooltip = computed(() => {
  if (props.activeTab.isExplaining) return t("toolbar.stopExplain");
  if (props.explainMode === "performance") return t("toolbar.explainPerformance");
  if (props.explainMode === "sandbox") return t("toolbar.explainPlanSandbox");
  if (props.explainMode === "autotrace") return t("toolbar.explainAnalyze");
  return t("toolbar.explainPlan");
});

function selectAndRunExplainMode(mode: ToolbarExplainMode) {
  emit("update:explainMode", mode);
  if (props.executableSql.trim() && !props.activeTab.isExecuting && !props.activeTab.isExplaining) {
    emit("explain");
  }
}
const canSaveSql = computed(() => !!props.activeTab.externalSqlPath || !!props.activeTab.sql.trim());
const keywordCaseIsLower = computed(() => props.sqlKeywordCase === "lower");
const keywordCaseToggleTooltip = computed(() => (keywordCaseIsLower.value ? t("toolbar.keywordCaseUpper") : t("toolbar.keywordCaseLower")));
const transactionTooltip = computed(() => {
  const isAgent = (props.activeConnection?.db_type as string) === "agent";
  const isManual = props.autoCommit === false;
  if (isAgent && isManual) return t("toolbar.manualTransactionAgent");
  if (isAgent) return t("toolbar.autoCommitAgent");
  return isManual ? t("toolbar.manualTransaction") : t("toolbar.autoCommit");
});
const executeButtonClass = computed(() => {
  if (props.activeTab.isExecuting) return "";
  return activeProductionContext.value.active ? "bg-red-500/10 text-red-700 hover:bg-red-500/20 hover:text-red-800 dark:text-red-300 dark:hover:text-red-200" : "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 hover:text-emerald-800 dark:text-emerald-300 dark:hover:text-emerald-200";
});

const isTransactionActive = computed(() => !!props.txnSessionId);

const toolbarStyle = computed(() => {
  const accentColor = props.activeConnection?.color || (activeProductionContext.value.active ? "#ef4444" : "");
  if (!accentColor) return undefined;
  return {
    backgroundColor: hexToRgba(accentColor, activeProductionContext.value.active ? 0.14 : 0.1),
    boxShadow: `inset 0 2px 0 ${hexToRgba(accentColor, 0.85)}`,
  };
});
</script>

<template>
  <div class="app-editor-toolbar h-9 shrink-0 border-b bg-background/80 px-3 flex items-center gap-1 text-xs text-muted-foreground relative z-10" :style="toolbarStyle">
    <div class="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            :variant="activeTab.isExecuting ? 'destructive' : 'ghost'"
            size="icon"
            class="h-6 w-6"
            :class="executeButtonClass"
            :disabled="activeTab.isCancelling || activeTab.isExplaining || (!activeTab.isExecuting && !executableSql.trim())"
            @mousedown.prevent
            @click="activeTab.isExecuting ? emit('cancel') : emit('execute')"
          >
            <Loader2 v-if="activeTab.isCancelling" class="h-3.5 w-3.5 animate-spin" />
            <Square v-else-if="activeTab.isExecuting" class="h-3.5 w-3.5 fill-current" />
            <Play v-else class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ activeTab.isExecuting ? t("toolbar.stopQuery") : t("toolbar.executeShortcut") }}</TooltipContent>
      </Tooltip>
      <div v-if="supportsExplain" class="inline-flex items-center rounded-md" :class="explainModeBadge && !activeTab.isExplaining ? 'bg-violet-500/10 ring-1 ring-violet-500/25' : ''">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              :variant="activeTab.isExplaining ? 'destructive' : 'ghost'"
              size="sm"
              class="h-6 px-1.5 gap-1"
              :class="[
                supportsExplainAnalyze ? 'rounded-r-none' : '',
                activeTab.isExplaining
                  ? ''
                  : props.explainMode === 'performance'
                    ? 'text-sky-700 hover:bg-sky-500/15 dark:text-sky-300'
                    : props.explainMode === 'sandbox'
                      ? 'text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300'
                      : props.explainMode === 'autotrace'
                        ? 'text-amber-700 hover:bg-amber-500/15 dark:text-amber-300'
                        : 'text-violet-600 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-300 dark:hover:text-violet-200',
              ]"
              :disabled="activeTab.isExecuting || (!activeTab.isExplaining && !executableSql.trim())"
              @click="activeTab.isExplaining ? emit('cancel') : emit('explain')"
            >
              <Square v-if="activeTab.isExplaining" class="h-3.5 w-3.5 fill-current" />
              <GitBranch v-else class="h-3.5 w-3.5 shrink-0" />
              <span v-if="explainModeBadge && !activeTab.isExplaining" class="text-[10px] font-semibold leading-none">{{ explainModeBadge }}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ explainPrimaryTooltip }}</TooltipContent>
        </Tooltip>
        <DropdownMenu v-if="supportsExplainAnalyze">
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon" class="h-6 w-4 rounded-l-none border-l border-border/50 px-0 text-muted-foreground hover:text-foreground" :disabled="activeTab.isExecuting || activeTab.isExplaining" :aria-label="t('toolbar.explainModeSelect')">
              <ChevronDown class="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-72">
            <DropdownMenuItem class="flex flex-col items-start gap-0.5 py-1.5 text-xs cursor-pointer" @select="selectAndRunExplainMode('explain')">
              <div class="flex w-full items-center justify-between font-medium">
                <span>{{ t("toolbar.explainModeEstimate") }}</span>
                <span v-if="!props.explainMode || props.explainMode === 'explain'" class="text-primary">✓</span>
              </div>
              <span class="text-[11px] text-muted-foreground">{{ t("toolbar.explainModeEstimateDesc") }}</span>
            </DropdownMenuItem>
            <DropdownMenuItem class="flex flex-col items-start gap-0.5 py-1.5 text-xs cursor-pointer" @select="selectAndRunExplainMode('autotrace')">
              <div class="flex w-full items-center justify-between font-medium">
                <span>{{ t("toolbar.explainModeAnalyze") }}</span>
                <span v-if="props.explainMode === 'autotrace'" class="text-primary">✓</span>
              </div>
              <span class="text-[11px] text-muted-foreground">{{ t("toolbar.explainModeAnalyzeDesc") }}</span>
            </DropdownMenuItem>
            <DropdownMenuItem class="flex flex-col items-start gap-0.5 py-1.5 text-xs cursor-pointer" @select="selectAndRunExplainMode('sandbox')">
              <div class="flex w-full items-center justify-between font-medium text-emerald-700 dark:text-emerald-300">
                <span>{{ t("toolbar.explainModeSandbox") }}</span>
                <span v-if="props.explainMode === 'sandbox'" class="text-primary">✓</span>
              </div>
              <span class="text-[11px] text-muted-foreground">{{ t("toolbar.explainModeSandboxDesc") }}</span>
            </DropdownMenuItem>
            <DropdownMenuItem v-if="isOpenGaussExplain" class="flex flex-col items-start gap-0.5 py-1.5 text-xs cursor-pointer" @select="selectAndRunExplainMode('performance')">
              <div class="flex w-full items-center justify-between font-medium text-sky-700 dark:text-sky-300">
                <span>{{ t("toolbar.explainModePerf") }}</span>
                <span v-if="props.explainMode === 'performance'" class="text-primary">✓</span>
              </div>
              <span class="text-[11px] text-muted-foreground">{{ t("toolbar.explainModePerfDesc") }}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <!-- Manual Transaction controls (only shown when manual mode or uncommitted transaction is active; global toggle lives in status bar) -->
      <template v-if="supportsTransaction && (isTransactionActive || autoCommit === false)">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="sm"
              class="h-6 px-1.5 gap-1 rounded text-[11px] font-medium"
              :class="isTransactionActive ? 'bg-amber-500/15 text-amber-700 ring-1 ring-amber-500/35 dark:text-amber-300' : 'bg-orange-500/10 text-orange-700 dark:text-orange-300'"
              :disabled="activeTab.isExecuting || activeTab.isExplaining || isTransactionActive"
              @click="emit('update:autoCommit', true)"
            >
              <span class="h-1.5 w-1.5 rounded-full" :class="isTransactionActive ? 'bg-amber-500 animate-pulse' : 'bg-orange-500'" />
              <span>{{ isTransactionActive ? t("toolbar.uncommittedTxnBadge") : t("statusBar.manualTransaction") }}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ isTransactionActive ? t("toolbar.uncommittedTxnTooltip") : transactionTooltip }}</TooltipContent>
        </Tooltip>
        <Tooltip v-if="isTransactionActive">
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-6 w-6 text-green-600 hover:bg-green-500/10 hover:text-green-700 dark:text-green-300 dark:hover:text-green-200" :disabled="activeTab.isExecuting" @click="emit('commit')">
              <Check class="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t("toolbar.commit") }}</TooltipContent>
        </Tooltip>
        <Tooltip v-if="isTransactionActive">
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-6 w-6 text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-300 dark:hover:text-red-200" :disabled="activeTab.isExecuting" @click="emit('rollback')">
              <RotateCcw class="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t("toolbar.rollback") }}</TooltipContent>
        </Tooltip>
      </template>

      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6 text-amber-600 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200" :disabled="activeTab.isExecuting || activeTab.isExplaining || !activeTab.sql.trim()" @click="emit('formatSql')">
            <AlignLeft class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.formatSql") }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6 text-amber-600 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200" :disabled="activeTab.isExecuting || activeTab.isExplaining || !activeTab.sql.trim()" @click="emit('compressSql')">
            <Minimize2 class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.compressSql") }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="h-6 w-6"
            :class="keywordCaseIsLower ? 'bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200' : 'text-amber-600/75 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300/75 dark:hover:text-amber-200'"
            :aria-label="keywordCaseToggleTooltip"
            @click="emit('toggleSqlKeywordCase')"
          >
            <CaseLower v-if="keywordCaseIsLower" class="h-3.5 w-3.5" />
            <CaseUpper v-else class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ keywordCaseToggleTooltip }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6 text-indigo-600 hover:bg-indigo-500/10 hover:text-indigo-700 dark:text-indigo-300 dark:hover:text-indigo-200" :disabled="activeTab.isExecuting || !activeTab.sql.trim()" @click="emit('openParameters')">
            <Braces class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("sqlParameters.toolbarTooltip") }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6 text-blue-600 hover:bg-blue-500/10 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-200" :disabled="!canSaveSql" @click="emit('saveSql')">
            <Save class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ saveTooltip }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6 text-sky-600 hover:bg-sky-500/10 hover:text-sky-700 dark:text-sky-300 dark:hover:text-sky-200" @click="emit('openSql')">
            <FolderOpen class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.openSql") }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6 text-cyan-600 hover:bg-cyan-500/10 hover:text-cyan-700 dark:text-cyan-300 dark:hover:text-cyan-200" @click="emit('importResultArchive')">
            <Download class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("tabs.importResultArchive") }}</TooltipContent>
      </Tooltip>
      <Tooltip v-if="supportsExPaste">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6 text-teal-600 hover:bg-teal-500/10 hover:text-teal-700 dark:text-teal-300 dark:hover:text-teal-200" @click="emit('pasteSqlInCondition')">
            <ClipboardPaste class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.exPasteSqlInCondition") }}</TooltipContent>
      </Tooltip>
    </div>
    <span class="flex-1 min-w-0" />
    <EditorContextPicker
      class="shrink-0"
      :active-tab="activeTab"
      :active-connection="activeConnection"
      :database-required-signal="databaseRequiredSignal"
      @change-connection="(connectionId) => emit('changeConnection', connectionId)"
      @change-database="(database) => emit('changeDatabase', database)"
      @change-schema="(schema) => emit('changeSchema', schema)"
      @set-default-database="emit('setDefaultDatabase')"
      @clear-default-database="emit('clearDefaultDatabase')"
    />
    <div v-if="activeTab.mode === 'data' && activeTab.tableMeta" class="ml-2 inline-flex shrink-0 items-center gap-1 rounded border border-border bg-muted/30 px-2 py-0.5 font-medium text-muted-foreground tabular-nums">
      <Table2 class="h-3.5 w-3.5 shrink-0" />
      <span class="truncate">{{ activeTab.tableMeta.columns.length }} {{ t("tree.columns") }}</span>
    </div>
  </div>
  <div v-if="txnAutoRolledBack" class="flex items-center gap-2 px-3 py-1 text-xs bg-amber-500/10 text-amber-700 dark:text-amber-300 border-b border-amber-500/20">
    <AlertTriangle class="h-3.5 w-3.5 shrink-0" />
    <span>{{ t("toolbar.txnAutoRolledBack") }}</span>
    <Button variant="ghost" size="icon" class="h-5 w-5 ml-auto" @click="emit('dismissTxnRolledBack')">
      <X class="h-3 w-3" />
    </Button>
  </div>
</template>
