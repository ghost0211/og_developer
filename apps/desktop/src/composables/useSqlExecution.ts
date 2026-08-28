import { ref, watch, type Ref, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { isSingleDatabase, usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import { classifySqlActivityKind } from "@/lib/history/historyActivityKind";
import { sqlMetadataRefreshTarget } from "@/lib/sql/sqlMetadataRefresh";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";
import { isSqlExecutionSnapshot, resolveExecutableSql, type SqlExecutionOverride, type SqlExecutionSnapshot } from "@/lib/sql/sqlExecutionTarget";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { extractSqlParameterDescriptors, type SqlParameterDescriptor, type SqlParameterSyntax } from "@/lib/sql/sqlParameters";
import { expandSqlVariables } from "@/lib/sql/sqlVariables";
import { enabledSqlParameterSyntaxes, resolveSqlVariableSyntaxToggles } from "@/lib/sql/sqlVariableSyntax";
import { assessProductionSql } from "@/lib/database/productionSafety";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { ConnectionConfig, DatabaseType, QueryTab } from "@/types/database";

const DANGER_RE = /^\s*(DROP|DELETE|TRUNCATE|ALTER|UPDATE|MERGE|REPLACE)\b/i;

interface SqlExecutionOptions {
  openInNewResultTab?: boolean;
}

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ");
}

export function isDangerousSql(sql: string, _databaseType?: DatabaseType): boolean {
  const cleaned = stripSqlComments(sql);
  return cleaned.split(";").some((stmt) => DANGER_RE.test(stmt));
}

function primarySqlOperation(sql: string): string {
  const cleaned = stripSqlComments(sql);
  const statement = cleaned
    .split(";")
    .map((part) => part.trim())
    .find(Boolean);
  return statement?.match(/^([a-z]+)/i)?.[1]?.toUpperCase() || "SQL";
}

function firstQueryExecutionError(tab: Pick<QueryTab, "result" | "results">) {
  const activeResult = tab.result;
  if (activeResult && isQueryExecutionErrorResult(activeResult)) return activeResult;

  const results = tab.results?.length ? tab.results : tab.result ? [tab.result] : [];
  return results.find((result) => isQueryExecutionErrorResult(result));
}

export function useSqlExecution(deps: {
  activeTab: ComputedRef<QueryTab | undefined>;
  activeConnection: ComputedRef<ConnectionConfig | undefined>;
  executableSql: ComputedRef<string>;
  resolveExecutableSql?: (snapshot?: SqlExecutionSnapshot) => Promise<string>;
  activeOutputView: Ref<"result" | "output" | "summary" | "explain" | "chart">;
  onMissingDatabase?: () => void;
}) {
  const { t } = useI18n();
  const queryStore = useQueryStore();
  const historyStore = useHistoryStore();
  const connectionStore = useConnectionStore();
  const settingsStore = useSettingsStore();
  const productionSafetyStore = useProductionSafetyStore();
  const { toast } = useToast();

  const dangerSql = ref("");
  const pendingDangerSql = ref("");
  const showDangerDialog = ref(false);
  const suppressDangerConfirm = ref(false);
  const explainMode = ref<"explain" | "autotrace">("explain");
  const showSqlParameterDialog = ref(false);
  const sqlParameterSourceSql = ref("");
  const sqlParameterNames = ref<SqlParameterDescriptor[]>([]);
  const sqlParameterDatabaseType = ref<DatabaseType | undefined>();
  const sqlParameterEnabledSyntaxes = ref<SqlParameterSyntax[]>([]);
  const pendingSourceOffset = ref<number | undefined>();
  const pendingDangerSourceOffset = ref<number | undefined>();
  const pendingOpenInNewResultTab = ref(false);

  async function resolvedExecutableSql(source?: SqlExecutionOverride): Promise<{ sql: string; sourceOffset?: number }> {
    const atSetEnabled = resolveSqlVariableSyntaxToggles(settingsStore.editorSettings.sqlVariableSyntaxOverrides, deps.activeConnection.value?.db_type).atSet;
    const expand = (sql: string) => (atSetEnabled ? expandSqlVariables(sql).sql : sql);
    if (typeof source === "string") return { sql: expand(source) };

    const resolved = deps.resolveExecutableSql ? await deps.resolveExecutableSql(source) : isSqlExecutionSnapshot(source) ? resolveExecutableSql(source.fullSql, source.selectedSql, { cursorPos: source.cursorPos }) : deps.executableSql.value;
    const sql = expand(resolved);
    if (!isSqlExecutionSnapshot(source) || !source.selectedSql.trim() || sql !== resolved) return { sql };

    const leadingWhitespace = source.selectedSql.length - source.selectedSql.trimStart().length;
    return { sql, sourceOffset: source.selectionFrom + leadingWhitespace };
  }

  async function tryExecute(sqlOverride?: SqlExecutionOverride, options: SqlExecutionOptions = {}) {
    const tab = deps.activeTab.value;
    const { sql, sourceOffset } = await resolvedExecutableSql(sqlOverride);
    if (!tab || !sql.trim()) return;
    if (requiresDatabaseSelection(tab, deps.activeConnection.value, sql)) {
      deps.onMissingDatabase?.();
      return;
    }
    if (supportsSqlTemplateParameters(deps.activeConnection.value, sql) && prepareSqlParameterDialog(sql, sourceOffset, options)) return;
    await continueExecute(sql, sourceOffset, options);
  }

  function tryExecuteInNewResultTab(sqlOverride?: SqlExecutionOverride) {
    return tryExecute(sqlOverride, { openInNewResultTab: true });
  }

  async function continueExecute(sql: string, sourceOffset?: number, options: SqlExecutionOptions = {}) {
    const productionAssessment = assessProductionSql(sql, deps.activeConnection.value, deps.activeTab.value?.database);
    if (productionAssessment.active && productionAssessment.isMutation) {
      // Production writes always need a new explicit decision; editor preferences cannot suppress this gate.
      const confirmed = await productionSafetyStore.requestConfirmation({
        sql,
        connectionName: deps.activeConnection.value?.name,
        database: deps.activeTab.value?.database,
        productionDatabases: productionAssessment.databases,
        source: t("production.sourceSqlEditor"),
      });
      if (confirmed) await doExecute(sql, sourceOffset, options);
      return;
    }
    if (isDangerousSql(sql, deps.activeConnection.value?.db_type) && settingsStore.editorSettings.confirmDangerousSqlExecution) {
      dangerSql.value = sql;
      pendingDangerSql.value = sql;
      pendingDangerSourceOffset.value = sourceOffset;
      pendingOpenInNewResultTab.value = options.openInNewResultTab === true;
      suppressDangerConfirm.value = false;
      showDangerDialog.value = true;
    } else {
      await doExecute(sql, sourceOffset, options);
    }
  }

  function prepareSqlParameterDialog(sql: string, sourceOffset?: number, options: SqlExecutionOptions = {}): boolean {
    const databaseType = deps.activeConnection.value?.db_type;
    const toggles = resolveSqlVariableSyntaxToggles(settingsStore.editorSettings.sqlVariableSyntaxOverrides, databaseType);
    const enabledSyntaxes = enabledSqlParameterSyntaxes(toggles);
    const parameters = extractSqlParameterDescriptors(sql, { databaseType, enabledSyntaxes });
    if (!parameters.length) return false;
    sqlParameterSourceSql.value = sql;
    sqlParameterNames.value = parameters;
    sqlParameterDatabaseType.value = databaseType;
    sqlParameterEnabledSyntaxes.value = enabledSyntaxes;
    pendingSourceOffset.value = sourceOffset;
    pendingOpenInNewResultTab.value = options.openInNewResultTab === true;
    showSqlParameterDialog.value = true;
    return true;
  }

  async function doExecute(sql?: string, sourceOffset?: number, options: SqlExecutionOptions = {}) {
    if (sql === undefined) ({ sql, sourceOffset } = await resolvedExecutableSql());
    const tab = deps.activeTab.value;
    if (!tab || !sql.trim()) return;
    const executionConnection = connectionStore.getConfig(tab.connectionId) ?? deps.activeConnection.value;
    const executionDatabaseType = executionConnection?.db_type;
    if (requiresDatabaseSelection(tab, executionConnection, sql)) {
      deps.onMissingDatabase?.();
      return;
    }
    const statementCount = splitSqlStatementRanges(sql, executionDatabaseType).length;
    deps.activeOutputView.value = statementCount > 1 ? "summary" : "result";
    const connName = executionConnection?.name || "";
    const start = Date.now();
    const producedResult = await queryStore.executeCurrentSql(sql, {
      ...(sourceOffset !== undefined ? { sourceOffset } : {}),
      ...(options.openInNewResultTab ? { openInNewResultTab: true } : {}),
    });
    if (producedResult === false) return;
    const executionMessages = (tab.results ?? (tab.result ? [tab.result] : [])).flatMap((result) => result.messages ?? []);
    if (executionMessages.length > 0 && !tab.results?.some((result) => result.columns.length > 0)) {
      // 打印输出优先于摘要：纯 RAISE NOTICE/gms_output 的执行没有结果表。
      deps.activeOutputView.value = "output";
    } else if (tab.result && !tab.result.columns.length && !tab.results?.some((result) => result.columns.length > 0)) {
      deps.activeOutputView.value = "summary";
    }
    const elapsed = Date.now() - start;
    const failure = firstQueryExecutionError(tab);
    const success = !failure;
    historyStore.add({
      connection_id: tab.connectionId,
      connection_name: connName,
      database: tab.database,
      sql,
      execution_time_ms: elapsed,
      success,
      error: failure ? String(failure.rows?.[0]?.[0] ?? "") : undefined,
      activity_kind: classifySqlActivityKind(sql),
      operation: primarySqlOperation(sql),
      affected_rows: success ? tab.result?.affected_rows : undefined,
    });
    if (success) {
      const refreshTarget = sqlMetadataRefreshTarget(sql, tab.schema);
      if (refreshTarget.scope === "connection") {
        await connectionStore.loadDatabases(tab.connectionId, { force: true });
      } else if (refreshTarget.scope === "database") {
        await connectionStore.refreshObjectListTreeNode(tab.connectionId, tab.database, refreshTarget.schema);
      }
    }
  }

  function cancelActiveExecution() {
    const tab = deps.activeTab.value;
    if (!tab) return;
    if (tab.isExecuting) void queryStore.cancelTabExecution(tab.id);
    else if (tab.isExplaining) void queryStore.cancelTabExplain(tab.id);
  }

  function explainReasonMessage(reason: string): string {
    if (reason === "unsupported") return t("explain.unsupported");
    if (reason === "unsafe") return t("explain.unsafe");
    return t("explain.emptySql");
  }

  async function tryExplain(sqlOverride?: SqlExecutionOverride) {
    const tab = deps.activeTab.value;
    const { sql } = await resolvedExecutableSql(sqlOverride);
    if (!tab || !sql.trim()) {
      toast(t("explain.emptySql"));
      return;
    }

    deps.activeOutputView.value = "explain";
    const result = await queryStore.explainTabSql(tab.id, sql, deps.activeConnection.value?.db_type, explainMode.value);
    if (!result.ok) {
      toast(explainReasonMessage(result.reason), 5000);
      return;
    }

    const current = deps.activeTab.value;
    if (current?.explainError) toast(current.explainError, 5000);
  }

  async function onDangerConfirm() {
    const sql = pendingDangerSql.value;
    const sourceOffset = pendingDangerSourceOffset.value;
    const openInNewResultTab = pendingOpenInNewResultTab.value;
    pendingDangerSql.value = "";
    pendingDangerSourceOffset.value = undefined;
    pendingOpenInNewResultTab.value = false;
    if (suppressDangerConfirm.value) {
      settingsStore.updateEditorSettings({ confirmDangerousSqlExecution: false });
    }
    suppressDangerConfirm.value = false;
    await doExecute(sql, sourceOffset, { openInNewResultTab });
  }

  async function onSqlParametersConfirm(sql: string) {
    const openInNewResultTab = pendingOpenInNewResultTab.value;
    showSqlParameterDialog.value = false;
    sqlParameterSourceSql.value = "";
    sqlParameterNames.value = [];
    sqlParameterDatabaseType.value = undefined;
    sqlParameterEnabledSyntaxes.value = [];
    const sourceOffset = pendingSourceOffset.value;
    pendingSourceOffset.value = undefined;
    pendingOpenInNewResultTab.value = false;
    await continueExecute(sql, sourceOffset, { openInNewResultTab });
  }

  watch(showSqlParameterDialog, (open) => {
    if (open) return;
    sqlParameterSourceSql.value = "";
    sqlParameterNames.value = [];
    sqlParameterDatabaseType.value = undefined;
    sqlParameterEnabledSyntaxes.value = [];
    pendingSourceOffset.value = undefined;
    pendingOpenInNewResultTab.value = false;
  });

  watch(showDangerDialog, (open) => {
    if (open) return;
    pendingDangerSql.value = "";
    pendingDangerSourceOffset.value = undefined;
    pendingOpenInNewResultTab.value = false;
    suppressDangerConfirm.value = false;
  });

  return {
    dangerSql,
    pendingDangerSql,
    showDangerDialog,
    suppressDangerConfirm,
    tryExecute,
    tryExecuteInNewResultTab,
    doExecute,
    cancelActiveExecution,
    tryExplain,
    onDangerConfirm,
    showSqlParameterDialog,
    sqlParameterSourceSql,
    sqlParameterNames,
    sqlParameterDatabaseType,
    sqlParameterEnabledSyntaxes,
    onSqlParametersConfirm,
    explainMode,
  };
}

export function supportsSqlTemplateParameters(connection: Pick<ConnectionConfig, "db_type"> | undefined, _sql = ""): boolean {
  return !!connection;
}

export function requiresDatabaseSelection(tab: QueryTab, connection: ConnectionConfig | undefined, _sql = ""): boolean {
  if (tab.mode !== "query") return false;
  if (!connection) return false;
  if (tab.database) return false;
  if (tab.database === "" && usesTreeSchemaMode(connection.db_type)) return false;
  if (isSingleDatabase(connection.db_type)) return false;
  return true;
}
