import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type * as TauriModule from "@/lib/backend/tauri";
import { appendDebugLog } from "@/lib/backend/debugLog";
import { useSettingsStore } from "@/stores/settingsStore";
import type { AiConfigItem } from "@/types/ai";

// ---------------------------------------------------------------------------
// Lazy backend resolution (avoids top-level await)
// ---------------------------------------------------------------------------

type Backend = typeof TauriModule;

let _backend: Backend | null = null;

async function getBackend(): Promise<Backend> {
  if (_backend) return _backend;
  _backend = isTauriRuntime(globalThis) ? await import("@/lib/backend/tauri") : await import("@/lib/backend/http");
  return _backend;
}

// ---------------------------------------------------------------------------
// Helper: create a forwarding function that lazily resolves the backend
// ---------------------------------------------------------------------------

function forward<K extends keyof Backend>(name: K): Backend[K] {
  return (async (...args: unknown[]) => {
    const startedAt = performance.now();
    const operation = String(name);
    appendDebugLog("debug", "[DBX][api:start]", operation);
    const b = await getBackend();
    try {
      const result = await (b[name] as (...a: unknown[]) => unknown)(...args);
      appendDebugLog("debug", "[DBX][api:success]", {
        operation,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return result;
    } catch (error) {
      appendDebugLog("error", "[DBX][api:error]", {
        operation,
        elapsedMs: Math.round(performance.now() - startedAt),
        error,
      });
      throw error;
    }
  }) as unknown as Backend[K];
}

// ---------------------------------------------------------------------------
// Re-export all functions via lazy forwarding
// ---------------------------------------------------------------------------

// Connection
export const testConnection = forward("testConnection");
export const testConnectionWithInfo = forward("testConnectionWithInfo");
export const connectDb = forward("connectDb");
export const connectionDatabaseInfo = forward("connectionDatabaseInfo");
export const saveConnectionDatabaseInfo = forward("saveConnectionDatabaseInfo");
export const connectionFinalProxyPort = forward("connectionFinalProxyPort");
export const disconnectDb = forward("disconnectDb");
export const checkConnectionHealth = forward("checkConnectionHealth");
export const connectionIdentifierQuote = forward("connectionIdentifierQuote");
export const closeDatabaseConnection = forward("closeDatabaseConnection");
export const refreshConnections = forward("refreshConnections");
export const saveConnections = forward("saveConnections");
export const loadConnections = forward("loadConnections");
export const loadTunnelProfiles = forward("loadTunnelProfiles");
export const saveTunnelProfiles = forward("saveTunnelProfiles");
export const testTunnelProfile = forward("testTunnelProfile");
export const resolveSshPrompt = forward("resolveSshPrompt");
export const readKeychainPassword = forward("readKeychainPassword");
export const readKeychainPasswords = forward("readKeychainPasswords");
export const decryptConfig = forward("decryptConfig");
export const listPlugins = forward("listPlugins");
export const listJdbcDrivers = forward("listJdbcDrivers");
export const listJdbcMavenBundles = forward("listJdbcMavenBundles");
export const listJdbcLocalBundles = forward("listJdbcLocalBundles");
export const importJdbcDrivers = forward("importJdbcDrivers");
export const installJdbcDriverFromMaven = forward("installJdbcDriverFromMaven");
export const deleteJdbcDriver = forward("deleteJdbcDriver");
export const deleteJdbcMavenBundle = forward("deleteJdbcMavenBundle");
export const deleteJdbcLocalBundle = forward("deleteJdbcLocalBundle");
export const jdbcPluginStatus = forward("jdbcPluginStatus");
export const installJdbcPlugin = forward("installJdbcPlugin");
export const installJdbcPluginLocal = forward("installJdbcPluginLocal");
export const uninstallJdbcPlugin = forward("uninstallJdbcPlugin");
export const listInstalledAgentsLocal = forward("listInstalledAgentsLocal");
export async function listInstalledAgents() {
  const backend = await getBackend();
  return backend.listInstalledAgents(useSettingsStore().editorSettings.updateDownloadSource);
}
export const isAgentInstalled = forward("isAgentInstalled");
export const getDriverStoreUsage = forward("getDriverStoreUsage");
export const clearDriverDownloadCache = forward("clearDriverDownloadCache");
export const getDriverRuntimeSummary = forward("getDriverRuntimeSummary");
export const stopDriverRuntime = forward("stopDriverRuntime");
export const restartDriverRuntime = forward("restartDriverRuntime");
export async function installAgent(dbType: string, operationId?: string) {
  const backend = await getBackend();
  return backend.installAgent(dbType, useSettingsStore().editorSettings.updateDownloadSource, operationId);
}
export async function upgradeAllAgents(operationId?: string) {
  const backend = await getBackend();
  return backend.upgradeAllAgents(useSettingsStore().editorSettings.updateDownloadSource, operationId);
}
export const checkAgentUpdateBlockers = forward("checkAgentUpdateBlockers");
export const uninstallAgent = forward("uninstallAgent");
export const getAgentJavaRuntimeConfig = forward("getAgentJavaRuntimeConfig");
export const setAgentJavaRuntimeConfig = forward("setAgentJavaRuntimeConfig");
export const invalidateAgentRegistryCache = forward("invalidateAgentRegistryCache");
export async function importAgentsFromZip(fileOrPath: string | File, operationId?: string) {
  const backend = await getBackend();
  return backend.importAgentsFromZip(fileOrPath, operationId);
}
export const importAgentDriver = forward("importAgentDriver");
export const importAgentJar = importAgentDriver;
export async function reinstallJre(jreKey?: string, operationId?: string) {
  const backend = await getBackend();
  return backend.reinstallJre(jreKey, useSettingsStore().editorSettings.updateDownloadSource, operationId);
}
export const uninstallJre = forward("uninstallJre");
export const listenAgentInstallProgress = forward("listenAgentInstallProgress");
export const loadSavedSqlLibrary = forward("loadSavedSqlLibrary");
export const loadSavedSqlFile = forward("loadSavedSqlFile");
export const saveSavedSqlFolder = forward("saveSavedSqlFolder");
export const deleteSavedSqlFolder = forward("deleteSavedSqlFolder");
export const saveSavedSqlFile = forward("saveSavedSqlFile");
export const deleteSavedSqlFile = forward("deleteSavedSqlFile");
export const savedSqlStorageDir = forward("savedSqlStorageDir");
export const openSavedSqlStorageDir = forward("openSavedSqlStorageDir");
export const revealPathInFileManager = forward("revealPathInFileManager");
export const deleteDatabaseBackupFiles = forward("deleteDatabaseBackupFiles");
export const isSqliteDatabaseFile = forward("isSqliteDatabaseFile");
export const backupSqliteDatabase = forward("backupSqliteDatabase");
export const syncSavedSqlDirectory = forward("syncSavedSqlDirectory");

// Redis / MongoDB (legacy commands kept for UI completeness)
export const redisListDatabases = forward("redisListDatabases");
export const mongoListDatabases = forward("mongoListDatabases");

// Schema
export const listDatabases = forward("listDatabases");
export const listDatabaseStorage = forward("listDatabaseStorage");
export const saveSchemaCache = forward("saveSchemaCache");
export const loadSchemaCache = forward("loadSchemaCache");
export const deleteSchemaCachePrefix = forward("deleteSchemaCachePrefix");
export const listSchemas = forward("listSchemas");
export const listSchemaInfos = forward("listSchemaInfos");
export const listTables = forward("listTables");
export const getTableComment = forward("getTableComment");
export const listObjects = forward("listObjects");
export const listObjectStatistics = forward("listObjectStatistics");
export const listCompletionObjects = forward("listCompletionObjects");
export const completionAssistantSearch = forward("completionAssistantSearch");
export const getObjectSource = forward("getObjectSource");
export const getColumns = forward("getColumns");
export const getAllColumns = forward("getAllColumns");
export const listDataTypes = forward("listDataTypes");
export const listIndexes = forward("listIndexes");
export const listForeignKeys = forward("listForeignKeys");
export const listTriggers = forward("listTriggers");
export const listConstraints = forward("listConstraints");
export const listPartitions = forward("listPartitions");
export const listSubpartitions = forward("listSubpartitions");
export const getTableDdl = forward("getTableDdl");
export const getTableDisplayDdl = forward("getTableDisplayDdl");
export const listFunctions = forward("listFunctions");
export const listOpengaussPackageSubprograms = forward("listOpengaussPackageSubprograms");
export const opengaussDebugStart = forward("opengaussDebugStart");
export const opengaussDebugStep = forward("opengaussDebugStep");
export const opengaussDebugLocals = forward("opengaussDebugLocals");
export const opengaussDebugSetVar = forward("opengaussDebugSetVar");
export const opengaussDebugBacktrace = forward("opengaussDebugBacktrace");
export const opengaussDebugBreakpoints = forward("opengaussDebugBreakpoints");
export const opengaussDebugAddBreakpoint = forward("opengaussDebugAddBreakpoint");
export const opengaussDebugDeleteBreakpoint = forward("opengaussDebugDeleteBreakpoint");
export const opengaussDebugToggleBreakpoint = forward("opengaussDebugToggleBreakpoint");
export const opengaussDebugStop = forward("opengaussDebugStop");
export const opengaussDebugCallResult = forward("opengaussDebugCallResult");
export const listSequences = forward("listSequences");
export const listRules = forward("listRules");
export const listOwners = forward("listOwners");
export const listExtensions = forward("listExtensions");
export const resolveSynonymTarget = forward("resolveSynonymTarget");
export const listTypeAttributes = forward("listTypeAttributes");
export const listObjectReferences = forward("listObjectReferences");
export const listInvalidObjects = forward("listInvalidObjects");
export const recompileObject = forward("recompileObject");
export const opengaussProfilerStatus = forward("opengaussProfilerStatus");
export const opengaussProfilerRun = forward("opengaussProfilerRun");
export const listAvailableExtensions = forward("listAvailableExtensions");
export const prepareSchemaDiff = forward("prepareSchemaDiff");
export const generateSchemaSyncSql = forward("generateSchemaSyncSql");
export const listDialectDataTypes = forward("listDialectDataTypes");

// Query
export const executeQuery = forward("executeQuery");
export const executeMulti = forward("executeMulti");
export const executeMultiWithProgress = forward("executeMultiWithProgress");
export const executeBatch = forward("executeBatch");
export const executeScript = forward("executeScript");
export const executeScriptWith2pc = forward("executeScriptWith2pc");
export const executeInTransaction = forward("executeInTransaction");
export const beginManualTransaction = forward("beginManualTransaction");
export const executeInManualTransaction = forward("executeInManualTransaction");
export const commitManualTransaction = forward("commitManualTransaction");
export const rollbackManualTransaction = forward("rollbackManualTransaction");
export const cancelQuery = forward("cancelQuery");
export const closeQuerySession = forward("closeQuerySession");
export const closeClientConnectionSession = forward("closeClientConnectionSession");
export const analyzeSqlReferences = forward("analyzeSqlReferences");
export const findStatementAtCursor = forward("findStatementAtCursor");
export const prepareQueryPaginationExecutionPlan = forward("prepareQueryPaginationExecutionPlan");
export const buildSortedQuerySql = forward("buildSortedQuerySql");
export const buildExplainSql = forward("buildExplainSql");
export const getExplainInfo = forward("getExplainInfo");
export const buildCreateUserSql = forward("buildCreateUserSql");
export const buildTableSelectSql = forward("buildTableSelectSql");
export const buildDatabaseSearchSql = forward("buildDatabaseSearchSql");
export const buildSearchResultWhere = forward("buildSearchResultWhere");
export const buildRenameObjectSql = forward("buildRenameObjectSql");
export const buildCreateDatabaseSql = forward("buildCreateDatabaseSql");
export const buildDropObjectSql = forward("buildDropObjectSql");
export const buildDropTableSql = forward("buildDropTableSql");
export const buildDropTableChildObjectSql = forward("buildDropTableChildObjectSql");
export const buildEmptyTableSql = forward("buildEmptyTableSql");
export const buildTruncateTableSql = forward("buildTruncateTableSql");
export const buildDropDatabaseSql = forward("buildDropDatabaseSql");
export const buildCreateSchemaSql = forward("buildCreateSchemaSql");
export const buildUpdateDatabasePropertiesSql = forward("buildUpdateDatabasePropertiesSql");
export const buildDropSchemaSql = forward("buildDropSchemaSql");
export const buildDuplicateTableStructureSql = forward("buildDuplicateTableStructureSql");
export const buildCopyTableDataSql = forward("buildCopyTableDataSql");
export const buildExecutableObjectSourceStatements = forward("buildExecutableObjectSourceStatements");
export const buildExecutableObjectSourceSql = forward("buildExecutableObjectSourceSql");
export const buildEditableObjectSource = forward("buildEditableObjectSource");
export const buildRoutineRenameObjectSourceStatements = forward("buildRoutineRenameObjectSourceStatements");
export const buildViewDdlSql = forward("buildViewDdlSql");
export const buildTableStructureChangeSql = forward("buildTableStructureChangeSql");
export const buildCreateTableSql = forward("buildCreateTableSql");
export const buildSingleColumnAlterSql = forward("buildSingleColumnAlterSql");
export const analyzeEditableQueryEditability = forward("analyzeEditableQueryEditability");
export const prepareDataGridSave = forward("prepareDataGridSave");
export const extractDataGridSelection = forward("extractDataGridSelection");
export const buildDataGridCopyUpdateStatements = forward("buildDataGridCopyUpdateStatements");
export const buildDataGridCopyInsertStatement = forward("buildDataGridCopyInsertStatement");
export const buildDataGridContextFilterCondition = forward("buildDataGridContextFilterCondition");
export const buildDataGridColumnValueFilterCondition = forward("buildDataGridColumnValueFilterCondition");
export const buildDataGridColumnValuesFilterCondition = forward("buildDataGridColumnValuesFilterCondition");
export const buildDataGridColumnDistinctValuesSql = forward("buildDataGridColumnDistinctValuesSql");
export const buildDataGridCountSql = forward("buildDataGridCountSql");
export const buildExportInsertStatements = forward("buildExportInsertStatements");
export const buildExportSqlInsert = forward("buildExportSqlInsert");
export const buildDatabaseSqlExport = forward("buildDatabaseSqlExport");
export const prepareDataCompare = forward("prepareDataCompare");
export const prepareDataCompareFromTables = forward("prepareDataCompareFromTables");
export const prepareDataCompareMissingTarget = forward("prepareDataCompareMissingTarget");
export const buildDataCompareSyncPlan = forward("buildDataCompareSyncPlan");

// AI
export const aiComplete = forward("aiComplete");
export const aiStream = forward("aiStream");
export const aiAgentStream = forward("aiAgentStream");
export const aiCancelStream = forward("aiCancelStream");
export const aiTestConnection = forward("aiTestConnection");
export const aiListModels = forward("aiListModels");
export const aiResolveModelEffort = forward("aiResolveModelEffort");
export const saveAiChatSelection = forward("saveAiChatSelection");
export const loadAiChatSelection = forward("loadAiChatSelection");
export const saveAiConfig = forward("saveAiConfig");
export const loadAiConfig = forward("loadAiConfig");
export const saveAiConfigs = forward("saveAiConfigs");
export const loadAiConfigs = forward("loadAiConfigs");
export const setDefaultAiConfig = forward("setDefaultAiConfig");
export const saveAiConfigItem = forward("saveAiConfigItem");
export const deleteAiConfig = forward("deleteAiConfig");
export const saveAiProviderConfig = forward("saveAiProviderConfig");
export const loadAiProviderConfigs = forward("loadAiProviderConfigs");
export const loadDesktopSettings = forward("loadDesktopSettings");
export const saveDesktopSettings = forward("saveDesktopSettings");
export const loadMaxAgentTurns = forward("loadMaxAgentTurns");
export const saveMaxAgentTurns = forward("saveMaxAgentTurns");
export const loadMaxRetries = forward("loadMaxRetries");
export const saveMaxRetries = forward("saveMaxRetries");
export const completeAppClose = forward("completeAppClose");
export const requestAppClose = forward("requestAppClose");
export const setDriverStoreDir = forward("setDriverStoreDir");
export const setPluginStoreDir = forward("setPluginStoreDir");
export const setAgentStoreDir = forward("setAgentStoreDir");
export const getDriverStorePath = forward("getDriverStorePath");
export const loadPinnedTreeNodeIds = forward("loadPinnedTreeNodeIds");
export const savePinnedTreeNodeIds = forward("savePinnedTreeNodeIds");
export const loadEditorSettings = forward("loadEditorSettings");
export const saveEditorSettings = forward("saveEditorSettings");
export const loadOpenTabsState = forward("loadOpenTabsState");
export const saveOpenTabsState = forward("saveOpenTabsState");
export const loadSavedSqlEditorPositions = forward("loadSavedSqlEditorPositions");
export const saveSavedSqlEditorPositions = forward("saveSavedSqlEditorPositions");
export const saveAiConversation = forward("saveAiConversation");
export const loadAiConversations = forward("loadAiConversations");
export const deleteAiConversation = forward("deleteAiConversation");

// Prompt Templates
export const loadPromptTemplates = forward("loadPromptTemplates");
export const savePromptTemplate = forward("savePromptTemplate");
export const deletePromptTemplate = forward("deletePromptTemplate");
export const getAiGlobalCustomInstructions = forward("getAiGlobalCustomInstructions");
export const setAiGlobalCustomInstructions = forward("setAiGlobalCustomInstructions");

// System
export const listSystemFonts = forward("listSystemFonts");
export const listSshConfigHosts = forward("listSshConfigHosts");

// SQL File Execution
export const previewSqlFile = forward("previewSqlFile");
export const executeSqlFile = forward("executeSqlFile");
export const executeSqlFiles = forward("executeSqlFiles");
export const cancelSqlFileExecution = forward("cancelSqlFileExecution");
export const listenSqlFileProgress = forward("listenSqlFileProgress");
export const pendingOpenSqlFiles = forward("pendingOpenSqlFiles");
export const pendingOpenDbFiles = forward("pendingOpenDbFiles");
export const pendingOpenConnectionLinks = forward("pendingOpenConnectionLinks");
export const readExternalSqlFile = forward("readExternalSqlFile");
export const searchFiles = forward("searchFiles");
export const listDatabaseSearchScopeTargets = forward("listDatabaseSearchScopeTargets");
export const searchMetadata = forward("searchMetadata");
export const searchObjectDefinitions = forward("searchObjectDefinitions");
export const listDirectories = forward("listDirectories");
export const writeTextFile = forward("writeTextFile");
export const ensureDirectory = forward("ensureDirectory");
export const defaultProjectsRoot = forward("defaultProjectsRoot");
export const listSessions = forward("listSessions");
export const killSession = forward("killSession");
export const writeExternalSqlFile = forward("writeExternalSqlFile");
export const saveExternalSqlFile = forward("saveExternalSqlFile");
export const listSqlFilesInFolder = forward("listSqlFilesInFolder");
export const listFilesInFolder = forward("listFilesInFolder");

// Data Transfer
export const startTransfer = forward("startTransfer");
export const cancelTransfer = forward("cancelTransfer");
export const previewTransferOwnership = forward("previewTransferOwnership");
export const sortTablesByFkDependency = forward("sortTablesByFkDependency");

// Table File Import
export const previewTableImportFile = forward("previewTableImportFile");
export const importTableFile = forward("importTableFile");
export const cancelTableImport = forward("cancelTableImport");
export const releaseTableImportSource = forward("releaseTableImportSource");

// Database Export
export const beginDatabaseBackupSnapshot = forward("beginDatabaseBackupSnapshot");
export const exportDatabaseSql = forward("exportDatabaseSql");
export const cancelDatabaseExport = forward("cancelDatabaseExport");
export const exportQueryResultCsv = forward("exportQueryResultCsv");
export const exportTableDataCsv = forward("exportTableDataCsv");
export const exportQueryResultXlsx = forward("exportQueryResultXlsx");
export const exportQueryResultsXlsx = forward("exportQueryResultsXlsx");
export const exportQueryResultJson = forward("exportQueryResultJson");
export const exportQueryResultMarkdown = forward("exportQueryResultMarkdown");
export const startTableExport = forward("startTableExport");
export const cancelTableExport = forward("cancelTableExport");
export const startQueryResultExport = forward("startQueryResultExport");
export const cancelQueryResultExport = forward("cancelQueryResultExport");

// History
export const saveHistory = forward("saveHistory");
export const loadHistory = forward("loadHistory");
export const searchHistory = forward("searchHistory");
export const loadHistoryConnectionOptions = forward("loadHistoryConnectionOptions");
export const clearHistory = forward("clearHistory");
export const deleteHistoryEntry = forward("deleteHistoryEntry");

// Updates
export const checkForUpdates = forward("checkForUpdates");
export const fetchChangelog = forward("fetchChangelog");
export const getSystemProxyUrl = forward("getSystemProxyUrl");
export const downloadUpdate = forward("downloadUpdate");
export const cancelUpdateDownload = forward("cancelUpdateDownload");
export const installDownloadedUpdate = forward("installDownloadedUpdate");
export const getAppVersion = forward("getAppVersion");
export const getAppSupportInfo = forward("getAppSupportInfo");

// Layout
export const saveSidebarLayout = forward("saveSidebarLayout");
export const loadSidebarLayout = forward("loadSidebarLayout");

// ---------------------------------------------------------------------------
// Re-export all types from tauri.ts (shared between both backends)
// ---------------------------------------------------------------------------

export type { AiConfigItem };

export type {
  AppSupportInfo,
  AiMessage,
  AiCompletionRequest,
  AiTaskContract,
  AiStreamChunk,
  AiModelInfo,
  AiChatMessage,
  AiConversation,
  PromptTemplate,
  AgentDriverInfo,
  DriverStoreUsage,
  DriverStoreUsageItem,
  DriverRuntimeHealth,
  DriverRuntimeStatus,
  DriverRuntimeInfo,
  DriverRuntimeSummary,
  JavaRuntimeMode,
  JavaRuntimeConfig,
  DriverInstallProgress,
  DriverStoreMigrationResult,
  DriverStorePathInfo,
  UpdateInfo,
  HistoryEntry,
  HistoryConnectionFilter,
  HistoryDatabaseFilter,
  HistoryCursor,
  HistorySearchRequest,
  HistorySearchResult,
  HistoryConnectionOption,
  SqlFileStatus,
  SqlFileRequest,
  SqlFilePreview,
  SqlFileProgress,
  TransferRequest,
  TransferProgress,
  TransferMode,
  TransferContent,
  TransferObjectKind,
  TransferObjectSelection,
  TransferTableNameCase,
  TransferOwnershipPolicy,
  TransferOwnershipPreview,
  TableImportMode,
  TableImportStatus,
  TableImportSourceFormat,
  TableImportJsonShape,
  TableImportTextEncoding,
  TableImportColumnMapping,
  TableImportParseOptions,
  TableImportPreviewRequest,
  TableImportPreview,
  TableImportPreparedSource,
  TableImportRequest,
  TableImportSummary,
  TableImportProgress,
  DatabaseExportRequest,
  ExportProgress,
  TableExportProgress,
  TableExportStatus,
  TableExportRequest,
  QueryResultExportRequest,
  AgentEvent,
  SqlFileEntry,
  InvalidObjectInfo,
  RecompileObjectResult,
  ProfilerStatus,
  ProfilerLineData,
  ProfilerUnitSummary,
  ProfilerRunResult,
  GitCloneRequest,
  GitChangeStatus,
  GitStatusEntry,
  GitStatusInfo,
  GitBranchInfo,
  GitFileDiff,
} from "@/lib/backend/tauri";

// Git
export const gitIsRepo = forward("gitIsRepo");
export const gitClone = forward("gitClone");
export const gitStatus = forward("gitStatus");
export const gitBranches = forward("gitBranches");
export const gitCheckout = forward("gitCheckout");
export const gitStage = forward("gitStage");
export const gitUnstage = forward("gitUnstage");
export const gitCommit = forward("gitCommit");
export const gitPull = forward("gitPull");
export const gitPush = forward("gitPush");
export const gitFileDiff = forward("gitFileDiff");
