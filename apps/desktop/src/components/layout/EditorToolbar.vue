<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Play, Loader2, Square, Check, Table2, AlignLeft, GitBranch, Save, FolderOpen, X, Download, RotateCcw, AlertTriangle, ClipboardPaste, Minimize2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import EditorContextPicker from "@/components/layout/EditorContextPicker.vue";
import { supportsSqlInListPaste, supportsTransaction as supportsTransactionFeature } from "@/lib/database/databaseCapabilities";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { hexToRgba } from "@/lib/common/color";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import type { QueryTab, ConnectionConfig } from "@/types/database";

const props = defineProps<{
  activeTab: QueryTab;
  activeConnection?: ConnectionConfig;
  executableSql: string;
  explainMode?: string;
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
  "update:explainMode": [mode: "explain" | "autotrace"];
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
const explainAnalyzeTooltip = computed(() => t("toolbar.explainAnalyze"));
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
  const color = props.activeConnection?.color;
  if (!color) return undefined;
  return {
    backgroundColor: hexToRgba(color, 0.1),
    boxShadow: `inset 0 1px 0 ${hexToRgba(color, 0.18)}`,
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
      <Tooltip v-if="supportsExplain">
        <TooltipTrigger as-child>
          <Button
            :variant="activeTab.isExplaining ? 'destructive' : 'ghost'"
            size="icon"
            class="h-6 w-6"
            :class="activeTab.isExplaining ? '' : 'text-violet-600 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-300 dark:hover:text-violet-200'"
            :disabled="activeTab.isExecuting || (!activeTab.isExplaining && !executableSql.trim())"
            @click="activeTab.isExplaining ? emit('cancel') : emit('explain')"
          >
            <Square v-if="activeTab.isExplaining" class="h-3.5 w-3.5 fill-current" />
            <GitBranch v-else class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ activeTab.isExplaining ? t("toolbar.stopExplain") : t("toolbar.explainPlan") }}</TooltipContent>
      </Tooltip>
      <!-- Autotrace (DM) / EXPLAIN ANALYZE (Postgres) / actual plan (SQL Server) toggle -->
      <Tooltip v-if="supportsExplainAnalyze">
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="h-6 w-6"
            :class="props.explainMode === 'autotrace' ? 'text-green-600 bg-green-100 dark:text-green-300 dark:bg-green-900/30' : 'text-muted-foreground/50'"
            :disabled="activeTab.isExecuting"
            :aria-label="explainAnalyzeTooltip"
            :aria-pressed="props.explainMode === 'autotrace'"
            @click="emit('update:explainMode', props.explainMode === 'autotrace' ? 'explain' : 'autotrace')"
          >
            <span class="font-bold" style="font-size: 9px">A</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ explainAnalyzeTooltip }}</TooltipContent>
      </Tooltip>
      <!-- Transaction toggle -->
      <Tooltip v-if="supportsTransaction">
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="h-6 w-6"
            :class="isTransactionActive || autoCommit === false ? 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300' : 'text-orange-600/70 hover:bg-orange-500/10 hover:text-orange-700 dark:text-orange-300/70 dark:hover:text-orange-200'"
            :disabled="activeTab.isExecuting || activeTab.isExplaining"
            @click="emit('update:autoCommit', autoCommit === false)"
          >
            <span class="text-xs font-bold leading-none">Tx</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ transactionTooltip }}</TooltipContent>
      </Tooltip>
      <!-- Commit button (only when transaction is active) -->
      <Tooltip v-if="isTransactionActive">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6 text-green-600 hover:bg-green-500/10 hover:text-green-700 dark:text-green-300 dark:hover:text-green-200" :disabled="activeTab.isExecuting" @click="emit('commit')">
            <Check class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.commit") }}</TooltipContent>
      </Tooltip>

      <!-- Rollback button (only when transaction is active) -->
      <Tooltip v-if="isTransactionActive">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6 text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-300 dark:hover:text-red-200" :disabled="activeTab.isExecuting" @click="emit('rollback')">
            <RotateCcw class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.rollback") }}</TooltipContent>
      </Tooltip>
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
            class="h-6 w-6 font-mono text-sm font-semibold leading-none"
            :class="keywordCaseIsLower ? 'bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200' : 'text-amber-600/70 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300/70 dark:hover:text-amber-200'"
            :aria-label="keywordCaseToggleTooltip"
            @click="emit('toggleSqlKeywordCase')"
          >
            {{ keywordCaseIsLower ? "a" : "A" }}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ keywordCaseToggleTooltip }}</TooltipContent>
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
