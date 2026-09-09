<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppToolbar from "@/components/layout/AppToolbar.vue";
import AppTabBar from "@/components/layout/AppTabBar.vue";
import AppSidebar from "@/components/layout/AppSidebar.vue";
import AppActivityBar, { type ActivityPanelId } from "@/components/layout/AppActivityBar.vue";
import EditorToolbar from "@/components/layout/EditorToolbar.vue";
import ContentArea from "@/components/layout/ContentArea.vue";
import AppDialogs from "@/components/layout/AppDialogs.vue";
import BottomStatusBar from "@/components/layout/BottomStatusBar.vue";
import WelcomeScreen from "@/components/layout/WelcomeScreen.vue";
import type { ConfigTab } from "@/components/connection/ConnectionDialog.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import type { MenuSearchMode } from "@/components/search/MenuSearchDialog.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { createToolPanelSession, setToolPanelOpen as setToolPanelSessionOpen, toggleToolPanelSession, TOOL_PANEL_IDS, type ToolPanelId, type ToolPanelState } from "@/lib/app/toolPanelState";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { usePromptTemplateStore } from "@/stores/promptTemplateStore";
import { useGitStore } from "@/stores/gitStore";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { useFileDrop } from "@/composables/useFileDrop";
import { usePanelResize } from "@/composables/usePanelResize";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { useSqlExecution } from "@/composables/useSqlExecution";
import { useDialogSources } from "@/composables/useDialogSources";
import { useNavigationTargets } from "@/composables/useNavigationTargets";
import { useDataGridActions } from "@/composables/useDataGridActions";
import { useTauriEvents } from "@/composables/useTauriEvents";
import { useCloseActionPrompt, type AppCloseAction, type AppCloseRequestOptions } from "@/composables/useCloseActionPrompt";
import { useVisibilityChange } from "@/composables/useVisibilityChange";
import { useExportTracker } from "@/composables/useExportTracker";
import { useAppUpdater } from "@/composables/useAppUpdater";
import { countActiveUpdateBlockingTasks } from "@/lib/app/appUpdateTaskGuard";
import { shouldDrawDesktopWindowFrame, useWindowControls } from "@/composables/useWindowControls";
import { createOpenTabsRestorationBarrier, initializeDesktopOpenTabs, type OpenTabsRestorationBarrier } from "@/lib/app/openTabsStartup";
import { useSaveSqlFolderSelection } from "@/composables/useSaveSqlFolderSelection";
import "@/i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import * as api from "@/lib/backend/api";
import { connectionRedactedNameLabel } from "@/lib/connection/connectionPresentation";
import { quickConnectionOpenTarget } from "@/lib/connection/connectionOpenTarget";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { findTreeNodeById, resolveNewQueryTarget, resolveNewQueryInitialSql } from "@/lib/sql/newQueryContext";
import { isSqlObjectNavigationRoutineType, sqlObjectNavigationSourceKind, sqlObjectNavigationSourceName, sqlObjectNavigationSourceSchema, sqlObjectNavigationTableType, type SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import { buildEditableObjectSource, buildExecutableObjectSourceStatements, executeObjectSourceSave } from "@/lib/table/objectSourceEditor";
import { loadEditableObjectSourceForEditor } from "@/lib/table/objectSourceLoad";
import { resolveHistorySqlRestoreTarget } from "@/lib/history/historyRestoreTarget";
import { resolveExecutableSql, resolveExecutableSqlWithBackend, type SqlExecutionSnapshot } from "@/lib/sql/sqlExecutionTarget";
import { isMacOS, isWindows } from "@/lib/backend/platform";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { downloadDebugLogs } from "@/lib/backend/debugLog";
import { openQueryResultArchiveFile } from "@/lib/query/queryResultArchiveFile";
import { rememberExternalSqlFileTarget, resolveExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";
import { externalSqlFileOpenErrorMessage, readBrowserSqlFile, sqlFileTitleFromPath } from "@/lib/sql/sqlFileOpen";
import type { ObjectSourceKind, QueryTab } from "@/types/database";
import { parseConnectionDeepLink, type ConnectionDeepLinkDraft } from "@/lib/connection/connectionDeepLink";
import {
  isBrowserReloadShortcut,
  isCloseOtherTabsShortcut,
  isCloseTabShortcut,
  isCloneFromGitShortcut,
  isCommandWindowShortcut,
  isCommitTransactionShortcut,
  isCompressSqlShortcut,
  isCreateProjectShortcut,
  isExecuteCurrentStatementShortcut,
  isExecuteSqlInNewResultTabShortcut,
  isExecuteSqlShortcut,
  isExplainSqlShortcut,
  isExportConnectionsShortcut,
  isFocusSearchShortcut,
  isImportConnectionsShortcut,
  isImportResultShortcut,
  isModRShortcut,
  isNewConnectionShortcut,
  isNewQueryShortcut,
  isObjectSourceSaveShortcutTarget,
  isOpenProjectShortcut,
  isOpenSettingsShortcut,
  isOpenSqlFileShortcut,
  isQuickOpenShortcut,
  isResetZoomShortcut,
  isRefreshDataShortcut,
  isRollbackTransactionShortcut,
  isSaveSqlAsShortcut,
  isSearchMetadataShortcut,
  isSearchObjectSourceShortcut,
  isSearchTableDataShortcut,
  isSaveShortcut,
  isSendSelectionToAiShortcut,
  isSwitchToNextTabShortcut,
  isSwitchToPreviousTabShortcut,
  isToggleAutoCommitShortcut,
  isToggleSidebarShortcut,
  isZoomInShortcut,
  isZoomOutShortcut,
  switchToTabIndexFromShortcut,
} from "@/lib/editor/keyboardShortcuts";
import { isPreviewTab } from "@/lib/tabs/tabPresentation";
import { supportsSqlFileExecution } from "@/lib/database/databaseCapabilities";
import { classifyAiSqlExecution } from "@/lib/ai/aiSqlExecutionPolicy";
import { buildAppendedEditorSql } from "@/lib/ai/aiSqlAppend";
import { assessProductionSql } from "@/lib/database/productionSafety";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { buildHistoryAiAnalysisPrompt } from "@/lib/history/historyAiAnalysis";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { apiUrl, webPath } from "@/lib/common/webPath";
import { shouldBlockAppNativeSelectAll } from "@/lib/common/clipboard";
import { APP_FONT_SANS_CSS_VAR, DATA_GRID_FONT_FAMILY_CSS_VAR, DEFAULT_DATA_GRID_FONT_FAMILY, DEFAULT_UI_FONT_FAMILY } from "@/lib/app/appFonts";
import { rankSavedSqlHistory } from "@/lib/savedSql/savedSqlHistory";
import { savedSqlDefaultTargetForWrite } from "@/lib/savedSql/savedSqlExecutionTarget";
import { menuSearchTableDdlTarget } from "@/lib/search/menuSearchObjectNavigation";
import { initSavedSqlEditorPositions } from "@/lib/app/savedSqlEditorPosition";
import { isSchemaAware, isSingleDatabase, usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";
import { codeMirrorSqlDialect, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { HistoryEntry } from "@/lib/backend/tauri";
import type { AiAction } from "@/lib/ai/ai";

const AiAssistant = defineAsyncComponent(() => import("@/components/editor/AiAssistant.vue"));
const QueryHistory = defineAsyncComponent(() => import("@/components/editor/QueryHistory.vue"));
const SqlLibraryPanel = defineAsyncComponent(() => import("@/components/layout/SqlLibraryPanel.vue"));
const SqlFilePanel = defineAsyncComponent(() => import("@/components/layout/SqlFilePanel.vue"));
const ProjectFilesPanel = defineAsyncComponent(() => import("@/components/layout/ProjectFilesPanel.vue"));
const GitPanel = defineAsyncComponent(() => import("@/components/layout/GitPanel.vue"));
const GitCloneDialog = defineAsyncComponent(() => import("@/components/git/GitCloneDialog.vue"));
const GitDiffDialog = defineAsyncComponent(() => import("@/components/git/GitDiffDialog.vue"));
const AboutDialog = defineAsyncComponent(() => import("@/components/common/AboutDialog.vue"));
const UpdateDialog = defineAsyncComponent(() => import("@/components/layout/UpdateDialog.vue"));
const LoginPage = defineAsyncComponent(() => import("@/components/auth/LoginPage.vue"));
const QuickOpenDialog = defineAsyncComponent(() => import("@/components/quick-open/QuickOpenDialog.vue"));
const ProjectDialog = defineAsyncComponent(() => import("@/components/projects/ProjectDialog.vue"));
const MenuSearchDialog = defineAsyncComponent(() => import("@/components/search/MenuSearchDialog.vue"));
const SessionsDialog = defineAsyncComponent(() => import("@/components/sessions/SessionsDialog.vue"));
const QueryEditorDdlViewDialog = defineAsyncComponent(() => import("@/components/objects/DdlViewDialog.vue"));
const QueryEditorObjectSourceDialog = defineAsyncComponent(() => import("@/components/objects/ObjectSourceDialog.vue"));

type AiAssistantHandle = {
  triggerAction: (action: AiAction, instruction?: string) => void;
  setPrompt: (text: string) => void;
};

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const savedSqlStore = useSavedSqlStore();
const promptTemplateStore = usePromptTemplateStore();
const gitStore = useGitStore();
const { message: toastMessage, visible: toastVisible, toast } = useToast();
const { isDark, themeMode, applyTheme, setThemeMode } = useTheme();
const { setupFileDrop } = useFileDrop();
const exportTracker = useExportTracker();
const appUpdater = useAppUpdater({
  getActiveTaskCount: () => countActiveUpdateBlockingTasks(exportTracker.activeCount.value, queryStore.tabs),
});
const {
  updateInfo: appUpdateInfo,
  updateCheckMessage: appUpdateCheckMessage,
  showUpdateDialog: showAppUpdateDialog,
  isDownloadingUpdate: isDownloadingAppUpdate,
  downloadProgress: appUpdateDownloadProgress,
  updateDownloaded: appUpdateDownloaded,
  isInstallingUpdate: isInstallingAppUpdate,
  updateReady: appUpdateReady,
  activeTaskCount: appUpdateActiveTaskCount,
} = appUpdater;

const isDesktop = isTauriRuntime();
const { toggleFullscreen } = useWindowControls();
const drawDesktopWindowFrame = shouldDrawDesktopWindowFrame(isMacOS(), isDesktop, isWindows());
const needsAuth = ref(!isDesktop);
const authenticated = ref(isDesktop);
const setupRequired = ref(false);

const showConnectionDialog = ref(false);
const connectionDialogPrefill = ref<ConnectionDeepLinkDraft | null>(null);
const connectionDialogInitialTab = ref<ConfigTab | undefined>(undefined);
const settingsInitialTab = ref("appearance");
const settingsInitialSection = ref<string | undefined>(undefined);
const settingsNavigationRequestId = ref(0);
const showQueryEditorDdlDialog = ref(false);
const showQueryEditorObjectSourceDialog = ref(false);
const showQuickOpen = ref(false);
const projectStore = useProjectStore();
watch(
  [() => projectStore.activeProject.value?.connectionId, () => connectionStore.connections.map((connection) => connection.id).join(",")],
  ([connectionId]) => {
    if (connectionId && connectionStore.getConfig(connectionId)) connectionStore.activeConnectionId = connectionId;
  },
  { immediate: true },
);
const projectDialog = ref<{ open: boolean; mode: "create" | "open" }>({ open: false, mode: "create" });
const menuSearchDialog = ref<{ open: boolean; mode: MenuSearchMode }>({ open: false, mode: "files" });
const sessionsDialogOpen = ref(false);
const showHistory = ref(safeLocalStorageGet("ogdeveloper-history-panel-open") === "true");
const showAiPanel = ref(safeLocalStorageGet("ogdeveloper-ai-panel-open") === "true");
const showSqlLibraryPanel = ref(safeLocalStorageGet("ogdeveloper-sql-library-open") === "true");
const showSqlFilePanel = ref(safeLocalStorageGet("ogdeveloper-sql-file-panel-open") === "true");
const showProjectFilePanel = ref(safeLocalStorageGet("ogdeveloper-project-file-panel-open") === "true");
const showGitPanel = ref(safeLocalStorageGet("ogdeveloper-git-panel-open") === "true");
const toolPanelRefs: Record<ToolPanelId, typeof showAiPanel> = {
  ai: showAiPanel,
  history: showHistory,
  sqlLibrary: showSqlLibraryPanel,
  sqlFile: showSqlFilePanel,
  projectFile: showProjectFilePanel,
  git: showGitPanel,
};
const toolPanelStorageKeys: Record<ToolPanelId, string> = {
  ai: "ogdeveloper-ai-panel-open",
  history: "ogdeveloper-history-panel-open",
  sqlLibrary: "ogdeveloper-sql-library-open",
  sqlFile: "ogdeveloper-sql-file-panel-open",
  projectFile: "ogdeveloper-project-file-panel-open",
  git: "ogdeveloper-git-panel-open",
};
const sidebarOpen = ref(safeLocalStorageGet("ogdeveloper-sidebar-open") !== "false");
const storedActiveToolPanel = safeLocalStorageGet("ogdeveloper-active-tool-panel");
const initialToolPanelSession = createToolPanelSession(Object.fromEntries(TOOL_PANEL_IDS.map((panelId) => [panelId, toolPanelRefs[panelId].value])) as ToolPanelState, storedActiveToolPanel);
for (const panelId of TOOL_PANEL_IDS) {
  toolPanelRefs[panelId].value = initialToolPanelSession.open[panelId];
  safeLocalStorageSet(toolPanelStorageKeys[panelId], String(initialToolPanelSession.open[panelId]));
}
safeLocalStorageSet("ogdeveloper-active-tool-panel", initialToolPanelSession.active ?? "");
const activeToolPanel = ref<ToolPanelId | null>(initialToolPanelSession.active);
const aiPanelReady = ref(false);
const { sidebarWidth, aiPanelWidth, historyWidth, sqlLibraryWidth, sqlFilePanelWidth, projectFilePanelWidth, gitPanelWidth, startSidebarResize, startAiPanelResize, startHistoryResize, startSqlLibraryResize, startSqlFilePanelResize, startProjectFilePanelResize, startGitPanelResize } =
  usePanelResize();
const aiAssistantRef = ref<AiAssistantHandle | null>(null);
const appSidebarRef = ref<InstanceType<typeof AppSidebar> | null>(null);
const appTabBarRef = ref<InstanceType<typeof AppTabBar> | null>(null);
const contentAreaRef = ref<InstanceType<typeof ContentArea> | null>(null);

const selectedSql = ref("");
const cursorPos = ref(0);
const formatSqlRequest = ref<{ id: number; tabId: string } | null>(null);
const compressSqlRequest = ref<{ id: number; tabId: string } | null>(null);
const activeOutputView = ref<"result" | "output" | "summary" | "explain" | "chart">("result");
const newQueryContextSource = ref<"tab" | "sidebar">("tab");
const queryEditorDdlTarget = ref<{ connectionId: string; database: string; catalog?: string; schema?: string; tableName: string; objectType?: ObjectSourceKind } | null>(null);
const queryEditorObjectSourceTarget = ref<{
  connectionId: string;
  database: string;
  schema?: string;
  name: string;
  objectType: ObjectSourceKind;
  initialEditing: boolean;
  signature?: string;
  relationName?: string;
} | null>(null);
const showSaveSqlDialog = ref(false);
const saveSqlAsNew = ref(false);
const saveSqlName = ref("");
const ROOT_SAVED_SQL_FOLDER = "__root__";
const { selection: saveSqlFolderId, pending: saveSqlFolderCreationPending, reset: resetSaveSqlFolderSelection, invalidate: invalidateSaveSqlFolderSelection, select: selectSaveSqlFolder } = useSaveSqlFolderSelection(ROOT_SAVED_SQL_FOLDER);
const pendingSaveAndCloseTabId = ref<string | null>(null);
const pendingPrevActiveTabId = ref<string | null>(null);
const pendingSaveShouldCloseTab = ref(true);
const pendingAppCloseAction = ref<AppCloseAction | null>(null);
const pendingCloseActionChoice = ref(false);

const activeTab = computed(() => queryStore.tabs.find((t) => t.id === queryStore.activeTabId));
// Debug sessions must not be evicted by the normal four-tab ContentArea cache:
// eviction unmounts the panel, stops the parked routine, and a later remount
// would execute it again. While a debugger tab exists, retain every open tab.
const contentAreaKeepAliveMax = computed(() => (queryStore.tabs.some((tab) => tab.mode === "routine-debug") ? Math.max(4, queryStore.tabs.length + 1) : 4));

const activeConnection = computed(() => {
  const tab = activeTab.value;
  return tab ? connectionStore.getConfig(tab.connectionId) : undefined;
});

function restoreHistorySql(sql: string, entry: HistoryEntry) {
  const tab = activeTab.value;
  if (tab?.mode === "query") {
    queryStore.updateSql(tab.id, sql);
    return;
  }

  const target = resolveHistorySqlRestoreTarget({
    entry,
    activeTab: tab,
    firstConnectionId: connectionStore.connections[0]?.id,
    getConfig: (connectionId) => connectionStore.getConfig(connectionId),
  });
  if (!target) return;
  const tabId = queryStore.createTab(target.connectionId, target.database, t("tabs.sql"), "query", target.schema);
  queryStore.updateSql(tabId, sql);
}

const executableSql = computed(() => {
  const tab = activeTab.value;
  return tab
    ? resolveExecutableSql(tab.sql, selectedSql.value, {
        mode: settingsStore.editorSettings.executeMode,
        cursorPos: cursorPos.value,
      })
    : "";
});

async function resolveActiveExecutableSql(snapshot?: SqlExecutionSnapshot) {
  const tab = activeTab.value;
  return tab
    ? await resolveExecutableSqlWithBackend(snapshot?.fullSql ?? tab.sql, snapshot?.selectedSql ?? selectedSql.value, {
        mode: settingsStore.editorSettings.executeMode,
        cursorPos: snapshot?.cursorPos ?? cursorPos.value,
        databaseType: activeConnection.value?.db_type,
      })
    : "";
}

const databaseRequiredSignal = ref(0);
const databaseRequiredTabId = ref<string | null>(null);

function promptActiveDatabaseSelection() {
  const tab = activeTab.value;
  if (!tab) return;
  databaseRequiredTabId.value = tab.id;
  databaseRequiredSignal.value += 1;
  toast(t("editor.selectDatabaseRequired"), 2500);
}

const {
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
} = useSqlExecution({
  activeTab,
  activeConnection,
  executableSql,
  resolveExecutableSql: resolveActiveExecutableSql,
  activeOutputView,
  onMissingDatabase: promptActiveDatabaseSelection,
});

function requestActiveEditorExecute() {
  if (contentAreaRef.value?.requestQueryEditorExecute?.()) return;
  void tryExecute();
}

function requestActiveEditorExecuteInNewResultTab() {
  if (contentAreaRef.value?.requestQueryEditorExecuteInNewResultTab?.()) return;
  void tryExecuteInNewResultTab();
}

function requestActiveEditorExecuteCurrent() {
  if (contentAreaRef.value?.requestQueryEditorExecuteCurrent?.()) return;
  void tryExecute();
}

const dialogs = useDialogSources();
const { getDatabaseOptions } = useDatabaseOptions();

async function openTableImportFromMenu() {
  const tab = activeTab.value;
  const connectionId = tab?.connectionId || connectionStore.activeConnectionId || connectionStore.connections[0]?.id;
  if (!connectionId) return;
  const connection = connectionStore.getConfig(connectionId);
  if (!connection) return;

  try {
    const databaseOptions = tab?.database ? [] : await getDatabaseOptions(connectionId);
    const database = (tab?.database || resolveDefaultDatabase(connection, databaseOptions)).trim();
    if (!database) {
      toast(t("editor.selectDatabaseRequired"), 2500);
      return;
    }

    await connectionStore.ensureConnected(connectionId);
    let schema = tab?.schema?.trim() || "";
    if (!schema && isSchemaAware(effectiveDatabaseTypeForConnection(connection))) {
      const schemas = await api.listSchemas(connectionId, database);
      schema = schemas.includes("public") ? "public" : schemas[0] || "";
    }

    connectionStore.tableImportSource = {
      connectionId,
      database,
      schema: schema || undefined,
    };
  } catch (error: any) {
    toast(error?.message || String(error), 4000);
  }
}

const { openLineageTarget, openDatabaseSearchTarget, openDiagramTarget, openObjectBrowserTableTarget, onStructureEditorSaved, openTableTarget } = useNavigationTargets(dialogs);
const { onExecuteSql, onReloadData, onPaginate, onSort } = useDataGridActions(activeTab);
const { setupTauriListeners, cleanupTauriListeners } = useTauriEvents({
  openTableTarget,
  openSqlFilePath,
  openDbFilePath,
  openConnectionDeepLink,
});
const { performCloseAction, setupCloseActionPromptListener, cleanupCloseActionPromptListener } = useCloseActionPrompt({ requestClose: requestAppClose });
useVisibilityChange();

const appVersion = ref("");
const isClassicLayout = computed(() => settingsStore.editorSettings.appLayout === "classic");
function openSettings(initialTab = "appearance", initialSection?: string) {
  settingsInitialTab.value = initialTab;
  settingsInitialSection.value = initialSection;
  settingsNavigationRequestId.value += 1;
  queryStore.openSettingsTab();
}

watch(
  () => settingsStore.settingsNavigationRequest,
  (request) => {
    if (!request) return;
    openSettings(request.tab, request.section);
    settingsStore.clearSettingsNavigationRequest(request.id);
  },
);
const hasSqlFileConnections = computed(() => connectionStore.connections.some((c) => supportsSqlFileExecution(c.db_type)));
const queryEditorDdlDatabaseType = computed(() => {
  if (!queryEditorDdlTarget.value?.connectionId) return undefined;
  return effectiveDatabaseTypeForConnection(connectionStore.getConfig(queryEditorDdlTarget.value.connectionId));
});
const queryEditorDdlDialect = computed(() => {
  return codeMirrorSqlDialect(queryEditorDdlDatabaseType.value);
});
const queryEditorObjectSourceDatabaseType = computed(() => {
  if (!queryEditorObjectSourceTarget.value?.connectionId) return undefined;
  return effectiveDatabaseTypeForConnection(connectionStore.getConfig(queryEditorObjectSourceTarget.value.connectionId));
});
const queryEditorObjectSourceDialect = computed(() => codeMirrorSqlDialect(queryEditorObjectSourceDatabaseType.value));
const queryEditorObjectSourceFormatDialect = computed(() => sqlFormatDialectForDbType(queryEditorObjectSourceDatabaseType.value));
const connectionStats = computed(() => ({
  total: connectionStore.connections.length,
  connected: connectionStore.connectedIds.size,
}));
const recentConnections = computed(() => connectionStore.connections.slice(0, 5));
const savedSqlHistoryItems = computed(() => {
  const folderById = new Map(savedSqlStore.allFolders.map((folder) => [folder.id, folder]));
  const folderPath = (folderId?: string): string | undefined => {
    if (!folderId) return undefined;
    const parts: string[] = [];
    const seen = new Set<string>();
    let folder = folderById.get(folderId);
    while (folder && !seen.has(folder.id)) {
      seen.add(folder.id);
      parts.unshift(folder.name);
      folder = folder.parentFolderId ? folderById.get(folder.parentFolderId) : undefined;
    }
    return parts.join("/");
  };
  return rankSavedSqlHistory(savedSqlStore.allFiles, { limit: 6 }).map((file) => {
    const connection = connectionStore.getConfig(file.connectionId);
    return {
      id: file.id,
      name: file.name,
      connectionName: connection ? connectionRedactedNameLabel(connection) : t("welcome.unknownConnection"),
      database: file.database,
      folderName: folderPath(file.folderId),
      openCount: file.openCount ?? 0,
    };
  });
});
const saveSqlFolders = computed(() => {
  const folderById = new Map(savedSqlStore.allFolders.map((folder) => [folder.id, folder]));
  const pathForFolder = (folderId: string) => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let folder = folderById.get(folderId);
    while (folder && !seen.has(folder.id)) {
      seen.add(folder.id);
      parts.unshift(folder.name);
      folder = folder.parentFolderId ? folderById.get(folder.parentFolderId) : undefined;
    }
    return parts.join(" / ");
  };
  return savedSqlStore.allFoldersTreeOrder.map((folder) => ({
    ...folder,
    displayName: pathForFolder(folder.id) || folder.name,
  }));
});

async function applyUiScale(scale: number) {
  if (!isDesktop) return;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(scale);
    window.dispatchEvent(new CustomEvent("ogdeveloper:ui-scale-applied", { detail: { scale } }));
  } catch (error) {
    console.warn("[ogdeveloper] Failed to apply UI scale", { scale, error });
  }
}

function setGlobalUiScale(scale: number) {
  settingsStore.updateEditorSettings({ uiScale: scale });
}

function zoomInUi() {
  setGlobalUiScale(settingsStore.editorSettings.uiScale + 0.1);
}

function zoomOutUi() {
  setGlobalUiScale(settingsStore.editorSettings.uiScale - 0.1);
}

function resetUiZoom() {
  setGlobalUiScale(1);
}

function applyUiFontFamily(fontFamily: string) {
  if (typeof document === "undefined") return;
  const next = fontFamily || DEFAULT_UI_FONT_FAMILY;
  // Override Tailwind's shared sans variable so app chrome and existing UI classes stay in sync.
  document.documentElement.style.setProperty(APP_FONT_SANS_CSS_VAR, next);
  document.body.style.fontFamily = `var(${APP_FONT_SANS_CSS_VAR}, ${DEFAULT_UI_FONT_FAMILY})`;
}

function applyDataGridFontFamily(fontFamily: string) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(DATA_GRID_FONT_FAMILY_CSS_VAR, fontFamily || DEFAULT_DATA_GRID_FONT_FAMILY);
}

const appUiFontFamilyStyle = computed<Record<string, string>>(() => {
  const fontFamily = settingsStore.editorSettings.uiFontFamily || DEFAULT_UI_FONT_FAMILY;
  return {
    [APP_FONT_SANS_CSS_VAR]: fontFamily,
    fontFamily: `var(${APP_FONT_SANS_CSS_VAR}, ${DEFAULT_UI_FONT_FAMILY})`,
  };
});

function isGlobalUiZoomTarget(target: EventTarget | null): target is Element {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-query-editor-root], [data-cell-detail-editor-root], [data-object-source-editor]")) {
    return true;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) {
    return false;
  }
  return !target.closest("[contenteditable='true']");
}

watch(
  () => queryStore.activeTabId,
  (id, previousId) => {
    if (previousId && previousId !== id && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("ogdeveloper:before-tab-switch", {
          detail: { tabId: id, fromTabId: previousId },
        }),
      );
    }
    if (id) newQueryContextSource.value = "tab";
    selectedSql.value = "";
    cursorPos.value = activeTab.value?.editorSelection?.head ?? 0;
    activeOutputView.value = "result";
    if (id) queryStore.reloadEvictedTab(id);
  },
);

watch(
  () => connectionStore.selectedTreeNodeId,
  (id) => {
    if (id) newQueryContextSource.value = "sidebar";
  },
);

watch(
  () => settingsStore.editorSettings.uiScale,
  (scale) => {
    void applyUiScale(scale);
  },
  { immediate: true },
);

watch(
  () => settingsStore.editorSettings.uiFontFamily,
  (fontFamily) => {
    applyUiFontFamily(fontFamily);
  },
  { immediate: true },
);

watch(
  () => settingsStore.editorSettings.tableFontFamily,
  (fontFamily) => {
    applyDataGridFontFamily(fontFamily);
  },
  { immediate: true },
);

function currentToolPanelState(): ToolPanelState {
  return Object.fromEntries(TOOL_PANEL_IDS.map((panelId) => [panelId, toolPanelRefs[panelId].value])) as ToolPanelState;
}

function currentToolPanelSession() {
  return { open: currentToolPanelState(), active: activeToolPanel.value };
}

function applyToolPanelSession(session: ReturnType<typeof createToolPanelSession>) {
  for (const panelId of TOOL_PANEL_IDS) {
    const panelRef = toolPanelRefs[panelId];
    if (panelRef.value === session.open[panelId]) continue;
    panelRef.value = session.open[panelId];
    safeLocalStorageSet(toolPanelStorageKeys[panelId], String(session.open[panelId]));
  }
  activeToolPanel.value = session.active;
  safeLocalStorageSet("ogdeveloper-active-tool-panel", session.active ?? "");
}

function setToolPanelOpen(panelId: ToolPanelId, open: boolean) {
  applyToolPanelSession(setToolPanelSessionOpen(currentToolPanelSession(), panelId, open));
}

function toggleToolPanel(panelId: ToolPanelId) {
  applyToolPanelSession(toggleToolPanelSession(currentToolPanelSession(), panelId));
}

function openToolPanel(panelId: ToolPanelId) {
  setToolPanelOpen(panelId, true);
}

function closeToolPanel(panelId: ToolPanelId) {
  setToolPanelOpen(panelId, false);
}

function invokeWhenAiReady(invoke: (handle: AiAssistantHandle) => void) {
  if (aiAssistantRef.value) {
    invoke(aiAssistantRef.value);
    return;
  }
  // AiAssistant 是异步组件，首次打开面板时单个 nextTick 不足以等待挂载完成，
  // 因此监听 ref，待其从 null 变为组件实例后再调用。
  const stop = watch(aiAssistantRef, (handle) => {
    if (handle) {
      stop();
      invoke(handle);
    }
  });
}

function fixWithAi(errorMessage: string) {
  openToolPanel("ai");
  invokeWhenAiReady((handle) => handle.triggerAction("fix", errorMessage));
}

function sendSelectionToAi(sql: string) {
  openToolPanel("ai");
  invokeWhenAiReady((handle) => handle.setPrompt(sql));
}

function openAiPanel() {
  openToolPanel("ai");
}

function analyzeHistoryWithAi(entry: HistoryEntry) {
  const connectionId = entry.connection_id || activeTab.value?.connectionId;
  if (!connectionId) {
    toast(t("history.aiAnalyzeNoConnection"), 5000);
    return;
  }

  const config = connectionStore.getConfig(connectionId);
  if (!config) {
    toast(t("history.aiAnalyzeNoConnection"), 5000);
    return;
  }

  openAiPanel();
  const database = entry.database || activeTab.value?.database || resolveDefaultDatabase(config, []);
  const title = t("history.aiAnalysisTab");
  const tabId = queryStore.createTab(connectionId, database || "", title, "query");
  queryStore.updateSql(tabId, entry.sql);
  invokeWhenAiReady((handle) => handle.triggerAction("explain", buildHistoryAiAnalysisPrompt(entry)));
}

function formatActiveSql() {
  const tab = activeTab.value;
  if (!tab || tab.mode !== "query" || !tab.sql.trim()) return;
  formatSqlRequest.value = {
    id: (formatSqlRequest.value?.id ?? 0) + 1,
    tabId: tab.id,
  };
}

function compressActiveSql() {
  const tab = activeTab.value;
  if (!tab || tab.mode !== "query" || !tab.sql.trim()) return;
  compressSqlRequest.value = {
    id: (compressSqlRequest.value?.id ?? 0) + 1,
    tabId: tab.id,
  };
}

function toggleSqlKeywordCase() {
  const sqlFormatter = settingsStore.editorSettings.sqlFormatter;
  settingsStore.updateEditorSettings({
    sqlFormatter: {
      ...sqlFormatter,
      keywordCase: sqlFormatter.keywordCase === "lower" ? "upper" : "lower",
    },
  });
}

function defaultSavedSqlName(title: string) {
  const trimmed = title.trim() || "query";
  const normalized = trimmed.replace(/\s+/g, "_");
  return normalized.endsWith(".sql") ? normalized : `${normalized}.sql`;
}

function canSaveSqlTab(tab: QueryTab): boolean {
  return !!tab.externalSqlPath || !!tab.sql.trim();
}

function closePendingSavedTab() {
  if (!pendingSaveAndCloseTabId.value) return;
  const closeId = pendingSaveAndCloseTabId.value;
  pendingSaveAndCloseTabId.value = null;
  if (pendingPrevActiveTabId.value) queryStore.activeTabId = pendingPrevActiveTabId.value;
  pendingPrevActiveTabId.value = null;
  const shouldCloseTab = pendingSaveShouldCloseTab.value;
  pendingSaveShouldCloseTab.value = true;
  if (shouldCloseTab) queryStore.closeTab(closeId, { force: true });
}

function cancelPendingSaveAndClose() {
  invalidateSaveSqlFolderSelection();
  showSaveSqlDialog.value = false;
  pendingSaveAndCloseTabId.value = null;
  pendingPrevActiveTabId.value = null;
  pendingSaveShouldCloseTab.value = true;
  cancelPendingAppClose();
}

function cancelPendingAppClose() {
  pendingAppCloseAction.value = null;
  pendingCloseActionChoice.value = false;
  pendingSaveShouldCloseTab.value = true;
}

function finishPendingAppClose(action: AppCloseAction) {
  pendingCloseActionChoice.value = false;
  pendingAppCloseAction.value = null;
  pendingSaveShouldCloseTab.value = true;
  void queryStore
    .flushPendingPersist()
    .catch(() => {})
    .finally(() => performCloseAction(action));
}

function continuePendingAppCloseAfterSave() {
  const action = pendingAppCloseAction.value;
  if (!action) return;
  if (queryStore.hasDirtyTabs) {
    pendingSaveShouldCloseTab.value = false;
    if (queryStore.requestAppCloseConfirmation()) return;
  }
  finishPendingAppClose(action);
}

function requestAppClose(action: AppCloseAction, _options: AppCloseRequestOptions = {}) {
  pendingCloseActionChoice.value = false;
  if (queryStore.hasDirtyTabs) {
    pendingAppCloseAction.value = action;
    pendingSaveShouldCloseTab.value = false;
    if (queryStore.requestAppCloseConfirmation()) return;
  }
  finishPendingAppClose(action);
}

function completePendingTabSave(tabId: string) {
  if (pendingAppCloseAction.value) {
    continuePendingAppCloseAfterSave();
    return;
  }
  queryStore.closeTab(tabId, { force: true });
}

function handleDiscardPendingTabClose() {
  if (!pendingAppCloseAction.value) return;
  continuePendingAppCloseAfterSave();
}

function handleDiscardAllPendingTabClose() {
  if (!pendingAppCloseAction.value) return;
  continuePendingAppCloseAfterSave();
}

async function saveExternalSqlPath(tab: QueryTab, options: { closeAfterSave?: boolean } = {}): Promise<boolean> {
  if (!tab.externalSqlPath || !isTauriRuntime()) return false;
  try {
    await api.writeExternalSqlFile(tab.externalSqlPath, tab.sql);
    rememberExternalSqlFileTarget(tab.externalSqlPath, { connectionId: tab.connectionId, database: tab.database });
    queryStore.markTabClean(tab);
    toast(t("savedSql.saved"), 2000);
    if (gitStore.isRepo) {
      void gitStore.refresh();
    }
    if (options.closeAfterSave) queryStore.closeTab(tab.id, { force: true });
    return true;
  } catch (e: any) {
    toast(t("toolbar.sqlSaveFailed", { message: e?.message || String(e) }), 5000);
    return true;
  }
}

function savedSqlTargetForSave(tab: QueryTab) {
  return savedSqlDefaultTargetForWrite({
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema,
    catalog: tab.catalog,
  });
}

async function saveTabForCloseAll(tabId: string): Promise<boolean> {
  const tab = queryStore.tabs.find((t) => t.id === tabId);
  if (!tab) return true;
  queryStore.activeTabId = tabId;

  if (tab.mode === "structure") {
    await nextTick();
    return (await contentAreaRef.value?.applyTableStructureChanges?.()) === true;
  }
  if (!canSaveSqlTab(tab)) return true;

  if (tab.objectSource) return saveActiveObjectSource(tab);

  if (await saveExternalSqlPath(tab)) return !queryStore.isTabDirty(tab);

  const existing = tab.savedSqlId ? savedSqlStore.getFile(tab.savedSqlId) : undefined;
  const target = savedSqlTargetForSave(tab);
  try {
    const saved = await savedSqlStore.saveFile({
      id: existing?.id,
      connectionId: target.connectionId,
      folderId: existing?.folderId,
      name: existing?.name || defaultSavedSqlName(tab.title),
      database: target.database,
      schema: target.schema,
      sql: tab.sql,
    });
    queryStore.linkSavedSql(tab.id, saved.id, saved.name);
    queryStore.markTabClean(tab);
    return true;
  } catch (e: any) {
    toast(t("savedSql.saveFailed", { message: e?.message || String(e) }), 5000);
    return false;
  }
}

async function handleSaveAllPendingTabClose() {
  const ids = [...queryStore.closeConfirmDirtyTabIds];
  if (!ids.length) return;
  queryStore.suspendCloseConfirm();

  for (const id of ids) {
    const saved = await saveTabForCloseAll(id);
    if (!saved) break;
  }

  if (queryStore.closeConfirmDirtyTabIds.length > 0) {
    queryStore.resumeCloseConfirm();
    return;
  }

  const result = queryStore.completePendingCloseAfterSaveAll();
  if (result === "app") continuePendingAppCloseAfterSave();
}

async function handleSaveTab(tabId: string) {
  const tab = queryStore.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (tab.mode === "structure") {
    queryStore.activeTabId = tabId;
    await nextTick();
    if (await contentAreaRef.value?.applyTableStructureChanges?.()) {
      completePendingTabSave(tabId);
    } else {
      queryStore.resumeCloseConfirm();
    }
    return;
  }
  if (!canSaveSqlTab(tab)) return;
  const closeAfterSave = pendingAppCloseAction.value === null;
  pendingSaveShouldCloseTab.value = closeAfterSave;
  if (tab.objectSource) {
    const saved = await saveActiveObjectSource(tab);
    if (saved) completePendingTabSave(tabId);
    else if (pendingAppCloseAction.value) cancelPendingAppClose();
    return;
  }
  if (await saveExternalSqlPath(tab, { closeAfterSave })) {
    if (!closeAfterSave) continuePendingAppCloseAfterSave();
    return;
  }
  const existing = tab.savedSqlId ? savedSqlStore.getFile(tab.savedSqlId) : undefined;
  if (existing) {
    const target = savedSqlTargetForSave(tab);
    const updated = await savedSqlStore.saveFile({
      id: existing.id,
      connectionId: target.connectionId,
      folderId: existing.folderId,
      name: existing.name,
      database: target.database,
      schema: target.schema,
      sql: tab.sql,
    });
    queryStore.linkSavedSql(tab.id, updated.id, updated.name);
    queryStore.markTabClean(tab);
    toast(t("savedSql.saved"), 2000);
    completePendingTabSave(tabId);
    return;
  }
  // No existing saved SQL — open save dialog, then close after save
  const prevActive = queryStore.activeTabId;
  queryStore.activeTabId = tabId;
  saveSqlName.value = defaultSavedSqlName(tab.title);
  resetSaveSqlFolderSelection(ROOT_SAVED_SQL_FOLDER);
  pendingSaveAndCloseTabId.value = tabId;
  pendingPrevActiveTabId.value = prevActive;
  showSaveSqlDialog.value = true;
}

function openDocs() {
  const url = "https://docs.opengauss.org";
  if (isTauriRuntime()) {
    import("@tauri-apps/plugin-shell").then(({ open }) => open(url));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function cycleThemeMode() {
  const nextMode = themeMode.value === "light" ? "dark" : themeMode.value === "dark" ? "system" : "light";
  setThemeMode(nextMode);
  const modeLabel = nextMode === "light" ? t("toolbar.themeLight") : nextMode === "dark" ? t("toolbar.themeDark") : t("toolbar.themeSystem");
  toast(`${t("toolbar.theme")}: ${modeLabel}`, 1600);
}

const activeActivityPanels = computed<ActivityPanelId[]>(() => {
  const panels: ActivityPanelId[] = [];
  if (sidebarOpen.value) panels.push("connections");
  if (activeToolPanel.value === "projectFile") panels.push("files");
  if (activeToolPanel.value === "sqlFile") panels.push("sqlFiles");
  if (activeToolPanel.value === "sqlLibrary") panels.push("library");
  if (activeToolPanel.value === "git") panels.push("git");
  if (activeToolPanel.value === "history") panels.push("history");
  if (activeToolPanel.value === "ai") panels.push("ai");
  return panels;
});

function handleActivityPanelToggle(panelId: ActivityPanelId) {
  if (panelId === "connections") {
    setSidebarOpen(!sidebarOpen.value);
  } else if (panelId === "files") {
    toggleToolPanel("projectFile");
  } else if (panelId === "sqlFiles") {
    toggleToolPanel("sqlFile");
  } else if (panelId === "library") {
    toggleToolPanel("sqlLibrary");
  } else if (panelId === "git") {
    toggleToolPanel("git");
  } else if (panelId === "history") {
    toggleToolPanel("history");
  } else if (panelId === "ai") {
    toggleToolPanel("ai");
  }
}

function openSaveSqlAsDialog() {
  const tab = activeTab.value;
  if (!tab || !canSaveSqlTab(tab)) return;
  saveSqlAsNew.value = true;
  saveSqlName.value = defaultSavedSqlName(tab.title);
  resetSaveSqlFolderSelection(ROOT_SAVED_SQL_FOLDER);
  showSaveSqlDialog.value = true;
}

async function openSaveSqlDialog() {
  const tab = activeTab.value;
  if (!tab || !canSaveSqlTab(tab)) return;
  if (tab.objectSource) {
    await saveActiveObjectSource(tab);
    return;
  }
  if (await saveExternalSqlPath(tab)) return;
  const existing = tab.savedSqlId ? savedSqlStore.getFile(tab.savedSqlId) : undefined;
  if (existing) {
    const target = savedSqlTargetForSave(tab);
    const updated = await savedSqlStore.saveFile({
      id: existing.id,
      connectionId: target.connectionId,
      folderId: existing.folderId,
      name: existing.name,
      database: target.database,
      schema: target.schema,
      sql: tab.sql,
    });
    queryStore.linkSavedSql(tab.id, updated.id, updated.name);
    queryStore.markTabClean(tab);
    toast(t("savedSql.saved"), 2000);
    return;
  }

  saveSqlName.value = defaultSavedSqlName(tab.title);
  resetSaveSqlFolderSelection(ROOT_SAVED_SQL_FOLDER);
  showSaveSqlDialog.value = true;
}

async function saveActiveObjectSource(tab: QueryTab): Promise<boolean> {
  const connection = connectionStore.getConfig(tab.connectionId);
  const source = tab.objectSource;
  if (!connection || !source) return false;

  try {
    const databaseType = effectiveDatabaseTypeForConnection(connection) ?? connection.db_type;
    const statements = await buildExecutableObjectSourceStatements({
      databaseType,
      objectType: source.objectType,
      schema: source.schema || tab.schema || tab.database,
      name: source.name,
      source: tab.sql,
    });
    const executableSql = statements.filter((sql) => sql.trim()).join(";\n");
    if (executableSql.trim()) {
      const saved = await executeWithProductionSqlGuard({
        connection,
        database: tab.database,
        sql: executableSql,
        source: t("production.sourceObjectSource"),
        execute: async () => {
          await executeObjectSourceSave(tab.connectionId, tab.database, databaseType, statements, source.schema || tab.schema);
          return true;
        },
      });
      if (!saved) return false;
    } else {
      await executeObjectSourceSave(tab.connectionId, tab.database, databaseType, statements, source.schema || tab.schema);
    }
    queryStore.markTabClean(tab);
    toast(t("objects.sourceSaved"), 2000);
    return true;
  } catch (e: any) {
    toast(t("objects.sourceSaveFailed", { message: e?.message || String(e) }), 5000);
    return false;
  }
}

function saveSqlFolderDisplayName(id: string) {
  if (id === ROOT_SAVED_SQL_FOLDER) return t("savedSql.rootFolder");
  const folder = saveSqlFolders.value.find((f) => f.id === id);
  return folder?.displayName ?? id;
}

function saveSqlFolderNormalizeCustom(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const folder = saveSqlFolders.value.find((f) => f.displayName === trimmed);
  return folder ? folder.id : trimmed;
}

async function handleSaveSqlFolderSelect(value: string) {
  const isExisting = value === ROOT_SAVED_SQL_FOLDER || saveSqlFolders.value.some((f) => f.id === value);
  if (isExisting) {
    await selectSaveSqlFolder(value);
    return;
  }
  const tab = activeTab.value;
  if (!tab) return;
  await selectSaveSqlFolder(
    value,
    async () => (await savedSqlStore.createFolder(tab.connectionId, value)).id,
    (error: any) => toast(t("savedSql.createFolderFailed", { message: error?.message || String(error) }), 5000),
  );
}

async function confirmSaveSqlToLibrary() {
  if (saveSqlFolderCreationPending.value) return;
  const tab = activeTab.value;
  const name = saveSqlName.value.trim();
  if (!tab || !tab.sql.trim() || !name) return;
  const project = projectStore.activeProject.value;
  if (project) {
    // 项目模式下：保存为 <项目>/sql/<名称>.sql 文件。
    try {
      const filePath = `${projectStore.sqlDirectory(project)}/${defaultSavedSqlName(name)}.sql`;
      await api.writeTextFile(filePath, tab.sql);
      queryStore.linkExternalSqlPath(tab.id, filePath, `${name}.sql`);
      queryStore.markTabClean(tab);
      saveSqlAsNew.value = false;
      showSaveSqlDialog.value = false;
      closePendingSavedTab();
      toast(t("savedSql.saved"), 2000);
    } catch (e: any) {
      toast(t("savedSql.saveFailed", { message: e?.message || String(e) }), 5000);
    }
    return;
  }
  try {
    const target = savedSqlTargetForSave(tab);
    const saved = await savedSqlStore.saveFile({
      id: saveSqlAsNew.value ? undefined : tab.savedSqlId,
      connectionId: target.connectionId,
      folderId: saveSqlFolderId.value === ROOT_SAVED_SQL_FOLDER ? undefined : saveSqlFolderId.value,
      name: defaultSavedSqlName(name),
      database: target.database,
      schema: target.schema,
      sql: tab.sql,
    });
    queryStore.linkSavedSql(tab.id, saved.id, saved.name);
    queryStore.markTabClean(tab);
    saveSqlAsNew.value = false;
    showSaveSqlDialog.value = false;
    closePendingSavedTab();
    toast(t("savedSql.saved"), 2000);
  } catch (e: any) {
    toast(t("savedSql.saveFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function saveActiveSqlAsLocalFile() {
  const tab = activeTab.value;
  if (!tab || !canSaveSqlTab(tab) || !isTauriRuntime()) return;
  try {
    const path = await api.saveExternalSqlFile(defaultSavedSqlName(tab.title), tab.sql);
    if (!path) return;
    queryStore.linkExternalSqlPath(tab.id, path, sqlFileTitleFromPath(path));
    rememberExternalSqlFileTarget(path, { connectionId: tab.connectionId, database: tab.database });
    invalidateSaveSqlFolderSelection();
    showSaveSqlDialog.value = false;
    closePendingSavedTab();
    toast(t("savedSql.saved"), 2000);
  } catch (e: any) {
    toast(t("toolbar.sqlSaveFailed", { message: e?.message || String(e) }), 5000);
  }
}

function applyExternalSqlFileTarget(tab: QueryTab, path: string) {
  const target = resolveExternalSqlFileTarget(path, (savedConnectionId) => !!connectionStore.getConfig(savedConnectionId), {
    connectionId: tab.connectionId,
    database: tab.database,
  });
  if (target.connectionId !== tab.connectionId) {
    queryStore.updateConnection(tab.id, target.connectionId, target.database);
  } else if (target.database !== tab.database) {
    queryStore.updateDatabase(tab.id, target.database);
  }
}

async function openSqlFile() {
  const tab = activeTab.value;
  if (!tab) return;
  try {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        filters: [{ name: "SQL", extensions: ["sql"] }],
        multiple: false,
      });
      if (path) {
        const sqlPath = path as string;
        const content = await api.readExternalSqlFile(sqlPath);
        queryStore.updateSql(tab.id, content);
        queryStore.linkExternalSqlPath(tab.id, sqlPath, sqlFileTitleFromPath(sqlPath));
        applyExternalSqlFileTarget(tab, sqlPath);
      }
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".sql";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          queryStore.updateSql(tab.id, await readBrowserSqlFile(file));
        } catch (e: any) {
          toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
        }
      };
      input.click();
    }
  } catch (e: any) {
    toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
  }
}

async function importResultArchive() {
  try {
    const bytes = await openQueryResultArchiveFile();
    if (!bytes) return;
    const tabId = await queryStore.importResultArchive(bytes);
    if (!tabId) {
      toast(t("tabs.resultArchiveImportInvalid"), 5000);
      return;
    }
    activeOutputView.value = "result";
    toast(t("tabs.resultArchiveImported"), 2500);
  } catch (e: any) {
    toast(t("tabs.resultArchiveImportFailed", { message: e?.message || String(e) }), 5000);
  }
}

function pasteClipboardAsSqlInCondition() {
  void contentAreaRef.value?.pasteClipboardAsSqlInCondition?.();
}

// Cold-start file arguments can arrive while persisted tabs are still being
// restored. Keep external SQL tabs behind that phase only, so unrelated
// initialization cannot permanently block files opened from the OS.
let desktopOpenTabsRestorationBarrier: OpenTabsRestorationBarrier | null = null;

async function openSqlFilePath(path: string) {
  try {
    await desktopOpenTabsRestorationBarrier?.settled;
    const content = await api.readExternalSqlFile(path);
    const connectionId = connectionStore.activeConnectionId || activeTab.value?.connectionId || connectionStore.connections[0]?.id || "";
    const connection = connectionId ? connectionStore.getConfig(connectionId) : undefined;
    const database = activeTab.value?.database || (connection ? resolveDefaultDatabase(connection, []) : "");
    const target = resolveExternalSqlFileTarget(path, (savedConnectionId) => !!connectionStore.getConfig(savedConnectionId), { connectionId, database });
    queryStore.openExternalSqlFile(target.connectionId, target.database, path, content);
  } catch (e: any) {
    toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
  }
}

async function openPendingSqlFiles() {
  if (!isTauriRuntime()) return;
  try {
    const paths = await api.pendingOpenSqlFiles();
    for (const path of paths) {
      await openSqlFilePath(path);
    }
  } catch {
    /* ignore startup file-open probing errors */
  }
}

async function openDbFilePath(_path: string) {
  // openGauss desktop client does not open local db files
}

async function openPendingDbFiles() {
  // openGauss desktop client does not open local db files
}

async function openConnectionDeepLink(url: string) {
  await connectionStore.initFromDisk();
  try {
    const draft = parseConnectionDeepLink(url);
    if (!draft) return;
    connectionStore.stopEditing();
    connectionStore.stopCreatingConnectionInGroup();
    connectionDialogPrefill.value = draft;
    showConnectionDialog.value = true;
  } catch (e: any) {
    toast(
      t("connection.parseConnectionUrlFailed", {
        message: e?.message || String(e),
      }),
      5000,
    );
  }
}

async function openPendingConnectionLinks() {
  if (!isTauriRuntime()) return;
  try {
    const links = await api.pendingOpenConnectionLinks();
    for (const link of links) {
      await openConnectionDeepLink(link);
    }
  } catch {
    /* ignore startup deep-link probing errors */
  }
}

function setConnectionDialogOpen(value: boolean) {
  showConnectionDialog.value = value;
  if (!value) {
    connectionDialogPrefill.value = null;
    connectionDialogInitialTab.value = undefined;
  }
}

function openConnectionSettings(connectionId: string, initialTab: ConfigTab = "connection") {
  if (!connectionStore.getConfig(connectionId)) return;
  connectionDialogInitialTab.value = initialTab;
  connectionStore.startEditing(connectionId);
  showConnectionDialog.value = true;
}

async function newQuery() {
  const target = resolveNewQueryTarget({
    activeTab: activeTab.value,
    selectedTreeNode: findTreeNodeById(connectionStore.treeNodes, connectionStore.selectedTreeNodeId),
    activeConnectionId: connectionStore.activeConnectionId,
    connections: connectionStore.connections,
    preferredSource: newQueryContextSource.value,
  });
  if (!target) return;
  const conn = connectionStore.getConfig(target.connectionId);
  if (!conn) return;
  connectionStore.activeConnectionId = target.connectionId;
  // Prefill the editor with `SELECT * FROM <focused table>` when enabled and a
  // table context (active data/structure tab or selected table node) is available.
  // Built before createTab so the tab opens with the content directly (no flash).
  const initialSql = resolveNewQueryInitialSql({
    activeTab: activeTab.value,
    selectedTreeNode: findTreeNodeById(connectionStore.treeNodes, connectionStore.selectedTreeNodeId),
    preferredSource: newQueryContextSource.value,
    prefillEnabled: settingsStore.editorSettings.prefillNewQueryWithSelect,
    targetConnectionId: target.connectionId,
    targetDatabase: target.database,
    databaseType: effectiveDatabaseTypeForConnection(conn),
  });
  const tabId = queryStore.createTab(conn.id, target.database, undefined, "query", target.schema, initialSql, target.catalog);
  if (initialSql) {
    const prefilledTab = queryStore.tabs.find((t) => t.id === tabId);
    if (prefilledTab) {
      prefilledTab.editorSelection = { anchor: initialSql.length, head: initialSql.length };
    }
  }
  try {
    await connectionStore.ensureConnected(target.connectionId);
    if (target.shouldRefreshDefaultDatabase) {
      const options = await getDatabaseOptions(target.connectionId);
      queryStore.updateDatabase(tabId, resolveDefaultDatabase(conn, options));
    }
  } catch (e: any) {
    toast(
      t("connection.connectFailed", {
        message: translateBackendError(t, e),
      }),
      5000,
    );
  }
}

async function openConnectionQuery(connectionId: string) {
  const connection = connectionStore.getConfig(connectionId);
  if (!connection) return;
  connectionStore.activeConnectionId = connectionId;
  const tabId = queryStore.createTab(connectionId, connection.database || "postgres");
  try {
    await connectionStore.ensureConnected(connectionId);
    const options = await getDatabaseOptions(connectionId);
    const target = quickConnectionOpenTarget(connection, options);
    if (target.kind === "query") {
      queryStore.updateDatabase(tabId, target.database);
    }
  } catch (e: any) {
    toast(
      t("connection.connectFailed", {
        message: translateBackendError(t, e),
      }),
      5000,
    );
  }
}

async function openSavedSqlFromWelcome(fileId: string) {
  const file = await savedSqlStore.ensureFileContent(fileId);
  if (!file) return;
  const tabId = queryStore.openSavedSql(file);
  connectionStore.activeConnectionId = queryStore.tabs.find((tab) => tab.id === tabId)?.connectionId ?? file.connectionId;
  void savedSqlStore.recordFileUsage(file.id);
  toast(t("welcome.fileOpened", { name: file.name }), 2000);
}

function tableTargetFromActiveTab(table: string | SqlObjectNavigationTarget) {
  const tab = activeTab.value;
  if (!tab) return null;
  const connectionId = tab.connectionId;
  const catalog = tab.tableMeta?.catalog || tab.catalog;
  if (typeof table !== "string") {
    // Structured targets already separate qualifiers; reparsing would corrupt quoted object names that contain dots.
    return {
      connectionId,
      database: table.database || tab.database,
      catalog,
      schema: table.schema || tab.schema,
      tableName: table.name,
      tableType: table.type ? sqlObjectNavigationTableType(table) : undefined,
    };
  }

  let database = tab.database;
  let schema = tab.schema;
  const tableName = table;

  const parts = tableName.split(".").filter(Boolean);
  const rawTableName = parts[parts.length - 1] || tableName;
  if (parts.length >= 3) {
    database = parts[parts.length - 3] || database;
    schema = parts[parts.length - 2];
  } else if (parts.length === 2) {
    const dbType = connectionStore.getConfig(connectionId)?.db_type;
    if (dbType && !isSchemaAware(dbType) && !isSingleDatabase(dbType)) {
      database = parts[0] || database;
      schema = undefined;
    } else {
      schema = parts[0];
    }
  }

  return { connectionId, database, catalog, schema, tableName: rawTableName, tableType: undefined };
}

async function onClickTable(table: SqlObjectNavigationTarget) {
  // Procedures/functions/packages open source (same as sidebar view-source), not table data/DDL.
  if (isSqlObjectNavigationRoutineType(table.type)) {
    await onOpenObjectSource(table, false);
    return;
  }
  const target = tableTargetFromActiveTab(table);
  if (!target) return;
  const objectType = sqlObjectNavigationSourceKind(table);
  if (objectType) {
    // Definition navigation for views must not run the view query, which may be expensive or have side effects upstream.
    queryEditorDdlTarget.value = { ...target, objectType };
    showQueryEditorDdlDialog.value = true;
    return;
  }
  if (settingsStore.editorSettings.clickTableNavigationTarget === "ddl") {
    queryStore.openTableStructure(target.connectionId, target.database, target.schema, target.tableName, "ddl", undefined, target.catalog);
    return;
  }
  try {
    await openTableTarget(target, { tableInfoTab: "ddl" });
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e) }), 5000);
  }
}

async function onViewTableData(table: SqlObjectNavigationTarget) {
  const target = tableTargetFromActiveTab(table);
  if (!target) return;
  try {
    await openTableTarget(target);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e) }), 5000);
  }
}

function onViewTableDdl(table: SqlObjectNavigationTarget) {
  const target = tableTargetFromActiveTab(table);
  if (!target) return;
  queryEditorDdlTarget.value = { ...target, objectType: sqlObjectNavigationSourceKind(table) };
  showQueryEditorDdlDialog.value = true;
}

function onEditTableStructure(table: SqlObjectNavigationTarget) {
  const target = tableTargetFromActiveTab(table);
  // Keep view-like objects out of the table editor even if a stale menu dispatches this event.
  if (!target || sqlObjectNavigationSourceKind(table)) return;
  queryStore.openTableStructure(target.connectionId, target.database, target.schema, target.tableName, undefined, undefined, target.catalog);
}

async function onOpenObjectSource(table: SqlObjectNavigationTarget, initialEditing: boolean) {
  const provisionalTarget = tableTargetFromActiveTab(table);
  if (!provisionalTarget) return;
  const navigation = table;
  const target = tableTargetFromActiveTab(navigation);
  const objectType = sqlObjectNavigationSourceKind(navigation);
  if (!target || !objectType) return;
  const sourceName = sqlObjectNavigationSourceName(navigation);
  const sourceSchema = sqlObjectNavigationSourceSchema(navigation, target.schema || target.database);
  try {
    await connectionStore.ensureConnected(target.connectionId);
    connectionStore.activeConnectionId = target.connectionId;
    // Align Ctrl/Cmd+click with sidebar "view source" (dialog vs data tab).
    if (settingsStore.editorSettings.routineSourceOpenMode === "query-tab") {
      try {
        const resolvedDatabaseType = effectiveDatabaseTypeForConnection(connectionStore.getConfig(target.connectionId));
        if (!resolvedDatabaseType) throw new Error("Connection type is unavailable.");
        // Wrap Oracle bare ALL_SOURCE (`procedure name is ...`) as CREATE OR REPLACE for the editor.
        const {
          raw,
          editableSource,
          objectType: resolvedType,
        } = await loadEditableObjectSourceForEditor(api.getObjectSource, buildEditableObjectSource, {
          connectionId: target.connectionId,
          database: target.database,
          schema: sourceSchema || target.database,
          name: sourceName,
          objectType,
          databaseType: resolvedDatabaseType,
          signature: navigation.signature,
        });
        const tabId = queryStore.createTab(target.connectionId, target.database, `Source - ${sourceName}`, "query", sourceSchema, editableSource, target.catalog, { forceNew: true });
        const sourceIsEditable = raw.editable !== false && !["SEQUENCE", "TRIGGER", "TYPE", "TYPE_BODY"].includes(resolvedType);
        if (sourceIsEditable) {
          queryStore.setObjectSource(tabId, {
            schema: sourceSchema || target.database,
            name: sourceName,
            objectType: resolvedType,
            signature: navigation.signature,
          });
        }
      } catch (e: any) {
        toast(e?.message || String(e), 5000);
      }
      return;
    }
    queryEditorObjectSourceTarget.value = {
      connectionId: target.connectionId,
      database: target.database,
      schema: sourceSchema,
      name: sourceName,
      objectType,
      initialEditing,
      signature: navigation.signature,
    };
    showQueryEditorObjectSourceDialog.value = true;
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e) }), 5000);
  }
}

function onQueryEditorObjectSourceSaved() {
  const target = queryEditorObjectSourceTarget.value;
  if (!target) return;
  connectionStore.invalidateMetadataCache(target.connectionId, target.database, target.schema, target.name);
  connectionStore.invalidateCompletionCache(target.connectionId, target.database);
  contentAreaRef.value?.refreshQueryEditorCompletionCache();
}

async function changeActiveConnection(connectionId: string) {
  const tab = activeTab.value;
  if (!tab) return;
  const connection = connectionStore.getConfig(connectionId);
  if (!connection) return;
  queryStore.updateConnection(tab.id, connectionId, resolveDefaultDatabase(connection, []));
  connectionStore.activeConnectionId = connectionId;
  try {
    await connectionStore.ensureConnected(connectionId);
    const options = await getDatabaseOptions(connectionId);
    const database = resolveDefaultDatabase(connection, options);
    queryStore.updateDatabase(tab.id, database);
  } catch (e: any) {
    toast(
      t("connection.connectFailed", {
        message: translateBackendError(t, e),
      }),
      5000,
    );
  }
}

function changeActiveDatabase(database: string) {
  const tab = activeTab.value;
  if (tab) {
    queryStore.updateDatabase(tab.id, database);
    if (databaseRequiredTabId.value === tab.id && database) {
      databaseRequiredTabId.value = null;
    }
  }
}

function changeActiveCatalog(catalog: string | undefined, database: string) {
  const tab = activeTab.value;
  if (tab) queryStore.updateCatalog(tab.id, catalog, database);
}

async function setActiveDatabaseAsDefault() {
  const tab = activeTab.value;
  if (!tab || !tab.connectionId || !tab.database || tab.catalog) return;
  await connectionStore.setDefaultDatabase(tab.connectionId, tab.database);
}

async function clearActiveDefaultDatabase() {
  const tab = activeTab.value;
  if (!tab || !tab.connectionId) return;
  await connectionStore.clearDefaultDatabase(tab.connectionId);
}

function changeActiveSchema(schema: string | undefined) {
  const tab = activeTab.value;
  if (tab) queryStore.updateSchema(tab.id, schema);
}

const aboutDialogOpen = ref(false);
function openAbout() {
  aboutDialogOpen.value = true;
}

// ---------------------------------------------------------------------------
// 项目（工作区）与菜单栏搜索/编辑命令
// ---------------------------------------------------------------------------

function onMenuCreateProject() {
  projectDialog.value = { open: true, mode: "create" };
}

function onMenuOpenProject() {
  projectDialog.value = { open: true, mode: "open" };
}

function onMenuSelectProject(projectId: string) {
  projectStore.setActiveProject(projectId);
  const project = projectStore.projects.value.find((candidate) => candidate.id === projectId);
  if (project?.connectionId && connectionStore.getConfig(project.connectionId)) {
    connectionStore.activeConnectionId = project.connectionId;
  }
  toast(t("menus.projectActivated"), 2000);
}

function onCreateProject(name: string, path: string, connectionId?: string, details?: { description?: string }) {
  projectStore.addProject(name, path, {
    connectionId,
    description: details?.description,
  });
  if (connectionId) connectionStore.activeConnectionId = connectionId;
  toast(t("menus.projectActivated"), 2000);
}

function openMenuSearch(mode: MenuSearchMode) {
  menuSearchDialog.value = { open: true, mode };
}

function openDatabaseSearch(target: { keyword: string; connectionId: string; database: string }) {
  if (!target.connectionId || !target.database) {
    toast(t("searchCenter.targetRequired"), 3500);
    return;
  }
  connectionStore.databaseSearchSource = {
    connectionId: target.connectionId,
    database: target.database,
    keyword: target.keyword.trim() || undefined,
  };
}

type EditorMenuAction = "undo" | "redo" | "cut" | "copy" | "paste" | "find" | "replace";

function dispatchEditorMenuAction(action: EditorMenuAction) {
  if (activeTab.value?.mode !== "query") return;
  window.dispatchEvent(new CustomEvent("ogdeveloper-editor-command", { detail: { action } }));
}

function openFileFromMenuSearch(path: string) {
  void openSqlFilePath(path);
}

const OBJECT_SOURCE_KINDS = new Set(["VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "SYNONYM", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY", "JOB"]);

function openObjectFromMenuSearch(hit: { connectionId: string; database: string; schema: string; objectType: string; name: string; signature?: string }) {
  const objectType = hit.objectType.toUpperCase();
  if (objectType === "TABLE" || objectType === "COLUMN") {
    const ddlTarget = menuSearchTableDdlTarget(hit);
    if (!ddlTarget) return;
    queryEditorDdlTarget.value = ddlTarget;
    showQueryEditorDdlDialog.value = true;
    return;
  }
  const kind = OBJECT_SOURCE_KINDS.has(objectType) ? objectType : "VIEW";
  if (["VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY", "TRIGGER"].includes(kind)) {
    queryStore.openProgramWindow({
      connectionId: hit.connectionId,
      database: hit.database,
      schema: hit.schema || undefined,
      name: hit.name,
      objectType: kind as ObjectSourceKind,
      signature: hit.signature,
    });
    return;
  }
  queryEditorObjectSourceTarget.value = {
    connectionId: hit.connectionId,
    database: hit.database,
    schema: hit.schema || undefined,
    name: hit.name,
    objectType: kind as ObjectSourceKind,
    signature: hit.signature,
    initialEditing: false,
  };
  showQueryEditorObjectSourceDialog.value = true;
}

function setSidebarOpen(open: boolean) {
  sidebarOpen.value = open;
  safeLocalStorageSet("ogdeveloper-sidebar-open", open ? "true" : "false");
}

function ensureQueryTab(): string {
  const tab = activeTab.value;
  if (tab && tab.mode === "query") return tab.id;
  const connId = connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
  const sameConnectionTab = tab?.connectionId === connId ? tab : undefined;
  const db = sameConnectionTab?.database || connectionStore.getConfig(connId)?.database || "";
  const schema = sameConnectionTab?.schema ?? sameConnectionTab?.objectBrowser?.schema ?? sameConnectionTab?.tableMeta?.schema;
  const catalog = sameConnectionTab?.catalog ?? sameConnectionTab?.objectBrowser?.catalog ?? sameConnectionTab?.tableMeta?.catalog;
  return queryStore.createTab(connId, db, undefined, "query", schema, undefined, catalog);
}

function onAiReplaceSql(sql: string) {
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, sql);
}

function runAiGeneratedSql(sql: string) {
  selectedSql.value = "";
  nextTick(() => tryExecute(sql));
}

function onAiExecuteSql(sql: string) {
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, buildAppendedEditorSql(activeTab.value?.sql || "", sql));
  runAiGeneratedSql(sql);
}

function onAiTempRunSql(sql: string) {
  ensureQueryTab();
  runAiGeneratedSql(sql);
}

function onAiRequestAutoExecuteSql(sql: string) {
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, buildAppendedEditorSql(activeTab.value?.sql || "", sql));
  selectedSql.value = "";

  const productionAssessment = assessProductionSql(sql, activeConnection.value, activeTab.value?.database);
  if (productionAssessment.active && productionAssessment.isMutation) {
    toast(t("production.aiReviewRequired"), 5000);
    return;
  }

  const decision = classifyAiSqlExecution(sql, activeConnection.value);
  if (decision.action === "block") {
    toast(t("ai.autoSqlBlocked"), 5000);
    return;
  }

  nextTick(() => {
    if (decision.action === "auto_execute") {
      void doExecute(sql);
      return;
    }
    dangerSql.value = sql;
    pendingDangerSql.value = sql;
    showDangerDialog.value = true;
  });
}

function onAiOpenExplainPlan(sql: string) {
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, buildAppendedEditorSql(activeTab.value?.sql || "", sql));
  selectedSql.value = "";
  nextTick(() => {
    void tryExplain(sql);
  });
}

async function handleQuickOpenSelect(item: any) {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();

  // Handle SQL file types first — they don't require a database connection
  if (item.type === "sql_file" && item.filePath) {
    try {
      const content = await api.readExternalSqlFile(item.filePath);
      const connectionId = connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
      const connection = connectionId ? connectionStore.getConfig(connectionId) : undefined;
      const database = connection ? resolveDefaultDatabase(connection, []) : "";
      queryStore.openExternalSqlFile(connectionId, database, item.filePath, content);
    } catch (e: any) {
      toast(
        externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)),
        5000,
      );
    }
    return;
  }

  if (item.type === "sql_library_file" && item.sqlFileId) {
    const file = await savedSqlStore.ensureFileContent(item.sqlFileId);
    if (!file) return;
    const tabId = queryStore.openSavedSql(file);
    connectionStore.activeConnectionId = queryStore.tabs.find((tab) => tab.id === tabId)?.connectionId ?? file.connectionId;
    void savedSqlStore.recordFileUsage(file.id);
    return;
  }

  // For all other types, set the active connection
  connectionStore.activeConnectionId = item.connectionId;

  // Ensure connection is connected
  try {
    await connectionStore.ensureConnected(item.connectionId);
  } catch (error) {
    console.error("Failed to connect:", error);
    return;
  }

  // Navigate based on type
  if (item.type === "connection") {
    // Expand connection node in sidebar
    // Tree node ID for connection is just the connectionId
    const connNode = findTreeNodeById(connectionStore.treeNodes, item.connectionId);
    if (connNode && !connNode.isExpanded) {
      await connectionStore.loadDatabases(item.connectionId);
    }
    return;
  } else if (item.type === "database") {
    // Expand connection node first
    // Tree node ID for connection is just the connectionId
    const connNode = findTreeNodeById(connectionStore.treeNodes, item.connectionId);
    if (connNode && !connNode.isExpanded) {
      await connectionStore.loadDatabases(item.connectionId);
    }

    // Expand database node
    // Tree node ID for database is `${connectionId}:${database_name}`
    const dbNodeId = `${item.connectionId}:${item.database}`;
    const dbNode = findTreeNodeById(connectionStore.treeNodes, dbNodeId);
    if (dbNode && !dbNode.isExpanded) {
      const config = connectionStore.getConfig(item.connectionId);
      const effectiveDbType = effectiveDatabaseTypeForConnection(config);
      if (usesTreeSchemaMode(effectiveDbType) && !connectionUsesDatabaseObjectTreeMode(config)) {
        await connectionStore.loadSchemas(item.connectionId, item.database);
      } else {
        await connectionStore.loadTables(item.connectionId, item.database);
      }
    }
    return;
  } else if (item.type === "schema") {
    const dbNode = findTreeNodeById(connectionStore.treeNodes, `${item.connectionId}:${item.database}`);
    if (dbNode && !dbNode.isExpanded) await connectionStore.loadSchemas(item.connectionId, item.database);
    const schemaNode = findTreeNodeById(connectionStore.treeNodes, `${item.connectionId}:${item.database}:${item.schema}`);
    if (schemaNode && !schemaNode.isExpanded) await connectionStore.loadTables(item.connectionId, item.database, item.schema);
    return;
  } else if (item.type === "table" || item.type === "view" || item.type === "materialized_view") {
    // Open the table/view in a data tab
    await openTableTarget({
      connectionId: item.connectionId,
      database: item.database,
      schema: item.schema,
      tableName: item.objectName || item.tableName,
      tableType: item.type === "view" ? "VIEW" : item.type === "materialized_view" ? "MATERIALIZED_VIEW" : "TABLE",
    });
  } else if (item.type === "procedure" || item.type === "function" || item.type === "trigger" || item.type === "sequence" || item.type === "package" || item.type === "package-body" || item.type === "type" || item.type === "type-body") {
    // Open the object source in a source tab
    const objectTypeMap: Record<string, ObjectSourceKind> = {
      procedure: "PROCEDURE",
      function: "FUNCTION",
      trigger: "TRIGGER",
      sequence: "SEQUENCE",
      package: "PACKAGE",
      "package-body": "PACKAGE_BODY",
      type: "TYPE",
      "type-body": "TYPE_BODY",
    };

    const objectType = objectTypeMap[item.type];
    if (!objectType) return;

    const schema = item.schema || item.database;
    try {
      const databaseType = effectiveDatabaseTypeForConnection(connectionStore.getConfig(item.connectionId));
      if (!databaseType) throw new Error("Connection type is unavailable.");
      const objectName = item.objectName || item.tableName;
      const { editableSource, objectType: resolvedType } = await loadEditableObjectSourceForEditor(api.getObjectSource, buildEditableObjectSource, {
        connectionId: item.connectionId,
        database: item.database,
        schema,
        name: objectName,
        objectType,
        databaseType,
        signature: item.signature,
      });
      const tabId = queryStore.createTab(item.connectionId, item.database, `Source - ${objectName}`);
      queryStore.updateSql(tabId, editableSource);
      if (item.type !== "sequence" && item.type !== "trigger" && item.type !== "type" && item.type !== "type-body") {
        queryStore.setObjectSource(tabId, {
          schema,
          name: objectName,
          objectType: resolvedType,
          signature: item.signature,
        });
      }
      queryStore.markTabClean(queryStore.tabs.find((tab) => tab.id === tabId));
    } catch (error) {
      toast((error as any)?.message || String(error), 5000);
    }
  }
}

function dispatchBeforeTabSwitch(tabId: string) {
  if (tabId === queryStore.activeTabId) return;
  window.dispatchEvent(new CustomEvent("ogdeveloper:before-tab-switch", { detail: { tabId, fromTabId: queryStore.activeTabId } }));
}

function openCommandWindowFromMenu() {
  const targetId = activeTab.value?.connectionId || connectionStore.activeConnectionId || [...connectionStore.connectedIds][0] || connectionStore.connections[0]?.id;
  if (targetId) {
    queryStore.openCommandWindow(targetId, activeTab.value?.database, activeTab.value?.schema);
  }
}

function closeActiveTab() {
  if (queryStore.activeTabId) queryStore.closeTab(queryStore.activeTabId);
}

function closeOtherTabs() {
  appTabBarRef.value?.closeOtherActiveTabs();
}

function activateQueryTab(tabId: string): boolean {
  if (!queryStore.tabs.some((tab) => tab.id === tabId)) return false;
  dispatchBeforeTabSwitch(tabId);
  queryStore.activeTabId = tabId;
  return true;
}

function activateTabByIndex(index: number): boolean {
  const tab = queryStore.tabs[index];
  return tab ? activateQueryTab(tab.id) : false;
}

function activateAdjacentTab(direction: -1 | 1): boolean {
  const count = queryStore.tabs.length;
  if (count < 2) return false;
  const currentIndex = queryStore.tabs.findIndex((tab) => tab.id === queryStore.activeTabId);
  const nextIndex = currentIndex < 0 ? (direction > 0 ? 0 : count - 1) : (currentIndex + direction + count) % count;
  return activateTabByIndex(nextIndex);
}

function handleNativeSelectAll(e: KeyboardEvent) {
  if (shouldBlockAppNativeSelectAll(e)) e.preventDefault();
}

function handleKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) return;

  const shortcuts = settingsStore.editorSettings.shortcuts;
  const switchTabIndex = switchToTabIndexFromShortcut(e, shortcuts);

  if (isOpenSettingsShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    openSettings();
    return;
  }
  if (isQuickOpenShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    showQuickOpen.value = true;
    return;
  }
  if (connectionStore.connections.length > 0 && isSearchObjectSourceShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    openMenuSearch("objects");
    return;
  }
  if (connectionStore.connections.length > 0 && isSearchMetadataShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    openMenuSearch("metadata");
    return;
  }
  if (connectionStore.connections.length > 0 && isSearchTableDataShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    openMenuSearch("data");
    return;
  }
  if (isFocusSearchShortcut(e, shortcuts)) {
    const focused = contentAreaRef.value?.focusSearch() || appSidebarRef.value?.focusSearch();
    if (focused) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (isRefreshDataShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    contentAreaRef.value?.refreshData();
    return;
  }
  if (isNewQueryShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    void newQuery();
    return;
  }
  if (isToggleSidebarShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    setSidebarOpen(!sidebarOpen.value);
    return;
  }
  if (switchTabIndex != null) {
    if (activateTabByIndex(switchTabIndex)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (isSwitchToPreviousTabShortcut(e, shortcuts)) {
    if (activateAdjacentTab(-1)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (isSwitchToNextTabShortcut(e, shortcuts)) {
    if (activateAdjacentTab(1)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (isCloseOtherTabsShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    appTabBarRef.value?.closeOtherActiveTabs();
    return;
  }
  if (isCloseTabShortcut(e, shortcuts)) {
    e.preventDefault();
    closeActiveTab();
    return;
  }
  if (isNewConnectionShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    showConnectionDialog.value = true;
    return;
  }
  if (isCommandWindowShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    openCommandWindowFromMenu();
    return;
  }
  if (activeTab.value?.mode === "query" && isOpenSqlFileShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    void openSqlFile();
    return;
  }
  if (activeTab.value?.mode === "query" && canSaveSqlTab(activeTab.value) && isSaveSqlAsShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    openSaveSqlAsDialog();
    return;
  }
  if (isImportResultShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    void importResultArchive();
    return;
  }
  if (isImportConnectionsShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    dialogs.onImportClick();
    return;
  }
  if (isExportConnectionsShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    dialogs.onExportClick();
    return;
  }
  if (isCreateProjectShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    onMenuCreateProject();
    return;
  }
  if (isOpenProjectShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    onMenuOpenProject();
    return;
  }
  if (isDesktop && isCloneFromGitShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    gitStore.openCloneDialog();
    return;
  }
  if (activeTab.value?.mode === "query" && isCompressSqlShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    compressActiveSql();
    return;
  }
  if (activeTab.value?.mode === "query" && isExecuteCurrentStatementShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    requestActiveEditorExecuteCurrent();
    return;
  }
  if (activeTab.value?.mode === "query" && isExplainSqlShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    tryExplain();
    return;
  }
  if (activeTab.value?.txnSessionId && isCommitTransactionShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    void queryStore.commitTransaction(activeTab.value.id);
    return;
  }
  if (activeTab.value?.txnSessionId && isRollbackTransactionShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    void queryStore.rollbackTransaction(activeTab.value.id);
    return;
  }
  if (activeTab.value && isToggleAutoCommitShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    queryStore.setAutoCommit(activeTab.value.id, !(activeTab.value.autoCommit ?? true));
    return;
  }
  if (isSaveShortcut(e, shortcuts) && e.target instanceof Element && isObjectSourceSaveShortcutTarget(e.target)) {
    return;
  }
  if (activeTab.value?.mode === "query" && !showSaveSqlDialog.value && isSaveShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    void openSaveSqlDialog();
    return;
  }
  if (activeTab.value?.mode === "query" && isExecuteSqlInNewResultTabShortcut(e, shortcuts) && e.target instanceof Element && e.target.closest("[data-query-editor-root]")) {
    e.preventDefault();
    e.stopPropagation();
    requestActiveEditorExecuteInNewResultTab();
    return;
  }
  if (activeTab.value?.mode === "query" && isExecuteSqlShortcut(e, shortcuts) && e.target instanceof Element && e.target.closest("[data-query-editor-root]")) {
    e.preventDefault();
    e.stopPropagation();
    requestActiveEditorExecute();
    return;
  }
  if (activeTab.value?.mode === "query" && isSendSelectionToAiShortcut(e, shortcuts) && e.target instanceof Element && e.target.closest("[data-query-editor-root]")) {
    e.preventDefault();
    e.stopPropagation();
    if (selectedSql.value.trim()) sendSelectionToAi(selectedSql.value);
    return;
  }
  if (isModRShortcut(e) && e.target instanceof Element && contentAreaRef.value?.handleModRTarget(e.target)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (isDesktop && isGlobalUiZoomTarget(e.target)) {
    if (isZoomInShortcut(e, shortcuts)) {
      e.preventDefault();
      e.stopPropagation();
      zoomInUi();
      return;
    }
    if (isZoomOutShortcut(e, shortcuts)) {
      e.preventDefault();
      e.stopPropagation();
      zoomOutUi();
      return;
    }
    if (isResetZoomShortcut(e, shortcuts)) {
      e.preventDefault();
      e.stopPropagation();
      resetUiZoom();
      return;
    }
  }
  if (isDesktop && isBrowserReloadShortcut(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function onLoginSuccess() {
  authenticated.value = true;
  setupRequired.value = false;
  needsAuth.value = true;
  window.history.replaceState(null, "", webPath("/"));
  // The mount-time version fetch 401s before login; retry once authenticated.
  api
    .getAppVersion()
    .then((v) => {
      appVersion.value = v;
    })
    .catch(() => {});
  void initApp();
}

async function initApp() {
  const t0 = performance.now();
  console.log("[STARTUP] initApp begin");
  const restoreOpenTabs = async () => {
    await settingsStore.initEditorSettings();
    console.log(`[STARTUP]   settingsStore.initEditorSettings: ${(performance.now() - t0).toFixed(0)}ms`);
    await connectionStore.initFromDisk();
    console.log(`[STARTUP]   connectionStore.initFromDisk: ${(performance.now() - t0).toFixed(0)}ms`);
    await queryStore.initOpenTabs({ validConnectionIds: connectionStore.connections.map((connection) => connection.id) });
    console.log(`[STARTUP]   queryStore.initOpenTabs: ${(performance.now() - t0).toFixed(0)}ms`);
  };

  if (!desktopOpenTabsRestorationBarrier) await settingsStore.initAiConfigs();
  try {
    if (desktopOpenTabsRestorationBarrier) {
      await initializeDesktopOpenTabs({
        barrier: desktopOpenTabsRestorationBarrier,
        initializeOptionalState: () => settingsStore.initAiConfigs(),
        restoreOpenTabs,
        onOptionalStateError: (error) => console.error("[STARTUP] settingsStore.initAiConfigs failed", error),
      });
    } else {
      await restoreOpenTabs();
    }
    await settingsStore.initDesktopSettings().catch(() => {});

    void promptTemplateStore.init();

    void Promise.all([initSavedSqlEditorPositions(), savedSqlStore.initFromStorage()])
      .then(() => {
        console.log(`[STARTUP]   savedSqlStore.initFromStorage: ${(performance.now() - t0).toFixed(0)}ms`);
        void queryStore.hydrateSavedSqlTabs();
      })
      .catch((e: any) => {
        toast(t("connection.loadFailed", { message: e?.message || String(e) }), 5000);
      });

    restoreActiveConnectionContext();
  } catch (e: any) {
    toast(t("connection.loadFailed", { message: e?.message || String(e) }), 5000);
  }
}

function scheduleStartupUpdateCheck() {
  // 启用更新提醒时，启动完成后静默检查一次应用更新；发现更新时弹出提醒对话框，
  // “已是最新”/检查失败不打扰用户。延迟几秒避免与启动初始化争抢网络。
  if (!isDesktop || !settingsStore.editorSettings.updateNotificationsEnabled) return;
  setTimeout(() => {
    void appUpdater.checkUpdates({ silent: true });
  }, 3000);
}

function onAboutCheckUpdates() {
  aboutDialogOpen.value = false;
  void appUpdater.checkUpdates();
}

function restoreActiveConnectionContext() {
  const activeConnectionId = activeTab.value?.connectionId || connectionStore.activeConnectionId;
  if (activeConnectionId && connectionStore.getConfig(activeConnectionId)) {
    connectionStore.activeConnectionId = activeConnectionId;
  }
}

function handleContextMenu(e: MouseEvent) {
  const target = e.target as HTMLElement;

  // Check if target is a standard editable input element
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (import.meta.env.DEV) {
      console.debug("[contextmenu] Allowing for input/textarea:", target);
    }
    return;
  }

  // Check if target or any parent has contenteditable attribute
  if (target.isContentEditable || target.closest("[contenteditable]")) {
    if (import.meta.env.DEV) {
      console.debug("[contextmenu] Allowing for contenteditable:", target);
    }
    return;
  }

  // Check if target is within a custom context menu container or collection item
  if (target.closest("[data-reka-collection-item], [data-radix-vue-collection-item], [data-context-menu]")) {
    if (import.meta.env.DEV) {
      console.debug("[contextmenu] Allowing for custom context menu container:", target);
    }
    return;
  }

  // Prevent default context menu for all other elements
  if (import.meta.env.DEV) {
    console.debug("[contextmenu] Preventing default for:", target);
  }
  e.preventDefault();
}

onMounted(async () => {
  console.log("[STARTUP] onMounted begin");
  const mountStart = performance.now();
  requestAnimationFrame(() => {
    aiPanelReady.value = true;
  });
  applyTheme();
  void applyUiScale(settingsStore.editorSettings.uiScale);
  window.addEventListener("keydown", handleNativeSelectAll, true);
  window.addEventListener("keydown", handleKeydown);
  if (isDesktop) {
    document.addEventListener("contextmenu", handleContextMenu);
  }
  // macOS: Ctrl+click fires both click and contextmenu.
  // Intercept click in capture phase to prevent unwanted navigation.
  // Windows/Linux use Ctrl+click for multi-select; do not block there.
  document.addEventListener(
    "click",
    (e) => {
      if (e.ctrlKey && isMacOS()) e.stopPropagation();
    },
    true,
  );
  if (!isDesktop) {
    try {
      const res = await fetch(apiUrl("/api/auth/check"));
      const data = await res.json();
      needsAuth.value = data.required;
      authenticated.value = data.authenticated;
      setupRequired.value = data.setup_required;
    } catch {
      /* server unreachable */
    }
    if (needsAuth.value && !authenticated.value) {
      history.replaceState(null, "", webPath("/login"));
    }
    if (!setupRequired.value && (!needsAuth.value || authenticated.value)) void initApp();
    api
      .getAppVersion()
      .then((v) => {
        appVersion.value = v;
      })
      .catch(() => {});
    return;
  }
  desktopOpenTabsRestorationBarrier = createOpenTabsRestorationBarrier();
  void initApp().then(() => scheduleStartupUpdateCheck());
  void projectStore.ensureDefaultProject({ defaultProjectsRoot: api.defaultProjectsRoot, ensureDirectory: api.ensureDirectory });
  setupFileDrop().catch(() => {});
  api
    .getAppVersion()
    .then((v) => {
      appVersion.value = v;
    })
    .catch(() => {});
  setupTauriListeners();
  setupCloseActionPromptListener();
  void openPendingSqlFiles();
  void openPendingDbFiles();
  void openPendingConnectionLinks();
  console.log(`[STARTUP] onMounted sync done: ${(performance.now() - mountStart).toFixed(0)}ms`);
});

onUnmounted(() => {
  cleanupTauriListeners();
  cleanupCloseActionPromptListener();
  window.removeEventListener("keydown", handleNativeSelectAll, true);
  window.removeEventListener("keydown", handleKeydown);
  document.removeEventListener("contextmenu", handleContextMenu);
});
</script>

<template>
  <LoginPage v-if="setupRequired || (needsAuth && !authenticated)" :setup-mode="setupRequired" @authenticated="onLoginSuccess" />
  <div v-show="!setupRequired && (!needsAuth || authenticated)" class="fixed inset-0 h-screen w-screen overflow-hidden">
    <TooltipProvider :delay-duration="300">
      <div class="h-screen w-screen max-w-full min-w-[760px] min-h-[600px] flex flex-col bg-background text-foreground overflow-hidden" :class="{ 'ogdeveloper-desktop-window-frame': drawDesktopWindowFrame }" :style="appUiFontFamilyStyle">
        <AppToolbar
          :theme-mode="themeMode"
          :has-connections="connectionStore.connections.length > 0"
          :has-sql-file-connections="hasSqlFileConnections"
          :has-active-tab="!!activeTab"
          :has-active-query="activeTab?.mode === 'query'"
          :has-active-transaction="!!activeTab?.txnSessionId"
          :can-save-sql="!!activeTab && activeTab.mode === 'query' && canSaveSqlTab(activeTab)"
          :projects="projectStore.projects.value"
          :active-project-id="projectStore.activeProjectId.value"
          :auto-commit="activeTab?.autoCommit ?? true"
          :sidebar-open="sidebarOpen"
          @new-connection="showConnectionDialog = true"
          @new-query="newQuery"
          @open-editor-sql-file="openSqlFile"
          @save-sql="void openSaveSqlDialog()"
          @save-sql-as="openSaveSqlAsDialog()"
          @import-result-archive="importResultArchive"
          @close-active-tab="closeActiveTab"
          @close-other-tabs="closeOtherTabs"
          @import-config="dialogs.onImportClick()"
          @export-config="dialogs.onExportClick()"
          @create-project="onMenuCreateProject"
          @open-project="onMenuOpenProject"
          @clone-from-git="gitStore.openCloneDialog"
          @select-project="onMenuSelectProject"
          @undo="dispatchEditorMenuAction('undo')"
          @redo="dispatchEditorMenuAction('redo')"
          @cut="dispatchEditorMenuAction('cut')"
          @copy="dispatchEditorMenuAction('copy')"
          @paste="dispatchEditorMenuAction('paste')"
          @find="dispatchEditorMenuAction('find')"
          @replace="dispatchEditorMenuAction('replace')"
          @format-sql="formatActiveSql"
          @compress-sql="compressActiveSql"
          @execute-sql="requestActiveEditorExecute"
          @execute-current-statement="requestActiveEditorExecuteCurrent"
          @explain-sql="() => tryExplain()"
          @commit-transaction="() => activeTab && queryStore.commitTransaction(activeTab.id)"
          @rollback-transaction="() => activeTab && queryStore.rollbackTransaction(activeTab.id)"
          @toggle-auto-commit="() => activeTab && queryStore.setAutoCommit(activeTab.id, !(activeTab.autoCommit ?? true))"
          @toggle-sidebar="setSidebarOpen(!sidebarOpen)"
          @toggle-fullscreen="toggleFullscreen"
          @toggle-ai="toggleToolPanel('ai')"
          @toggle-history="toggleToolPanel('history')"
          @toggle-sql-library="toggleToolPanel('sqlLibrary')"
          @toggle-sql-file-panel="toggleToolPanel('sqlFile')"
          @toggle-project-file-panel="toggleToolPanel('projectFile')"
          @toggle-git-panel="toggleToolPanel('git')"
          @open-settings="(tab?: string) => openSettings(tab ?? 'appearance')"
          @set-theme-mode="setThemeMode"
          @search-files="openMenuSearch('files')"
          @search-metadata="openMenuSearch('metadata')"
          @search-objects="openMenuSearch('objects')"
          @quick-open="showQuickOpen = true"
          @search-table-data="openMenuSearch('data')"
          @open-sessions="
            () => {
              const targetId = connectionStore.activeConnectionId || [...connectionStore.connectedIds][0] || activeTab?.connectionId || connectionStore.connections[0]?.id;
              if (targetId) {
                queryStore.openProcessList(targetId);
              } else {
                sessionsDialogOpen = true;
              }
            }
          "
          @open-invalid-objects="dialogs.showInvalidObjectsDialog.value = true"
          @open-command-window="openCommandWindowFromMenu"
          @open-table-import="void openTableImportFromMenu()"
          @open-database-export="dialogs.showDatabaseExportDialog.value = true"
          @open-transfer="dialogs.showTransferDialog.value = true"
          @open-sql-file="dialogs.showSqlFileDialog.value = true"
          @open-schema-diff="dialogs.showSchemaDiffDialog.value = true"
          @open-data-compare="dialogs.showDataCompareDialog.value = true"
          @open-shortcuts="openSettings('shortcuts')"
          @open-docs="openDocs"
          @export-debug-logs="downloadDebugLogs"
          @open-about="openAbout"
        />

        <div class="flex-1 flex min-h-0 w-full overflow-hidden">
          <!-- Activity Bar (Far Left Dock) -->
          <AppActivityBar
            :active-panels="activeActivityPanels"
            :is-dark="isDark"
            :theme-mode="themeMode"
            :show-history="settingsStore.editorSettings.toolbarItems.history"
            :show-ai="settingsStore.editorSettings.toolbarItems.ai"
            :show-theme="settingsStore.editorSettings.toolbarItems.theme"
            @toggle-panel="handleActivityPanelToggle"
            @open-settings="openSettings('appearance')"
            @cycle-theme="cycleThemeMode"
          />

          <div class="flex-1 min-w-0 flex min-h-0 overflow-hidden" :class="isClassicLayout ? 'app-layout-classic' : 'app-panel-gutter gap-1 p-1'">
            <AppSidebar
              v-show="sidebarOpen"
              ref="appSidebarRef"
              :sidebar-width="sidebarWidth"
              :classic-layout="isClassicLayout"
              @import="dialogs.onImportClick"
              @export="dialogs.onExportClick"
              @new-connection="showConnectionDialog = true"
              @start-resize="startSidebarResize"
              @collapse="setSidebarOpen(false)"
              @open-settings="(initialTab) => openSettings(initialTab ?? 'appearance')"
            />

            <div :class="isClassicLayout ? 'flex-1 min-w-0 overflow-hidden' : 'flex-1 min-w-0 overflow-hidden rounded-md border border-border/80 bg-background'">
              <div class="h-full flex flex-col min-w-0">
                <AppTabBar ref="appTabBarRef" @save-tab="handleSaveTab" @discard-tab-close="handleDiscardPendingTabClose" @save-all-tab-close="handleSaveAllPendingTabClose" @discard-all-tab-close="handleDiscardAllPendingTabClose" @cancel-tab-close="cancelPendingAppClose" />
                <div v-if="activeTab" class="flex flex-col flex-1 min-h-0">
                  <EditorToolbar
                    v-if="activeTab.mode === 'query' && !isPreviewTab(activeTab)"
                    :active-tab="activeTab"
                    :active-connection="activeConnection"
                    :executable-sql="executableSql"
                    :explain-mode="explainMode"
                    :sql-keyword-case="settingsStore.editorSettings.sqlFormatter.keywordCase"
                    :database-required-signal="databaseRequiredTabId === activeTab.id ? databaseRequiredSignal : 0"
                    :auto-commit="activeTab.autoCommit ?? true"
                    :txn-session-id="activeTab?.txnSessionId"
                    :txn-auto-rolled-back="activeTab?.txnAutoRolledBack"
                    @update:explain-mode="(m: 'explain' | 'autotrace') => (explainMode = m)"
                    @update:auto-commit="
                      (v: boolean) => {
                        if (activeTab) queryStore.setAutoCommit(activeTab.id, v);
                      }
                    "
                    @commit="activeTab && queryStore.commitTransaction(activeTab.id)"
                    @rollback="activeTab && queryStore.rollbackTransaction(activeTab.id)"
                    @dismiss-txn-rolled-back="activeTab && (activeTab.txnAutoRolledBack = false)"
                    @execute="requestActiveEditorExecute()"
                    @cancel="cancelActiveExecution()"
                    @explain="tryExplain()"
                    @format-sql="formatActiveSql"
                    @compress-sql="compressActiveSql"
                    @toggle-sql-keyword-case="toggleSqlKeywordCase"
                    @save-sql="void openSaveSqlDialog()"
                    @open-sql="openSqlFile"
                    @import-result-archive="importResultArchive"
                    @paste-sql-in-condition="pasteClipboardAsSqlInCondition"
                    @change-connection="changeActiveConnection"
                    @change-database="changeActiveDatabase"
                    @change-catalog="changeActiveCatalog"
                    @change-schema="changeActiveSchema"
                    @set-default-database="setActiveDatabaseAsDefault"
                    @clear-default-database="clearActiveDefaultDatabase"
                  />
                  <KeepAlive :max="contentAreaKeepAliveMax">
                    <ContentArea
                      ref="contentAreaRef"
                      :key="activeTab.id"
                      :active-tab="activeTab"
                      :active-connection="activeConnection"
                      :executable-sql="executableSql"
                      :active-output-view="activeOutputView"
                      :format-sql-request="formatSqlRequest"
                      :compress-sql-request="compressSqlRequest"
                      :selected-sql="selectedSql"
                      :cursor-pos="cursorPos"
                      :app-version="appVersion"
                      :settings-initial-tab="settingsInitialTab"
                      :settings-initial-section="settingsInitialSection"
                      :settings-navigation-request-id="settingsNavigationRequestId"
                      @update:active-output-view="activeOutputView = $event"
                      @fix-with-ai="fixWithAi"
                      @send-selection-to-ai="sendSelectionToAi"
                      @execute="tryExecute($event)"
                      @execute-in-new-result-tab="tryExecuteInNewResultTab($event)"
                      @cancel="cancelActiveExecution()"
                      @explain="tryExplain()"
                      @editor-update="(tabId: string, v: string) => queryStore.updateSql(tabId, v)"
                      @editor-selection-change="(v: string) => (selectedSql = v)"
                      @editor-cursor-change="(p: number) => (cursorPos = p)"
                      @editor-viewport-change="(tabId: string, viewport: { scrollTop: number; scrollLeft: number }) => queryStore.updateEditorViewport(tabId, viewport)"
                      @editor-selection-state-change="(tabId: string, selection: { anchor: number; head: number }) => queryStore.updateEditorSelection(tabId, selection)"
                      @format-error="toast(t('toolbar.formatSqlFailed'))"
                      @save-sql="void openSaveSqlDialog()"
                      @reload="(sql, searchText, whereInput, orderBy, limit, offset, intent) => onReloadData(sql, searchText, whereInput, orderBy, limit, offset, intent)"
                      @paginate="onPaginate"
                      @sort="onSort"
                      @execute-sql="onExecuteSql"
                      @click-table="onClickTable"
                      @view-table-data="onViewTableData"
                      @debug-procedure="
                        (sql) => {
                          if (activeTab?.routineTest) {
                            queryStore.openRoutineDebug({
                              connectionId: activeTab.connectionId,
                              database: activeTab.database,
                              schema: activeTab.routineTest.schema,
                              routineKind: activeTab.routineTest.routineKind || 'procedure',
                              routineName: activeTab.routineTest.routineName,
                              signature: activeTab.routineTest.signature,
                              callSql: sql,
                            });
                          }
                        }
                      "
                      @edit-table-structure="onEditTableStructure"
                      @view-table-ddl="onViewTableDdl"
                      @open-object-source="onOpenObjectSource"
                      @open-object-table="
                        (target) =>
                          activeTab &&
                          openObjectBrowserTableTarget({
                            connectionId: activeTab.connectionId,
                            database: activeTab.database,
                            schema: target.schema,
                            catalog: target.catalog,
                            tableName: target.tableName,
                            tableType: target.tableType,
                          })
                      "
                      @object-schema-change="(schema) => activeTab && queryStore.updateSchema(activeTab.id, schema)"
                      @object-browser-viewport-change="(tabId, viewport) => queryStore.updateObjectBrowserViewport(tabId, viewport)"
                      @structure-editor-saved="
                        (commentChanged) =>
                          activeTab &&
                          onStructureEditorSaved(
                            onReloadData,
                            toast,
                            {
                              connectionId: activeTab.connectionId,
                              database: activeTab.database,
                              schema: activeTab.schema,
                              catalog: activeTab.catalog,
                              tableName: activeTab.structureTableName || '',
                            },
                            commentChanged,
                          )
                      "
                      @structure-editor-close="activeTab && queryStore.closeTab(activeTab.id)"
                      @open-settings="openSettings"
                      @open-connection-settings="openConnectionSettings"
                      @check-updates="void appUpdater.checkUpdates()"
                    />
                  </KeepAlive>
                </div>
                <WelcomeScreen
                  v-else
                  :connection-stats="connectionStats"
                  :recent-connections="recentConnections"
                  :saved-sql-history-items="savedSqlHistoryItems"
                  :app-version="appVersion"
                  :has-connections="connectionStore.connections.length > 0"
                  @open-connection-query="openConnectionQuery"
                  @open-saved-sql="openSavedSqlFromWelcome"
                  @new-connection="showConnectionDialog = true"
                  @new-query="newQuery"
                  @show-history="openToolPanel('history')"
                  @import-config="dialogs.onImportClick"
                  @open-about="openAbout"
                />
              </div>
            </div>

            <div v-if="activeToolPanel === 'ai'" :class="isClassicLayout ? 'h-full shrink-0 relative z-30 isolate bg-background' : 'h-full shrink-0 relative z-30 isolate rounded-md border border-border/80 bg-background'" :style="{ width: aiPanelWidth + 'px' }">
              <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startAiPanelResize" />
              <div class="h-full min-h-0 overflow-hidden rounded-[inherit]">
                <AiAssistant
                  v-if="aiPanelReady"
                  ref="aiAssistantRef"
                  :tab="activeTab"
                  :connection="activeConnection"
                  @replace-sql="onAiReplaceSql"
                  @execute-sql="onAiExecuteSql"
                  @temp-run-sql="onAiTempRunSql"
                  @request-auto-execute-sql="onAiRequestAutoExecuteSql"
                  @open-explain-plan="onAiOpenExplainPlan"
                  @close="closeToolPanel('ai')"
                />
              </div>
            </div>

            <div v-if="activeToolPanel === 'history'" :class="isClassicLayout ? 'h-full shrink-0 relative z-30 isolate bg-background' : 'h-full shrink-0 relative z-30 isolate rounded-md border border-border/80 bg-background'" :style="{ width: historyWidth + 'px' }">
              <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startHistoryResize" />
              <div class="h-full min-h-0 overflow-hidden rounded-[inherit]">
                <QueryHistory :current-connection-id="activeTab?.connectionId" :current-database="activeTab?.database" @restore="restoreHistorySql" @analyze-ai="analyzeHistoryWithAi" @close="closeToolPanel('history')" />
              </div>
            </div>

            <div v-if="activeToolPanel === 'sqlLibrary'" :class="isClassicLayout ? 'h-full shrink-0 relative z-30 isolate bg-background' : 'h-full shrink-0 relative z-30 isolate rounded-md border border-border/80 bg-background'" :style="{ width: sqlLibraryWidth + 'px' }">
              <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startSqlLibraryResize" />
              <div class="h-full min-h-0 overflow-hidden rounded-[inherit]">
                <SqlLibraryPanel @close="closeToolPanel('sqlLibrary')" />
              </div>
            </div>

            <div v-if="activeToolPanel === 'sqlFile'" :class="isClassicLayout ? 'h-full shrink-0 relative z-30 isolate bg-background' : 'h-full shrink-0 relative z-30 isolate rounded-md border border-border/80 bg-background'" :style="{ width: sqlFilePanelWidth + 'px' }">
              <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startSqlFilePanelResize" />
              <div class="h-full min-h-0 overflow-hidden rounded-[inherit]">
                <SqlFilePanel @close="closeToolPanel('sqlFile')" />
              </div>
            </div>

            <div v-if="activeToolPanel === 'projectFile'" :class="isClassicLayout ? 'h-full shrink-0 relative z-30 isolate bg-background' : 'h-full shrink-0 relative z-30 isolate rounded-md border border-border/80 bg-background'" :style="{ width: projectFilePanelWidth + 'px' }">
              <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startProjectFilePanelResize" />
              <div class="h-full min-h-0 overflow-hidden rounded-[inherit]">
                <ProjectFilesPanel @close="closeToolPanel('projectFile')" @create-project="onMenuCreateProject" />
              </div>
            </div>

            <div v-if="activeToolPanel === 'git'" :class="isClassicLayout ? 'h-full shrink-0 relative z-30 isolate bg-background' : 'h-full shrink-0 relative z-30 isolate rounded-md border border-border/80 bg-background'" :style="{ width: gitPanelWidth + 'px' }">
              <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startGitPanelResize" />
              <div class="h-full min-h-0 overflow-hidden rounded-[inherit]">
                <GitPanel @close="closeToolPanel('git')" @create-project="onMenuCreateProject" />
              </div>
            </div>
          </div>
        </div>

        <BottomStatusBar
          :active-tab="activeTab"
          :active-connection="activeConnection"
          :connected="!!activeConnection && connectionStore.connectedIds.has(activeConnection.id)"
          :cursor-pos="cursorPos"
          :ui-scale="settingsStore.editorSettings.uiScale"
          @change-schema="changeActiveSchema"
          @toggle-auto-commit="() => activeTab && queryStore.setAutoCommit(activeTab.id, !(activeTab.autoCommit ?? true))"
          @set-ui-scale="setGlobalUiScale"
        />

        <AppDialogs
          :show-connection-dialog="showConnectionDialog"
          :connection-prefill="connectionDialogPrefill"
          :connection-initial-tab="connectionDialogInitialTab"
          :show-danger-dialog="showDangerDialog"
          :danger-sql="dangerSql"
          :suppress-danger-confirm="suppressDangerConfirm"
          :active-database-type="activeConnection?.db_type"
          :active-connection-id="activeTab?.connectionId || connectionStore.activeConnectionId || undefined"
          :active-database="activeTab?.database || activeConnection?.database || undefined"
          :active-schema="activeTab?.schema || undefined"
          :show-sql-parameter-dialog="showSqlParameterDialog"
          :sql-parameter-source-sql="sqlParameterSourceSql"
          :sql-parameter-names="sqlParameterNames"
          :sql-parameter-database-type="sqlParameterDatabaseType"
          :sql-parameter-enabled-syntaxes="sqlParameterEnabledSyntaxes"
          @update:show-connection-dialog="setConnectionDialogOpen"
          @update:show-danger-dialog="showDangerDialog = $event"
          @update:suppress-danger-confirm="suppressDangerConfirm = $event"
          @update:show-sql-parameter-dialog="showSqlParameterDialog = $event"
          @danger-confirm="onDangerConfirm"
          @sql-parameters-confirm="onSqlParametersConfirm"
          @connect-started="(name: string) => toast(t('connection.connecting', { name }), 30000)"
          @connect-succeeded="(name: string) => toast(t('connection.connectSuccess', { name }), 2000)"
          @connect-failed="
            (msg: string) =>
              toast(
                t('connection.connectFailed', {
                  message: translateBackendError(t, msg),
                }),
                5000,
              )
          "
          @open-driver-store="setConnectionDialogOpen(false)"
          @open-lineage-target="openLineageTarget"
          @open-database-search-target="openDatabaseSearchTarget"
          @open-diagram-target="openDiagramTarget"
        />
        <GitCloneDialog :open="gitStore.cloneDialogOpen" @update:open="gitStore.cloneDialogOpen = $event" @cloned="toggleToolPanel('projectFile')" />
        <GitDiffDialog />
        <QuickOpenDialog :open="showQuickOpen" @update:open="showQuickOpen = $event" @select="handleQuickOpenSelect" />
        <ProjectDialog :open="projectDialog.open" :mode="projectDialog.mode" @update:open="projectDialog.open = $event" @create="onCreateProject" @select="onMenuSelectProject" />
        <SessionsDialog :open="sessionsDialogOpen" @update:open="sessionsDialogOpen = $event" />
        <MenuSearchDialog
          :open="menuSearchDialog.open"
          :mode="menuSearchDialog.mode"
          :preferred-connection-id="activeTab?.connectionId || connectionStore.activeConnectionId || undefined"
          :preferred-database="activeTab?.database || undefined"
          @update:open="menuSearchDialog.open = $event"
          @open-file="openFileFromMenuSearch"
          @open-object="openObjectFromMenuSearch"
          @open-data-search="openDatabaseSearch"
        />
      </div>
      <Teleport to="body">
        <Transition name="toast">
          <div v-if="toastVisible" class="fixed bottom-6 inset-x-0 w-max max-w-[90vw] sm:max-w-3xl mx-auto z-99999 px-4 py-2 rounded-lg bg-foreground text-background text-sm shadow-lg select-text whitespace-pre-wrap break-words">
            {{ toastMessage }}
          </div>
        </Transition>
      </Teleport>

      <Dialog
        :open="showSaveSqlDialog"
        @update:open="
          (open: boolean) => {
            showSaveSqlDialog = open;
            if (!open) {
              invalidateSaveSqlFolderSelection();
              if (pendingSaveAndCloseTabId) cancelPendingSaveAndClose();
            }
          }
        "
      >
        <DialogContent class="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{{ t("savedSql.saveToLibrary") }}</DialogTitle>
          </DialogHeader>
          <div class="space-y-3">
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ t("savedSql.fileName") }}</label>
              <Input v-model="saveSqlName" @keydown.enter.prevent="confirmSaveSqlToLibrary" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ t("savedSql.folder") }}</label>
              <SearchableSelect
                :model-value="saveSqlFolderId"
                :options="[ROOT_SAVED_SQL_FOLDER, ...saveSqlFolders.map((f) => f.id)]"
                :display-name="saveSqlFolderDisplayName"
                :normalize-custom="saveSqlFolderNormalizeCustom"
                :placeholder="t('savedSql.folderPlaceholder')"
                :search-placeholder="t('savedSql.searchPlaceholder')"
                :empty-text="t('common.noResults')"
                :disabled="saveSqlFolderCreationPending"
                allow-custom
                trigger-variant="outline"
                trigger-class="h-8 w-full max-w-none text-sm"
                content-class="w-[var(--reka-popover-trigger-width)]"
                @update:model-value="handleSaveSqlFolderSelect"
              >
                <template #custom-option-label="{ value }">
                  <span class="truncate">{{ t("savedSql.createFolderOption", { name: value }) }}</span>
                </template>
              </SearchableSelect>
            </div>
          </div>
          <DialogFooter>
            <Button v-if="isDesktop" variant="secondary" @click="saveActiveSqlAsLocalFile">{{ t("savedSql.saveToFile") }}</Button>
            <Button variant="outline" @click="cancelPendingSaveAndClose()">{{ t("dangerDialog.cancel") }}</Button>
            <Button :disabled="saveSqlFolderCreationPending || !saveSqlName.trim()" @click="confirmSaveSqlToLibrary">{{ t("savedSql.save") }}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <QueryEditorDdlViewDialog
        v-if="queryEditorDdlTarget"
        v-model:open="showQueryEditorDdlDialog"
        :connection-id="queryEditorDdlTarget.connectionId"
        :database="queryEditorDdlTarget.database"
        :catalog="queryEditorDdlTarget.catalog"
        :schema="queryEditorDdlTarget.schema"
        :table-name="queryEditorDdlTarget.tableName"
        :object-type="queryEditorDdlTarget.objectType"
        :database-type="queryEditorDdlDatabaseType"
        :dialect="queryEditorDdlDialect"
      />
      <QueryEditorObjectSourceDialog
        v-if="queryEditorObjectSourceTarget"
        v-model:open="showQueryEditorObjectSourceDialog"
        :connection-id="queryEditorObjectSourceTarget.connectionId"
        :database="queryEditorObjectSourceTarget.database"
        :schema="queryEditorObjectSourceTarget.schema"
        :name="queryEditorObjectSourceTarget.name"
        :signature="queryEditorObjectSourceTarget.signature"
        :relation-name="queryEditorObjectSourceTarget.relationName"
        :object-type="queryEditorObjectSourceTarget.objectType"
        :initial-editing="queryEditorObjectSourceTarget.initialEditing"
        :database-type="queryEditorObjectSourceDatabaseType"
        :dialect="queryEditorObjectSourceDialect"
        :format-dialect="queryEditorObjectSourceFormatDialect"
        @saved="onQueryEditorObjectSourceSaved"
      />
    </TooltipProvider>
    <div id="ogdeveloper-query-editor-tooltip-root" class="fixed left-0 top-0 z-[70] h-0 w-0 overflow-visible" />
  </div>
  <AboutDialog v-model:open="aboutDialogOpen" :app-version="appVersion" @check-updates="onAboutCheckUpdates" />
  <UpdateDialog
    v-model:open="showAppUpdateDialog"
    :update-info="appUpdateInfo"
    :update-check-message="appUpdateCheckMessage"
    :is-downloading-update="isDownloadingAppUpdate"
    :download-progress="appUpdateDownloadProgress"
    :update-downloaded="appUpdateDownloaded"
    :is-installing-update="isInstallingAppUpdate"
    :update-ready="appUpdateReady"
    :active-task-count="appUpdateActiveTaskCount"
    @open-latest-release="appUpdater.openLatestRelease"
    @download-and-install="appUpdater.downloadAndInstallUpdate"
    @cancel-download="appUpdater.cancelDownload"
    @install-downloaded="appUpdater.installDownloadedUpdate"
    @restart="appUpdater.restartApp"
  />
</template>
