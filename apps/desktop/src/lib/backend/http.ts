import type {
  ConnectionConfig,
  ConnectionTestResult,
  DatabaseConnectionInfo,
  DatabaseInfo,
  DatabaseStorageInfo,
  SchemaInfo,
  TableInfo,
  TableNameFilter,
  ObjectInfo,
  CompletionAssistantRequest,
  CompletionAssistantResponse,
  ObjectStatistics,
  ObjectSource,
  ObjectSourceKind,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  TriggerInfo,
  ConstraintInfo,
  PartitionInfo,
  SubpartitionInfo,
  ExtensionInfo,
  FunctionInfo,
  SequenceInfo,
  RuleInfo,
  OwnerInfo,
  QueryResult,
  SqlReferenceAnalysis,
  DatabaseType,
  InstalledPlugin,
  JdbcDriverInfo,
  JdbcLocalBundleInfo,
  JdbcMavenBundleInfo,
  JdbcPluginStatus,
  SidebarLayout,
  SavedSqlFile,
  SavedSqlFolder,
  SavedSqlLibrary,
  SshConfigHostEntry,
  TunnelProfile,
} from "@/types/database";
import { BackendErrorException, type BackendError } from "@/lib/backend/errorUtils";
import type { SchemaDiffPreparation, SchemaDiffPreparationOptions, TableDiff, FunctionDiff, SequenceDiff, RuleDiff, OwnerDiff } from "@/lib/schema/schemaDiff";
import type { SidebarObjectKind } from "@/lib/database/databaseObjectCapabilities";
import type { AiConfig, AiTestConnectionResult } from "@/stores/settingsStore";
import type { AiChatSelectionState, AiEffortCapability } from "@/types/ai";
import type {
  AgentDriverInfo,
  AiCompletionRequest,
  AiStreamChunk,
  AiConversation,
  AiModelInfo,
  DriverStoreUsage,
  DriverRuntimeSummary,
  UpgradeAllAgentDriversResult,
  AgentUpdateBlocker,
  DesktopSettings,
  SavedSqlSyncRequest,
  DriverInstallProgress,
  JavaRuntimeConfig,
  UpdateInfo,
  UpdateDownloadSource,
  HistoryEntry,
  HistorySearchRequest,
  HistorySearchResult,
  HistoryConnectionOption,
  SqlFileRequest,
  SqlFilePreview,
  SqlFileProgress,
  TransferRequest,
  TransferProgress,
  TransferOwnershipPreview,
  TableImportPreviewRequest,
  TableImportPreview,
  TableImportRequest,
  TableImportSummary,
  TableImportProgress,
  DatabaseBackupSnapshot,
  DatabaseExportRequest,
  ExportProgress,
  TableExportRequest,
  TableExportProgress,
  QueryResultExportRequest,
  TableCsvExportOptions,
  XlsxCellValue,
  QueryPaginationExecutionPlanOptions,
  QueryPaginationExecutionPlan,
  SortedQuerySqlOptions,
  QuerySqlBuildResult,
  BuildExplainSqlOptions,
  ExplainSqlBuildResult,
  AppSupportInfo,
  PromptTemplate,
  SshPromptResolution,
} from "@/lib/backend/tauri";
import type { QueryEditability } from "@/lib/sql/sqlAnalysis";
import { isTerminalTransferProgress } from "@/lib/backend/transferProgress";
import type {
  DataGridColumnDistinctValuesSqlOptions,
  DataGridColumnValueFilterConditionOptions,
  DataGridColumnValuesFilterConditionOptions,
  DataGridContextFilterConditionOptions,
  DataGridCountSqlOptions,
  DataGridCopyInsertStatementOptions,
  DataGridCopyUpdateStatementOptions,
  DataGridSaveStatementOptions,
} from "@/lib/dataGrid/dataGridSql";
import type { DataGridExtractRequest, DataGridExtractResult } from "@/lib/dataGrid/dataGridCopyExtractor";
import type { BuildTableStructureChangeSqlOptions, BuildSingleColumnAlterSqlOptions, TableStructureChangeSql } from "@/lib/table/tableStructureEditorSql";
import type { BuildTableSelectSqlOptions } from "@/lib/table/tableSelectSql";
import type { DatabaseSearchSql, DatabaseSearchSqlOptions, SearchResultWhereOptions } from "@/lib/database/databaseSearch";
import type { BuildEditableObjectSourceSqlInput, BuildRoutineRenameObjectSourceInput } from "@/lib/table/objectSourceEditor";
import type { BuildViewDdlInput } from "@/lib/table/viewDdl";
import type { BuildRenameObjectSqlOptions } from "@/lib/table/objectRenameSql";
import type { CreateDatabaseSqlOptions } from "@/lib/database/createDatabaseSql";
import type { DatabaseNameSqlOptions, DatabasePropertyEditSqlOptions, DropTableChildObjectSqlOptions, DropObjectSqlOptions, DuplicateTableStructureSqlOptions, CopyTableDataSqlOptions, SchemaNameSqlOptions, TableAdminSqlOptions } from "@/lib/database/dbAdminSql";
import type { BuildDatabaseSqlExportOptions, BuildExportInsertStatementsOptions } from "@/lib/export/databaseExport";
import { loadBrowserAppState, saveBrowserAppState } from "@/lib/backend/browserAppStateStorage";
import type { DataCompareFromTablesOptions, DataCompareFromTablesPreparation, DataCompareSyncPlan, DataCompareSyncPlanOptions, DataComparePreparation, DataComparePreparationOptions } from "@/lib/dataGrid/dataCompare";
import { apiUrl } from "@/lib/common/webPath";
import type { DataGridSavePreparation } from "@/lib/backend/tauri";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { normalizeConnectionTestResult } from "@/lib/connection/connectionDatabaseInfo";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DESKTOP_SETTINGS_STORAGE_KEY = "dbx-desktop-settings";
const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  icon_theme: "default",
  close_action_prompted: false,
  debug_logging_enabled: false,
  duckdb_worker_process_isolation: false,
  duckdb_worker_max_processes: 4,
  saved_sql_sync_dir: null,
  driver_store_dir: null,
  plugin_store_dir: null,
  agent_store_dir: null,
  sidebar_table_page_size: 1000,
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url));
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url), { method: "DELETE" });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

async function put<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

export async function backendResponseError(response: Response): Promise<BackendErrorException> {
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Preserve legacy plain-text responses at the same compatibility boundary.
  }
  return new BackendErrorException(payload);
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  }
  return sp.toString();
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function testConnection(config: ConnectionConfig): Promise<string> {
  return post("/api/connection/test", { config });
}

export async function testConnectionWithInfo(config: ConnectionConfig): Promise<ConnectionTestResult> {
  const response = await fetch(apiUrl("/api/connection/test-info"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  if (response.status === 404) {
    return normalizeConnectionTestResult(await testConnection(config), config);
  }
  if (!response.ok) throw await backendResponseError(response);
  return normalizeConnectionTestResult(await response.json(), config);
}

export async function connectDb(config: ConnectionConfig, clientAttempt?: number): Promise<string> {
  return post("/api/connection/connect", { config, clientAttempt });
}

export async function connectionDatabaseInfo(connectionId: string, database?: string): Promise<DatabaseConnectionInfo | undefined> {
  const info = await post<DatabaseConnectionInfo | null>("/api/connection/database-info", { connectionId, database });
  return info ?? undefined;
}

export async function saveConnectionDatabaseInfo(connectionId: string, databaseInfo: DatabaseConnectionInfo): Promise<void> {
  return post("/api/connection/database-info/save", {
    connectionId,
    databaseInfo,
  });
}

export async function connectionFinalProxyPort(config: ConnectionConfig): Promise<number> {
  return post("/api/connection/final-proxy-port", { config });
}

export async function disconnectDb(connectionId: string, clientAttempt?: number): Promise<void> {
  return post("/api/connection/disconnect", { connectionId, clientAttempt });
}

export async function checkConnectionHealth(connectionId: string): Promise<void> {
  return post("/api/connection/check-health", { connectionId });
}

export async function connectionIdentifierQuote(connectionId: string, database?: string): Promise<string | undefined> {
  const quote = await post<string | null>("/api/connection/identifier-quote", {
    connectionId,
    database,
  });
  return quote ?? undefined;
}

export async function closeDatabaseConnection(connectionId: string, database: string): Promise<boolean> {
  return post("/api/connection/close-database", { connectionId, database });
}

export async function saveConnections(configs: ConnectionConfig[]): Promise<void> {
  return post("/api/connection/save", { configs });
}

export async function loadConnections(): Promise<ConnectionConfig[]> {
  return get("/api/connection/list");
}

export async function loadTunnelProfiles(): Promise<TunnelProfile[]> {
  return get("/api/tunnel-profiles/list");
}

export async function saveTunnelProfiles(profiles: TunnelProfile[]): Promise<void> {
  return post("/api/tunnel-profiles/save", { profiles });
}

export async function testTunnelProfile(profile: TunnelProfile): Promise<string> {
  return post("/api/tunnel-profiles/test", profile);
}

export async function resolveSshPrompt(resolution: SshPromptResolution): Promise<void> {
  await post("/api/ssh/prompts/resolve", resolution);
}

export async function readKeychainPassword(_service: string): Promise<string> {
  return ""; // Not available in web backend
}

export async function readKeychainPasswords(services: string[]): Promise<[string, string][]> {
  return services.map((s) => [s, ""]); // Not available in web backend
}

export async function decryptConfig(payload: unknown, passphrase: string): Promise<string> {
  return post("/api/app-settings/config/decrypt", { payload, passphrase });
}

export async function listSystemFonts(): Promise<string[]> {
  return get("/api/system/fonts");
}

export async function listSshConfigHosts(): Promise<SshConfigHostEntry[]> {
  return get("/api/ssh/config-hosts");
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
  return get("/api/plugins");
}

export async function listJdbcDrivers(): Promise<JdbcDriverInfo[]> {
  return get("/api/jdbc/drivers");
}

export async function listJdbcMavenBundles(): Promise<JdbcMavenBundleInfo[]> {
  return get("/api/jdbc/drivers/maven");
}

export async function listJdbcLocalBundles(): Promise<JdbcLocalBundleInfo[]> {
  return get("/api/jdbc/drivers/local");
}

export async function importJdbcDrivers(pathsOrFiles: (string | File)[]): Promise<JdbcDriverInfo[]> {
  const formData = new FormData();
  for (const item of pathsOrFiles) {
    if (item instanceof File) {
      formData.append("files", item, item.name);
    } else {
      const fileName = item.split("/").pop() || "driver.jar";
      const blob = await (await fetch(item)).blob();
      formData.append("files", blob, fileName);
    }
  }
  const res = await fetch(apiUrl("/api/jdbc/drivers"), {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

export async function installJdbcDriverFromMaven(coordinate: string, repositories: string[] = []): Promise<JdbcDriverInfo[]> {
  return post("/api/jdbc/drivers/maven", { coordinate, repositories });
}

export async function deleteJdbcDriver(path: string): Promise<JdbcDriverInfo[]> {
  const fileName = path.split("/").pop() || path;
  return del(`/api/jdbc/drivers/${encodeURIComponent(fileName)}`);
}

export async function deleteJdbcMavenBundle(bundleId: string): Promise<JdbcDriverInfo[]> {
  return del(`/api/jdbc/drivers/maven/${encodeURIComponent(bundleId)}`);
}

export async function deleteJdbcLocalBundle(bundleId: string): Promise<JdbcDriverInfo[]> {
  return del(`/api/jdbc/drivers/local/${encodeURIComponent(bundleId)}`);
}

export async function jdbcPluginStatus(): Promise<JdbcPluginStatus> {
  return get("/api/jdbc/plugin/status");
}

export async function installJdbcPlugin(): Promise<JdbcPluginStatus> {
  return post("/api/jdbc/plugin/install", {});
}

export async function installJdbcPluginLocal(pathOrFile: string | File): Promise<JdbcPluginStatus> {
  let blob: Blob;
  let fileName: string;
  if (pathOrFile instanceof File) {
    blob = pathOrFile;
    fileName = pathOrFile.name;
  } else {
    fileName = pathOrFile.split("/").pop() || "plugin.zip";
    blob = await (await fetch(pathOrFile)).blob();
  }
  const formData = new FormData();
  formData.append("file", blob, fileName);
  const uploadRes = await fetch(apiUrl("/api/jdbc/plugin/install-local"), {
    method: "POST",
    body: formData,
  });
  if (!uploadRes.ok) throw await backendResponseError(uploadRes);
  return uploadRes.json();
}

export async function uninstallJdbcPlugin(): Promise<JdbcPluginStatus> {
  return post("/api/jdbc/plugin/uninstall", {});
}

export async function listInstalledAgentsLocal(): Promise<AgentDriverInfo[]> {
  return get("/api/agents/installed-local");
}

export async function listInstalledAgents(_source?: UpdateDownloadSource): Promise<AgentDriverInfo[]> {
  return get("/api/agents/installed");
}

export async function isAgentInstalled(dbType: string): Promise<boolean> {
  return get(`/api/agents/installed/${encodeURIComponent(dbType)}`);
}

export async function getDriverStoreUsage(): Promise<DriverStoreUsage> {
  return get("/api/agents/storage-usage");
}

export async function clearDriverDownloadCache(): Promise<void> {
  await del("/api/agents/download-cache");
}

export async function getDriverRuntimeSummary(): Promise<DriverRuntimeSummary> {
  return get("/api/agents/runtime");
}

export async function stopDriverRuntime(runtimeId: string): Promise<void> {
  await post("/api/agents/runtime/stop", { runtimeId });
}

export async function restartDriverRuntime(runtimeId: string): Promise<void> {
  await post("/api/agents/runtime/restart", { runtimeId });
}

export async function installAgent(dbType: string, _source?: UpdateDownloadSource, operationId?: string): Promise<void> {
  await post("/api/agents/install", { dbType, operationId });
}

export async function upgradeAllAgents(_source?: UpdateDownloadSource, operationId?: string): Promise<UpgradeAllAgentDriversResult> {
  return post("/api/agents/upgrade-all", { operationId });
}

export async function checkAgentUpdateBlockers(dbTypes: string[]): Promise<AgentUpdateBlocker[]> {
  return post("/api/agents/update-blockers", { dbTypes });
}

export async function uninstallAgent(dbType: string): Promise<void> {
  await post("/api/agents/uninstall", { dbType });
}

export async function getAgentJavaRuntimeConfig(): Promise<JavaRuntimeConfig> {
  return get("/api/agents/java-runtime");
}

export async function setAgentJavaRuntimeConfig(config: JavaRuntimeConfig): Promise<JavaRuntimeConfig> {
  return post("/api/agents/java-runtime", { config });
}

export async function invalidateAgentRegistryCache(): Promise<void> {
  await post("/api/agents/invalidate-registry-cache", {});
}

export async function importAgentsFromZip(fileOrPath: string | File, operationId?: string): Promise<number> {
  if (typeof fileOrPath === "string") {
    throw new Error("Offline package import in web mode requires a File object, not a file path");
  }
  const formData = new FormData();
  if (operationId) formData.append("operationId", operationId);
  formData.append("file", fileOrPath);
  const res = await fetch(apiUrl("/api/agents/import-offline"), {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw await backendResponseError(res);
  const result: { count: number } = await res.json();
  return result.count;
}

export async function importAgentDriver(dbType: string, pathOrFile: string | File): Promise<void> {
  let blob: Blob;
  let fileName: string;
  if (pathOrFile instanceof File) {
    blob = pathOrFile;
    fileName = pathOrFile.name;
  } else {
    fileName = pathOrFile.split("/").pop() || "agent";
    blob = await (await fetch(pathOrFile)).blob();
  }
  const formData = new FormData();
  formData.append("dbType", dbType);
  formData.append("file", blob, fileName);
  const uploadRes = await fetch(apiUrl("/api/agents/import-driver"), {
    method: "POST",
    body: formData,
  });
  if (!uploadRes.ok) throw await backendResponseError(uploadRes);
}

export const importAgentJar = importAgentDriver;

export async function reinstallJre(jreKey?: string, _source?: UpdateDownloadSource, operationId?: string): Promise<void> {
  await post("/api/agents/reinstall-jre", { jreKey, operationId });
}

export async function uninstallJre(jreKey: string): Promise<void> {
  await post("/api/agents/uninstall-jre", { jreKey });
}

export async function listenAgentInstallProgress(handler: (progress: DriverInstallProgress) => void): Promise<() => void> {
  const es = new EventSource(apiUrl("/api/agents/progress/global"));
  es.onmessage = (event) => {
    try {
      handler(JSON.parse(event.data));
    } catch {
      /* ignore malformed progress events */
    }
  };
  return () => es.close();
}

export async function loadSavedSqlLibrary(): Promise<SavedSqlLibrary> {
  return get("/api/saved-sql");
}

export async function loadSavedSqlFile(id: string): Promise<SavedSqlFile | null> {
  return get(`/api/saved-sql/${encodeURIComponent(id)}`);
}

export async function saveSavedSqlFolder(folder: SavedSqlFolder): Promise<SavedSqlFolder> {
  return post("/api/saved-sql/folders", folder);
}

export async function deleteSavedSqlFolder(id: string): Promise<void> {
  return del(`/api/saved-sql/folders/${encodeURIComponent(id)}`);
}

export async function saveSavedSqlFile(file: SavedSqlFile): Promise<SavedSqlFile> {
  return post("/api/saved-sql", file);
}

export async function deleteSavedSqlFile(id: string): Promise<void> {
  return del(`/api/saved-sql/${encodeURIComponent(id)}`);
}

export async function savedSqlStorageDir(): Promise<string> {
  return "";
}

export async function openSavedSqlStorageDir(_dir?: string | null): Promise<void> {
  throw new Error("SQL storage directory is only available in the desktop app.");
}

export async function revealPathInFileManager(_path: string): Promise<void> {
  throw new Error("Reveal in file manager is only available in the desktop app.");
}

export async function deleteDatabaseBackupFiles(_paths: string[]): Promise<number> {
  throw new Error("Database backup file management is only available in the desktop app.");
}

export async function syncSavedSqlDirectory(_request: SavedSqlSyncRequest): Promise<void> {
  throw new Error("SQL directory sync is only available in the desktop app.");
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function listDatabases(connectionId: string): Promise<DatabaseInfo[]> {
  return get(`/api/schema/databases?${qs({ connection_id: connectionId })}`);
}

export async function listDatabaseStorage(connectionId: string, databases: string[]): Promise<DatabaseStorageInfo[]> {
  return post("/api/schema/database-storage", {
    connection_id: connectionId,
    databases,
  });
}

export async function saveSchemaCache(cacheKey: string, payload: unknown): Promise<void> {
  return post("/api/schema/cache", { cacheKey, payload });
}

export async function loadSchemaCache<T = unknown>(cacheKey: string): Promise<T | null> {
  return get(`/api/schema/cache?${qs({ cache_key: cacheKey })}`);
}

export async function deleteSchemaCachePrefix(prefix: string): Promise<void> {
  return del(`/api/schema/cache-prefix?${qs({ prefix })}`);
}

export async function listSchemas(connectionId: string, database: string, applyVisibleFilter = false): Promise<string[]> {
  return get(`/api/schema/schemas?${qs({ connection_id: connectionId, database, apply_visible_filter: applyVisibleFilter || undefined })}`);
}

export async function listSchemaInfos(connectionId: string, database: string): Promise<SchemaInfo[]> {
  const schemas = await listSchemas(connectionId, database);
  return schemas.map((name) => ({ name, comment: null }));
}

export async function listTables(connectionId: string, database: string, schema: string, filter?: string, limit?: number, offset?: number, objectTypes?: SidebarObjectKind[], catalog?: string, tableNameFilter?: TableNameFilter): Promise<TableInfo[]> {
  return get(`/api/schema/tables?${qs({ connection_id: connectionId, database, schema, filter, limit, offset, object_types: objectTypes?.join(","), catalog, table_name_filter: tableNameFilter ? JSON.stringify(tableNameFilter) : undefined })}`);
}

export async function getTableComment(_connectionId: string, _database: string, _schema: string, _table: string, _catalog?: string): Promise<string | null> {
  throw new Error("Table comment lookup is not available in the web backend");
}

export async function listObjects(connectionId: string, database: string, schema: string, objectTypes?: (SidebarObjectKind | "EVENT")[], filter?: string, limit?: number, offset?: number, catalog?: string): Promise<ObjectInfo[]> {
  return get(
    `/api/schema/objects?${qs({
      connection_id: connectionId,
      database,
      schema,
      object_types: objectTypes?.join(","),
      filter,
      limit,
      offset,
      catalog,
    })}`,
  );
}

export async function listObjectStatistics(connectionId: string, database: string, schema: string): Promise<ObjectStatistics[]> {
  return get(`/api/schema/object-statistics?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listCompletionObjects(connectionId: string, database: string, schema: string): Promise<ObjectInfo[]> {
  return get(`/api/schema/completion-objects?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function completionAssistantSearch(request: CompletionAssistantRequest): Promise<CompletionAssistantResponse> {
  return post("/api/schema/completion-assistant", request);
}

export async function getObjectSource(connectionId: string, database: string, schema: string, name: string, objectType: ObjectSourceKind, signature?: string, relationName?: string): Promise<ObjectSource> {
  return get(`/api/schema/object-source?${qs({ connection_id: connectionId, database, schema, table: name, object_type: objectType, signature, relation_name: relationName })}`);
}

export async function getColumns(connectionId: string, database: string, schema: string, table: string, catalog?: string, clientSessionId?: string): Promise<ColumnInfo[]> {
  return get(`/api/schema/columns?${qs({ connection_id: connectionId, database, schema, table, catalog, client_session_id: clientSessionId })}`);
}

export interface TableColumnsResult {
  table_name: string;
  columns: ColumnInfo[];
  error?: string;
}

export async function getAllColumns(connectionId: string, database: string, schema: string): Promise<TableColumnsResult[]> {
  return get(`/api/schema/all-columns?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listDataTypes(connectionId: string, database: string): Promise<string[]> {
  return get(`/api/schema/data-types?${qs({ connection_id: connectionId, database })}`);
}

export async function listIndexes(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<IndexInfo[]> {
  return get(`/api/schema/indexes?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function listForeignKeys(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<ForeignKeyInfo[]> {
  return get(`/api/schema/foreign-keys?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function listTriggers(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<TriggerInfo[]> {
  return get(`/api/schema/triggers?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function listConstraints(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<ConstraintInfo[]> {
  return get(`/api/schema/constraints?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function listPartitions(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<PartitionInfo[]> {
  return get(`/api/schema/partitions?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function listSubpartitions(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<SubpartitionInfo[]> {
  return get(`/api/schema/subpartitions?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function getTableDdl(connectionId: string, database: string, schema: string, table: string, objectType?: ObjectSourceKind, catalog?: string): Promise<string> {
  return get(`/api/schema/ddl?${qs({ connection_id: connectionId, database, schema, table, object_type: objectType, catalog })}`);
}

export async function getTableDisplayDdl(connectionId: string, database: string, schema: string, table: string, objectType?: ObjectSourceKind, catalog?: string): Promise<string> {
  return get(`/api/schema/ddl?${qs({ connection_id: connectionId, database, schema, table, object_type: objectType, catalog, include_postgres_access: true })}`);
}

export async function prepareSchemaDiff(options: SchemaDiffPreparationOptions): Promise<SchemaDiffPreparation> {
  return post("/api/schema-diff/prepare", options);
}

export async function generateSchemaSyncSql(diffs: TableDiff[], databaseType: DatabaseType, targetSchema?: string, functionDiffs?: FunctionDiff[], sequenceDiffs?: SequenceDiff[], ruleDiffs?: RuleDiff[], ownerDiffs?: OwnerDiff[], cascadeDelete?: boolean): Promise<string> {
  return post("/api/schema-diff/generate-sync-sql", {
    diffs,
    databaseType,
    targetSchema,
    functionDiffs: functionDiffs ?? [],
    sequenceDiffs: sequenceDiffs ?? [],
    ruleDiffs: ruleDiffs ?? [],
    ownerDiffs: ownerDiffs ?? [],
    cascadeDelete: cascadeDelete ?? false,
  });
}

export async function listFunctions(connectionId: string, database: string, schema: string): Promise<FunctionInfo[]> {
  return get(`/api/schema/functions?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listOpengaussPackageSubprograms(connectionId: string, database: string, schema: string, packageName: string): Promise<FunctionInfo[]> {
  return get(`/api/schema/opengauss-package-subprograms?${qs({ connection_id: connectionId, database, schema, package: packageName })}`);
}

export async function listSequences(connectionId: string, database: string, schema: string, withLastValues: boolean): Promise<SequenceInfo[]> {
  return get(`/api/schema/sequences?${qs({ connection_id: connectionId, database, schema, with_last_values: withLastValues })}`);
}

export async function listRules(connectionId: string, database: string, schema: string): Promise<RuleInfo[]> {
  return get(`/api/schema/rules?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listOwners(connectionId: string, database: string, schema: string): Promise<OwnerInfo[]> {
  return get(`/api/schema/owners?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listExtensions(connectionId: string, database: string, schema?: string): Promise<ExtensionInfo[]> {
  return get(`/api/schema/extensions?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listAvailableExtensions(connectionId: string, database: string): Promise<ExtensionInfo[]> {
  return get(`/api/schema/available-extensions?${qs({ connection_id: connectionId, database })}`);
}

export interface SynonymTargetInfo {
  targetSchema: string;
  targetName: string;
  targetKind: string;
}

export async function resolveSynonymTarget(connectionId: string, database: string, schema: string, name: string): Promise<SynonymTargetInfo | null> {
  return get(`/api/schema/synonym-target?${qs({ connection_id: connectionId, database, schema, name })}`);
}

export async function listTypeAttributes(connectionId: string, database: string, schema: string, name: string): Promise<ColumnInfo[]> {
  return get(`/api/schema/type-attributes?${qs({ connection_id: connectionId, database, schema, name })}`);
}

export interface ObjectReferenceInfo {
  schema: string;
  name: string;
  objectType: string;
  detail?: string;
}

export interface InvalidObjectInfo {
  schema: string;
  name: string;
  objectType: string;
  errorLine?: number;
  errorPosition?: number;
  errorMessage?: string;
  source?: string;
}

export interface RecompileObjectResult {
  schema: string;
  name: string;
  objectType: string;
  success: boolean;
  error?: string;
  elapsedMs: number;
}

export interface ProfilerStatus {
  available: boolean;
  installed: boolean;
  message?: string;
}

export interface ProfilerLineData {
  lineNumber: number;
  totalOccur: number;
  totalTimeUs: number;
  minTimeUs: number;
  maxTimeUs: number;
  avgTimeUs: number;
  percentage: number;
}

export interface ProfilerUnitSummary {
  unitName: string;
  unitType: string;
  unitOwner: string;
  totalTimeUs: number;
  lines: ProfilerLineData[];
}

export interface ProfilerRunResult {
  runId: number;
  runComment: string;
  totalTimeMs: number;
  units: ProfilerUnitSummary[];
  executionOutput?: string;
}

export async function listObjectReferences(connectionId: string, database: string, schema: string, objectType: string, name: string, direction: string): Promise<ObjectReferenceInfo[]> {
  return get(`/api/schema/object-references?${qs({ connection_id: connectionId, database, schema, object_type_name: objectType, name, direction })}`);
}

export async function listInvalidObjects(connectionId: string, database: string, schema?: string): Promise<InvalidObjectInfo[]> {
  return get(`/api/schema/invalid-objects?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function recompileObject(connectionId: string, database: string, schema: string, objectName: string, objectType: string): Promise<RecompileObjectResult> {
  return post("/api/schema/recompile-object", { connection_id: connectionId, database, schema, object_name: objectName, object_type: objectType });
}

export async function opengaussProfilerStatus(connectionId: string, database: string): Promise<ProfilerStatus> {
  return get(`/api/schema/opengauss-profiler-status?${qs({ connection_id: connectionId, database })}`);
}

export async function opengaussProfilerRun(connectionId: string, database: string, schema: string | undefined, callSql: string, comment: string): Promise<ProfilerRunResult> {
  return post("/api/schema/opengauss-profiler-run", { connection_id: connectionId, database, schema, call_sql: callSql, comment });
}

export async function listDialectDataTypes(dialectName: string): Promise<string[]> {
  return get(`/api/dialect/data-types?${qs({ dialect_name: dialectName })}`);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function executeQuery(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
  executionId?: string,
  options?: {
    maxRows?: number;
    catalog?: string;
    fetchSize?: number;
    pageSize?: number;
    resultSessionId?: string;
    clientSessionId?: string;
    timeoutSecs?: number;
    executionMode?: "simple" | "postgres_read_only_transaction";
  },
): Promise<QueryResult> {
  return post("/api/query/execute", {
    connectionId,
    database,
    sql,
    schema,
    executionId,
    ...options,
  });
}

export async function executeMulti(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
  executionId?: string,
  options?: {
    maxRows?: number;
    catalog?: string;
    fetchSize?: number;
    pageSize?: number;
    resultSessionId?: string;
    clientSessionId?: string;
    timeoutSecs?: number;
    useTransaction?: boolean;
    continueOnError?: boolean;
    executionMode?: "simple";
  },
): Promise<QueryResult[]> {
  return post("/api/query/execute-multi", {
    connectionId,
    database,
    sql,
    schema,
    executionId,
    ...options,
  });
}

export interface ExecuteMultiProgress {
  executionId: string;
  statementIndex: number;
  completed: number;
  total: number;
  success: boolean;
  executionTimeMs: number;
  affectedRows: number;
  error?: BackendError;
}

export async function executeMultiWithProgress(
  connectionId: string,
  database: string,
  sql: string,
  onProgress: (progress: ExecuteMultiProgress) => void,
  schema?: string,
  options?: {
    maxRows?: number;
    catalog?: string;
    fetchSize?: number;
    pageSize?: number;
    resultSessionId?: string;
    clientSessionId?: string;
    timeoutSecs?: number;
    useTransaction?: boolean;
    continueOnError?: boolean;
    executionMode?: "simple";
    executionId?: string;
  },
): Promise<QueryResult[]> {
  const executionId = options?.executionId ?? crypto.randomUUID();
  const { executionId: _executionId, ...executeOptions } = options ?? {};
  const results = await executeMulti(connectionId, database, sql, schema, executionId, executeOptions);
  const total = results.length;
  results.forEach((result, index) => {
    const statementIndex = result.statement_index ?? index;
    const success = result.execution_error !== true;
    onProgress({
      executionId,
      statementIndex,
      completed: index + 1,
      total,
      success,
      executionTimeMs: result.execution_time_ms,
      affectedRows: result.affected_rows,
      error: success ? undefined : result.error,
    });
  });
  return results;
}

export async function closeQuerySession(connectionId: string, database: string, sessionId: string, clientSessionId?: string, catalog?: string): Promise<boolean> {
  return post("/api/query/close-session", {
    connectionId,
    database,
    sessionId,
    clientSessionId,
    catalog,
  });
}

export async function closeClientConnectionSession(connectionId: string, database: string, clientSessionId: string, catalog?: string): Promise<boolean> {
  return post("/api/query/close-client-session", {
    connectionId,
    database,
    clientSessionId,
    catalog,
  });
}

export async function executeBatch(connectionId: string, database: string, statements: string[], schema?: string): Promise<QueryResult> {
  return post("/api/query/execute-batch", {
    connectionId,
    database,
    statements,
    schema,
  });
}

export async function executeScript(connectionId: string, database: string, sql: string, schema?: string): Promise<QueryResult> {
  return post("/api/query/execute-script", {
    connectionId,
    database,
    sql,
    schema,
  });
}

export async function executeScriptWith2pc(connectionId: string, database: string, statements: string[], schema?: string): Promise<any> {
  return post("/api/query/execute-script-2pc", {
    connectionId,
    database,
    statements,
    schema,
  });
}

export async function executeInTransaction(connectionId: string, database: string, statements: string[], schema?: string, catalog?: string): Promise<QueryResult> {
  return post("/api/query/execute-in-transaction", {
    connectionId,
    database,
    statements,
    schema,
    catalog,
  });
}

export async function beginManualTransaction(_connectionId: string, _database: string, _schema?: string, _catalog?: string): Promise<string> {
  throw new Error("Manual transaction management is only available in the desktop app.");
}

export async function executeInManualTransaction(_txnSessionId: string, _sql: string, _database: string, _schema?: string, _maxRows?: number): Promise<QueryResult[]> {
  throw new Error("Manual transaction management is only available in the desktop app.");
}

export async function commitManualTransaction(_txnSessionId: string): Promise<QueryResult> {
  throw new Error("Manual transaction management is only available in the desktop app.");
}

export async function rollbackManualTransaction(_txnSessionId: string): Promise<QueryResult> {
  throw new Error("Manual transaction management is only available in the desktop app.");
}

export async function cancelQuery(executionId: string): Promise<boolean> {
  const result = await post<boolean | { cancelled?: boolean }>("/api/query/cancel", { executionId });
  return typeof result === "boolean" ? result : result.cancelled === true;
}

export async function analyzeSqlReferences(sql: string, dialect?: string): Promise<SqlReferenceAnalysis> {
  return post("/api/query/analyze-sql-references", { sql, dialect });
}

export async function findStatementAtCursor(sql: string, cursorPos: number, databaseType?: DatabaseType): Promise<string> {
  return post("/api/query/find-statement-at-cursor", {
    sql,
    cursorPos,
    databaseType,
  });
}

export async function prepareQueryPaginationExecutionPlan(options: QueryPaginationExecutionPlanOptions): Promise<QueryPaginationExecutionPlan> {
  return post("/api/query/prepare-pagination-plan", { options });
}

export async function buildSortedQuerySql(options: SortedQuerySqlOptions): Promise<QuerySqlBuildResult> {
  return post("/api/query/build-sorted-sql", { options });
}

export async function buildExplainSql(options: BuildExplainSqlOptions): Promise<ExplainSqlBuildResult> {
  return post("/api/query/build-explain-sql", { options });
}

export async function buildCreateUserSql(username: string, password: string, tablespace: string): Promise<string> {
  return post("/api/query/build-create-user-sql", {
    username,
    password,
    tablespace,
  });
}

export async function getExplainInfo(connectionId: string, database: string | undefined, schema: string | undefined, sql: string, mode: string): Promise<string | undefined> {
  // Match the Tauri path: transport and Agent failures must remain distinguishable from an empty plan.
  return post<string>("/api/query/get-explain-info", {
    connectionId,
    database,
    schema,
    sql,
    mode,
  });
}

export async function buildTableSelectSql(options: BuildTableSelectSqlOptions): Promise<string> {
  return post("/api/query/build-table-select-sql", { options });
}

export async function buildDatabaseSearchSql(options: DatabaseSearchSqlOptions): Promise<DatabaseSearchSql | null> {
  return post("/api/query/build-database-search-sql", { options });
}

export async function buildSearchResultWhere(options: SearchResultWhereOptions): Promise<string> {
  return post("/api/query/build-search-result-where", { options });
}

export async function buildRenameObjectSql(options: BuildRenameObjectSqlOptions): Promise<string> {
  return post("/api/query/build-rename-object-sql", { options });
}

export async function buildCreateDatabaseSql(options: CreateDatabaseSqlOptions): Promise<string> {
  return post("/api/query/build-create-database-sql", { options });
}

export async function buildDropObjectSql(options: DropObjectSqlOptions): Promise<string> {
  return post("/api/query/build-drop-object-sql", { options });
}

export async function buildDropTableSql(options: TableAdminSqlOptions): Promise<string> {
  return post("/api/query/build-drop-table-sql", { options });
}

export async function buildDropTableChildObjectSql(options: DropTableChildObjectSqlOptions): Promise<string> {
  return post("/api/query/build-drop-table-child-object-sql", { options });
}

export async function buildEmptyTableSql(options: TableAdminSqlOptions): Promise<string> {
  return post("/api/query/build-empty-table-sql", { options });
}

export async function buildTruncateTableSql(options: TableAdminSqlOptions): Promise<string> {
  return post("/api/query/build-truncate-table-sql", { options });
}

export async function buildDropDatabaseSql(options: DatabaseNameSqlOptions): Promise<string> {
  return post("/api/query/build-drop-database-sql", { options });
}

export async function buildCreateSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return post("/api/query/build-create-schema-sql", { options });
}

export async function buildUpdateDatabasePropertiesSql(options: DatabasePropertyEditSqlOptions): Promise<string> {
  return post("/api/query/build-update-database-properties-sql", { options });
}

export async function buildDropSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return post("/api/query/build-drop-schema-sql", { options });
}

export async function buildDuplicateTableStructureSql(options: DuplicateTableStructureSqlOptions): Promise<string> {
  return post("/api/query/build-duplicate-table-structure-sql", { options });
}

export async function buildCopyTableDataSql(options: CopyTableDataSqlOptions): Promise<string> {
  return post("/api/query/build-copy-table-data-sql", { options });
}

export async function buildExecutableObjectSourceStatements(input: BuildEditableObjectSourceSqlInput): Promise<string[]> {
  return post("/api/query/build-executable-object-source-statements", {
    input,
  });
}

export async function buildExecutableObjectSourceSql(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return post("/api/query/build-executable-object-source-sql", { input });
}

export async function buildEditableObjectSource(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return post("/api/query/build-editable-object-source", { input });
}

export async function buildRoutineRenameObjectSourceStatements(input: BuildRoutineRenameObjectSourceInput): Promise<string[]> {
  return post("/api/query/build-routine-rename-object-source-statements", {
    input,
  });
}

export async function buildViewDdlSql(input: BuildViewDdlInput): Promise<string> {
  return post("/api/query/build-view-ddl-sql", { input });
}

export async function buildTableStructureChangeSql(options: BuildTableStructureChangeSqlOptions): Promise<TableStructureChangeSql> {
  return post("/api/query/build-table-structure-change-sql", { options });
}

export async function buildCreateTableSql(options: BuildTableStructureChangeSqlOptions): Promise<TableStructureChangeSql> {
  return post("/api/query/build-create-table-sql", { options });
}

export async function buildSingleColumnAlterSql(options: BuildSingleColumnAlterSqlOptions): Promise<TableStructureChangeSql> {
  return post("/api/query/build-single-column-alter-sql", { options });
}

export async function analyzeEditableQueryEditability(sql: string): Promise<QueryEditability> {
  return post("/api/query/analyze-editability", { sql });
}

export async function prepareDataGridSave(options: DataGridSaveStatementOptions): Promise<DataGridSavePreparation> {
  return post("/api/query/prepare-data-grid-save", { options });
}

export async function extractDataGridSelection(request: DataGridExtractRequest): Promise<DataGridExtractResult> {
  return post("/api/query/extract-data-grid-selection", { request });
}

export async function buildDataGridCopyUpdateStatements(options: DataGridCopyUpdateStatementOptions): Promise<string[]> {
  return post("/api/query/build-data-grid-copy-update-statements", { options });
}

export async function buildDataGridCopyInsertStatement(options: DataGridCopyInsertStatementOptions): Promise<string | undefined> {
  const result = await post<string | null>("/api/query/build-data-grid-copy-insert-statement", { options });
  return result ?? undefined;
}

export async function buildDataGridContextFilterCondition(options: DataGridContextFilterConditionOptions): Promise<string | undefined> {
  const result = await post<string | null>("/api/query/build-data-grid-context-filter-condition", { options });
  return result ?? undefined;
}

export async function buildDataGridColumnValueFilterCondition(options: DataGridColumnValueFilterConditionOptions): Promise<string | undefined> {
  const result = await post<string | null>("/api/query/build-data-grid-column-value-filter-condition", { options });
  return result ?? undefined;
}

export async function buildDataGridColumnValuesFilterCondition(options: DataGridColumnValuesFilterConditionOptions): Promise<string | undefined> {
  const result = await post<string | null>("/api/query/build-data-grid-column-values-filter-condition", { options });
  return result ?? undefined;
}

export async function buildDataGridColumnDistinctValuesSql(options: DataGridColumnDistinctValuesSqlOptions): Promise<string> {
  return post("/api/query/build-data-grid-column-distinct-values-sql", {
    options,
  });
}

export async function buildDataGridCountSql(options: DataGridCountSqlOptions): Promise<string> {
  return post("/api/query/build-data-grid-count-sql", { options });
}

export async function buildExportInsertStatements(options: BuildExportInsertStatementsOptions): Promise<string[]> {
  return post("/api/query/build-export-insert-statements", { options });
}

export async function buildExportSqlInsert(options: BuildExportInsertStatementsOptions): Promise<string> {
  return post("/api/query/build-export-sql-insert", { options });
}

export async function buildDatabaseSqlExport(options: BuildDatabaseSqlExportOptions): Promise<string> {
  return post("/api/query/build-database-sql-export", { options });
}

export async function prepareDataCompare(options: DataComparePreparationOptions): Promise<DataComparePreparation> {
  return post("/api/data-compare/prepare", options);
}

export async function prepareDataCompareFromTables(options: DataCompareFromTablesOptions): Promise<DataCompareFromTablesPreparation> {
  return post("/api/data-compare/prepare-from-tables", options);
}

export async function prepareDataCompareMissingTarget(options: import("@/lib/dataGrid/dataCompare").DataCompareMissingTargetOptions): Promise<DataCompareFromTablesPreparation> {
  return post("/api/data-compare/prepare-missing-target", options);
}

export async function buildDataCompareSyncPlan(options: DataCompareSyncPlanOptions): Promise<DataCompareSyncPlan> {
  return post("/api/data-compare/build-sync-plan", options);
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export async function aiComplete(request: AiCompletionRequest): Promise<string> {
  return post("/api/ai/complete", { request });
}

export async function aiStream(sessionId: string, request: AiCompletionRequest, onChunk: (chunk: AiStreamChunk) => void): Promise<void> {
  const res = await fetch(apiUrl("/api/ai/stream"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, request }),
  });
  if (!res.ok) throw await backendResponseError(res);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") {
          try {
            const chunk: AiStreamChunk = JSON.parse(data);
            onChunk(chunk);
            if (chunk.done) return;
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  }
}

export async function aiCancelStream(sessionId: string): Promise<boolean> {
  return post("/api/ai/cancel-stream", { sessionId });
}

export async function aiTestConnection(config: AiConfig): Promise<AiTestConnectionResult> {
  return post("/api/ai/test-connection", { config });
}

export async function aiListModels(config: AiConfig): Promise<AiModelInfo[]> {
  return post("/api/ai/models", { config });
}

export async function aiResolveModelEffort(config: AiConfig, modelId: string): Promise<AiEffortCapability> {
  return post("/api/ai/model-effort", { config, modelId });
}

export async function saveAiChatSelection(selection: AiChatSelectionState): Promise<void> {
  return post("/api/ai/chat-selection", { selection });
}

export async function loadAiChatSelection(): Promise<AiChatSelectionState | null> {
  return get("/api/ai/chat-selection");
}

export type { AgentEvent } from "@/lib/backend/tauri";

function isAgentEvent(v: unknown): v is import("@/lib/backend/tauri").AgentEvent {
  return typeof v === "object" && v !== null && "type" in v && typeof (v as Record<string, unknown>).type === "string";
}

export async function aiAgentStream(
  sessionId: string,
  request: AiCompletionRequest,
  connectionId: string,
  database: string,
  schema: string | undefined,
  dbType: string,
  onEvent: (event: import("@/lib/backend/tauri").AgentEvent) => void,
  mode?: string,
  allowWriteSql = false,
  confirmedWriteSql?: string,
  confirmedConnectionId?: string,
  confirmedDatabase?: string,
  confirmedSchema?: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(apiUrl("/api/ai/agent-stream"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      request,
      connectionId,
      database,
      schema,
      dbType,
      mode: mode || "ask",
      allowWriteSql,
      confirmedWriteSql,
      confirmedConnectionId,
      confirmedDatabase,
      confirmedSchema,
    }),
    signal,
  });
  if (!res.ok) throw await backendResponseError(res);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            if (!isAgentEvent(parsed)) {
              console.warn("[aiAgentStream] Skipping invalid agent event:", data);
              continue;
            }
            onEvent(parsed);
            if (parsed.type === "agent_end" || parsed.type === "error") {
              result = data;
            }
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  }
  return result;
}

export async function saveAiConfig(config: AiConfig): Promise<void> {
  return post("/api/ai/config", { config });
}

export async function saveAiProviderConfig(provider: string, config: AiConfig): Promise<void> {
  return post("/api/ai/provider-config", { provider, config });
}

export async function loadAiProviderConfigs(): Promise<Record<string, AiConfig>> {
  return get("/api/ai/provider-configs");
}

export async function loadAiConfig(): Promise<AiConfig | null> {
  return get("/api/ai/config");
}

export async function saveAiConfigs(configs: import("@/types/ai").AiConfigItem[]): Promise<void> {
  return post("/api/ai/configs", { configs });
}

export async function loadAiConfigs(): Promise<import("@/types/ai").AiConfigItem[]> {
  return get("/api/ai/configs");
}

export async function setDefaultAiConfig(configId: string): Promise<void> {
  return post("/api/ai/default-config", { configId });
}

export async function saveAiConfigItem(config: import("@/types/ai").AiConfigItem): Promise<void> {
  return post("/api/ai/config-item", { config });
}

export async function deleteAiConfig(configId: string): Promise<void> {
  return del(`/api/ai/config/${configId}`);
}

export async function loadDesktopSettings(): Promise<DesktopSettings> {
  try {
    const raw = safeLocalStorageGet(DESKTOP_SETTINGS_STORAGE_KEY);
    return raw
      ? {
          ...DEFAULT_DESKTOP_SETTINGS,
          ...(JSON.parse(raw) as Partial<DesktopSettings>),
        }
      : { ...DEFAULT_DESKTOP_SETTINGS };
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

export async function saveDesktopSettings(settings: DesktopSettings): Promise<void> {
  safeLocalStorageSet(DESKTOP_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_DESKTOP_SETTINGS, ...settings }));
}

export async function loadMaxAgentTurns(): Promise<number> {
  return get("/api/app-settings/max-agent-turns");
}

export async function saveMaxAgentTurns(maxAgentTurns: number): Promise<void> {
  const res = await fetch(apiUrl("/api/app-settings/max-agent-turns"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxAgentTurns }),
  });
  if (!res.ok) throw await backendResponseError(res);
}

export async function loadMaxRetries(): Promise<number> {
  return get("/api/app-settings/max-retries");
}

export async function saveMaxRetries(maxRetries: number): Promise<void> {
  const res = await fetch(apiUrl("/api/app-settings/max-retries"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxRetries }),
  });
  if (!res.ok) throw await backendResponseError(res);
}

export interface OpenTabsStatePayload {
  tabs: unknown[];
  activeTabId: string | null;
}

export async function loadEditorSettings(): Promise<unknown | null> {
  return loadBrowserAppState("editor_settings");
}

export async function saveEditorSettings(settings: unknown): Promise<void> {
  await saveBrowserAppState("editor_settings", settings);
}

export async function loadOpenTabsState(): Promise<OpenTabsStatePayload | null> {
  const value = await loadBrowserAppState("open_tabs");
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<OpenTabsStatePayload>;
  return Array.isArray(payload.tabs)
    ? {
        tabs: payload.tabs,
        activeTabId: typeof payload.activeTabId === "string" ? payload.activeTabId : null,
      }
    : null;
}

export async function saveOpenTabsState(payload: OpenTabsStatePayload): Promise<void> {
  await saveBrowserAppState("open_tabs", payload);
}

export async function loadSavedSqlEditorPositions(): Promise<unknown[] | null> {
  const value = await loadBrowserAppState("saved_sql_editor_positions");
  return Array.isArray(value) ? value : null;
}

export async function saveSavedSqlEditorPositions(positions: unknown[]): Promise<void> {
  await saveBrowserAppState("saved_sql_editor_positions", positions);
}

export async function completeAppClose(_action?: "quit" | "hide"): Promise<void> {
  return undefined;
}

export async function requestAppClose(): Promise<void> {
  return undefined;
}

export interface DriverStoreMigrationResult {
  driver_store_dir: string | null;
  plugin_store_dir: string | null;
  agent_store_dir: string | null;
  plugins_dir: string;
  agents_dir: string;
  migrated_plugins: boolean;
  migrated_agents: boolean;
}

export async function setDriverStoreDir(_newDir: string | null): Promise<DriverStoreMigrationResult> {
  throw new Error("Not available in web mode");
}

export async function setPluginStoreDir(_newDir: string | null): Promise<DriverStoreMigrationResult> {
  throw new Error("Not available in web mode");
}

export async function setAgentStoreDir(_newDir: string | null): Promise<DriverStoreMigrationResult> {
  throw new Error("Not available in web mode");
}

export interface DriverStorePathInfo {
  driver_store_dir: string | null;
  plugin_store_dir: string | null;
  agent_store_dir: string | null;
  plugins_dir: string;
  agents_dir: string;
}

export async function getDriverStorePath(): Promise<DriverStorePathInfo> {
  throw new Error("Not available in web mode");
}

export async function loadPinnedTreeNodeIds(): Promise<string[]> {
  return get("/api/app-settings/pinned-tree-node-ids");
}

export async function savePinnedTreeNodeIds(_ids: string[]): Promise<void> {
  return post("/api/app-settings/pinned-tree-node-ids", { ids: _ids });
}

// --- AI Conversations ---

export async function saveAiConversation(conversation: AiConversation): Promise<void> {
  return post("/api/ai/conversation", { conversation });
}

export async function loadAiConversations(): Promise<AiConversation[]> {
  return get("/api/ai/conversations");
}

export async function deleteAiConversation(id: string): Promise<void> {
  return del(`/api/ai/conversation/${id}`);
}

// ---------------------------------------------------------------------------
// Prompt Templates
// ---------------------------------------------------------------------------

export async function loadPromptTemplates(): Promise<PromptTemplate[]> {
  return get("/api/prompt-templates");
}

export async function savePromptTemplate(id: string, name: string, content: string): Promise<PromptTemplate> {
  return post("/api/prompt-templates", { id, name, content });
}

export async function deletePromptTemplate(id: string): Promise<void> {
  return del(`/api/prompt-templates/${encodeURIComponent(id)}`);
}

export async function getAiGlobalCustomInstructions(): Promise<string> {
  const result = await get<{ content: string }>("/api/prompt-templates/global-instructions");
  return result.content ?? "";
}

export async function setAiGlobalCustomInstructions(content: string): Promise<void> {
  return put("/api/prompt-templates/global-instructions", { content });
}

// ---------------------------------------------------------------------------
// SQL File Execution
// ---------------------------------------------------------------------------

export async function previewSqlFile(fileOrPath: string | File): Promise<SqlFilePreview> {
  if (typeof fileOrPath === "string") {
    // In web mode a raw path is not useful; throw a clear error
    throw new Error("previewSqlFile in web mode requires a File object, not a file path");
  }
  const formData = new FormData();
  formData.append("file", fileOrPath);
  const res = await fetch(apiUrl("/api/sql-file/preview"), {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

export async function executeSqlFile(request: SqlFileRequest): Promise<void> {
  return post("/api/sql-file/execute", { request });
}

export async function executeSqlFiles(request: SqlFileRequest, filePaths: string[]): Promise<void> {
  return post("/api/sql-file/execute", { request, filePaths });
}

export async function cancelSqlFileExecution(executionId: string): Promise<boolean> {
  return post("/api/sql-file/cancel", { executionId });
}

export async function listenSqlFileProgress(_handler: (progress: SqlFileProgress) => void): Promise<() => void> {
  // For HTTP mode we need an executionId, but the tauri API does not take one.
  // The SSE endpoint requires a specific executionId. As a workaround we return
  // a no-op unlisten; callers that need progress in web mode should use
  // the web-specific SQL file progress listener instead.
  return () => {};
}

export async function pendingOpenSqlFiles(): Promise<string[]> {
  return [];
}

export async function pendingOpenDbFiles(): Promise<string[]> {
  return [];
}

export async function pendingOpenConnectionLinks(): Promise<string[]> {
  return [];
}

export async function readExternalSqlFile(path: string): Promise<string> {
  return get(`/api/fs/read-text?${qs({ path })}`);
}

export interface FileSearchHit {
  path: string;
  relative: string;
  size: number;
}

export interface MetadataSearchHit {
  connection_id: string;
  connection_name: string;
  database: string;
  schema: string;
  object_type: string;
  name: string;
  signature?: string | null;
}

export interface DefinitionSearchHit {
  connection_id: string;
  connection_name: string;
  database: string;
  schema: string;
  object_type: string;
  name: string;
  signature?: string | null;
  snippet: string;
}

export async function searchFiles(root: string, query: string, limit = 200): Promise<FileSearchHit[]> {
  return get(`/api/search/files?${qs({ root, query, limit })}`);
}

export interface DatabaseSearchScopeTarget {
  connectionId: string;
  database: string;
}

export async function listDatabaseSearchScopeTargets(): Promise<DatabaseSearchScopeTarget[]> {
  return get("/api/search/database-targets");
}

export async function searchMetadata(query: string, limit = 200, targets?: DatabaseSearchScopeTarget[]): Promise<MetadataSearchHit[]> {
  return post("/api/search/metadata", { query, limit, targets });
}

export async function searchObjectDefinitions(query: string, limit = 100, targets?: DatabaseSearchScopeTarget[]): Promise<DefinitionSearchHit[]> {
  return post("/api/search/object-definitions", { query, limit, targets });
}

export interface SessionInfo {
  connection_id: string;
  connection_name: string;
  pid: number;
  username: string;
  database: string;
  application_name: string;
  client_addr: string;
  state: string;
  query: string;
  backend_start: string;
}

export async function listSessions(): Promise<SessionInfo[]> {
  return get("/api/sessions/list");
}

export async function killSession(connectionId: string, pid: number): Promise<void> {
  return post("/api/sessions/kill", { connection_id: connectionId, pid });
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  return post("/api/fs/write-text", { path, content });
}

export async function ensureDirectory(path: string): Promise<void> {
  return get(`/api/fs/ensure-dir?${qs({ path })}`);
}

export async function defaultProjectsRoot(): Promise<string> {
  return get("/api/fs/default-projects-root");
}

export async function listDirectories(path: string): Promise<string[]> {
  return get(`/api/fs/list-dir?${qs({ path })}`);
}

export async function writeExternalSqlFile(_path: string, _content: string): Promise<void> {
  throw new Error("Saving external SQL file paths is only available in the desktop app");
}

export async function saveExternalSqlFile(_defaultFileName: string, _content: string): Promise<string | null> {
  throw new Error("Saving SQL files locally is only available in the desktop app");
}

export interface SqlFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: SqlFileEntry[];
}

export async function listSqlFilesInFolder(_folderPath: string): Promise<SqlFileEntry[]> {
  throw new Error("Listing SQL files in a folder is only available in the desktop app");
}

export async function listFilesInFolder(_folderPath: string): Promise<SqlFileEntry[]> {
  throw new Error("Listing files in a folder is only available in the desktop app");
}

// ---------------------------------------------------------------------------
// Data Transfer
// ---------------------------------------------------------------------------

export async function startTransfer(request: TransferRequest, onProgress: (progress: TransferProgress) => void): Promise<void> {
  // 1. POST to start the transfer
  const res = await fetch(apiUrl("/api/transfer/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) throw await backendResponseError(res);

  // 2. SSE to listen for progress
  return new Promise((resolve, reject) => {
    const es = new EventSource(apiUrl(`/api/transfer/progress/${request.transferId}`));
    es.onmessage = (e) => {
      const progress: TransferProgress = JSON.parse(e.data);
      onProgress(progress);
      if (isTerminalTransferProgress(progress)) {
        es.close();
        resolve();
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error("Transfer SSE connection failed"));
    };
  });
}

export async function cancelTransfer(transferId: string): Promise<void> {
  return post("/api/transfer/cancel", { transferId });
}

export async function previewTransferOwnership(request: TransferRequest): Promise<TransferOwnershipPreview> {
  return post("/api/transfer/ownership-preview", { request });
}

export interface SortTablesByFkOptions {
  connectionId: string;
  database: string;
  schema: string;
  tables: string[];
  parentsFirst: boolean;
}

export async function sortTablesByFkDependency(options: SortTablesByFkOptions): Promise<string[]> {
  return post("/api/transfer/sort-tables-by-fk", options);
}

// ---------------------------------------------------------------------------
// Table File Import
// ---------------------------------------------------------------------------

export async function previewTableImportFile(fileOrPath: string | File | TableImportPreviewRequest, options: Partial<TableImportPreviewRequest> = {}): Promise<TableImportPreview> {
  if (typeof fileOrPath === "object" && !(fileOrPath instanceof File)) {
    throw new Error("previewTableImportFile in web mode requires a File object for upload previews");
  }
  if (typeof fileOrPath === "string") {
    if (!options.sourceRef) {
      throw new Error("previewTableImportFile in web mode requires a File object for new uploads");
    }
    const res = await fetch(apiUrl("/api/import/preview-source"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: options.sourceRef,
        sourceFormat: options.sourceFormat,
        parseOptions: options.parseOptions,
        previewLimit: options.previewLimit,
      }),
    });
    if (!res.ok) throw await backendResponseError(res);
    return res.json();
  }
  const formData = new FormData();
  formData.append("file", fileOrPath);
  if (options.sourceFormat) formData.append("sourceFormat", options.sourceFormat);
  if (options.parseOptions) formData.append("parseOptions", JSON.stringify(options.parseOptions));
  if (options.previewLimit != null) formData.append("previewLimit", String(options.previewLimit));
  const res = await fetch(apiUrl("/api/import/preview"), {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

export async function importTableFile(request: TableImportRequest, onProgress: (progress: TableImportProgress) => void): Promise<TableImportSummary> {
  // 1. POST to start the import
  const res = await fetch(apiUrl("/api/import/execute"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) throw await backendResponseError(res);

  // 2. SSE to listen for progress
  return new Promise((resolve, reject) => {
    const es = new EventSource(apiUrl(`/api/import/progress/${request.importId}`));
    let summary: TableImportSummary | null = null;
    es.onmessage = (e) => {
      const progress: TableImportProgress = JSON.parse(e.data);
      onProgress(progress);
      if (progress.status === "done") {
        summary = {
          importId: progress.importId,
          rowsImported: progress.rowsImported,
          totalRows: progress.totalRows,
          elapsedMs: progress.elapsedMs,
        };
        es.close();
        resolve(summary);
      } else if (progress.status === "error" || progress.status === "cancelled") {
        es.close();
        reject(new Error(progress.error || "Import failed"));
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error("Import SSE connection failed"));
    };
  });
}

export async function cancelTableImport(importId: string): Promise<boolean> {
  return post("/api/import/cancel", { importId });
}

export async function releaseTableImportSource(sourceRef: string): Promise<boolean> {
  const result = await post<{ released: boolean }>("/api/import/source/release", { sourceRef });
  return result.released;
}

// ---------------------------------------------------------------------------
// Database Export
// ---------------------------------------------------------------------------

export async function beginDatabaseBackupSnapshot(_connectionId: string, _database: string): Promise<DatabaseBackupSnapshot> {
  throw new Error("Consistent database backup snapshots are only available in the desktop app.");
}

export async function exportDatabaseSql(request: DatabaseExportRequest, onProgress: (progress: ExportProgress) => void): Promise<void> {
  // 1. POST to start the export
  const res = await fetch(apiUrl("/api/export/database"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) throw await backendResponseError(res);

  // 2. SSE to listen for progress
  return new Promise((resolve, reject) => {
    const es = new EventSource(apiUrl(`/api/export/database/progress/${request.exportId}`));
    es.onmessage = (e) => {
      const progress: ExportProgress = JSON.parse(e.data);
      onProgress(progress);
      if (progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled") {
        es.close();
        if (progress.status === "Done") {
          // Trigger browser download; filename is decided by the server's
          // Content-Disposition header.
          downloadDatabaseExportFile(request.exportId);
        }
        resolve();
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error("Export SSE connection failed"));
    };
  });
}

function downloadDatabaseExportFile(exportId: string): void {
  const a = document.createElement("a");
  a.href = apiUrl(`/api/export/database/download/${exportId}`);
  a.click();
}

export async function cancelDatabaseExport(exportId: string): Promise<void> {
  await post("/api/export/database/cancel", { exportId });
}

// --- Table Export ---

export async function startTableExport(request: TableExportRequest, onProgress: (progress: TableExportProgress) => void): Promise<TableExportProgress> {
  const { exportId } = request;

  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    const eventSource = new EventSource(apiUrl(`/api/export/table/progress/${exportId}`));

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      eventSource.close();
      callback();
    };

    eventSource.onopen = () => {
      if (started) return;
      started = true;
      post("/api/export/table", { request }).catch((error) => {
        finish(() => reject(error));
      });
    };

    eventSource.onmessage = (event) => {
      const progress: TableExportProgress = JSON.parse(event.data);
      onProgress(progress);
      if (progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled") {
        if (progress.status === "Error") {
          finish(() => reject(new Error(progress.errorMessage || "Export failed")));
        } else if (progress.status === "Done") {
          // Trigger browser download
          downloadTableExportFile(exportId, request.format);
          finish(() => resolve(progress));
        } else {
          finish(() => resolve(progress));
        }
      }
    };

    eventSource.onerror = () => {
      finish(() => reject(new Error("Export progress connection lost")));
    };
  });
}

function downloadTableExportFile(exportId: string, format: string): void {
  const ext = format === "markdown" || format === "md" ? "md" : format;
  const a = document.createElement("a");
  a.href = apiUrl(`/api/export/table/download/${exportId}`);
  a.download = `table_export_${exportId}.${ext}`;
  a.click();
}

export async function cancelTableExport(exportId: string): Promise<void> {
  return post("/api/export/table/cancel", { exportId });
}

export async function startQueryResultExport(request: QueryResultExportRequest, onProgress: (progress: TableExportProgress) => void): Promise<TableExportProgress> {
  const { exportId } = request;

  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    const eventSource = new EventSource(apiUrl(`/api/export/query-result/progress/${exportId}`));

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      eventSource.close();
      callback();
    };

    eventSource.onopen = () => {
      if (started) return;
      started = true;
      post("/api/export/query-result", { request }).catch((error) => {
        finish(() => reject(error));
      });
    };

    eventSource.onmessage = (event) => {
      const progress: TableExportProgress = JSON.parse(event.data);
      onProgress(progress);
      if (progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled") {
        if (progress.status === "Error") {
          finish(() => reject(new Error(progress.errorMessage || "Export failed")));
        } else if (progress.status === "Done") {
          downloadQueryResultExportFile(exportId, request.format);
          finish(() => resolve(progress));
        } else {
          finish(() => resolve(progress));
        }
      }
    };

    eventSource.onerror = () => {
      finish(() => reject(new Error("Export progress connection lost")));
    };
  });
}

function downloadQueryResultExportFile(exportId: string, format: string): void {
  const a = document.createElement("a");
  a.href = apiUrl(`/api/export/query-result/download/${exportId}`);
  a.download = `query_result_export_${exportId}.${format}`;
  a.click();
}

export async function cancelQueryResultExport(exportId: string, executionId?: string): Promise<void> {
  return post("/api/export/query-result/cancel", {
    exportId,
    ...(executionId ? { executionId } : {}),
  });
}

export async function exportQueryResultCsv(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  const { formatCsv } = await import("@/lib/export/exportFormats");
  const content = formatCsv(columns, rows as (string | number | boolean | null)[][]);
  const fileName = filePath.split(/[\\/]/).pop() || "export.csv";
  const blob = new Blob(["\uFEFF", content], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportTableDataCsv(_options: TableCsvExportOptions): Promise<number> {
  throw new Error("Streaming table CSV export is only available in the desktop runtime");
}

function downloadTextFile(filePath: string, fallbackFileName: string, content: string, mimeType: string): void {
  const fileName = filePath.split(/[\\/]/).pop() || fallbackFileName;
  const blob = new Blob(["\uFEFF", content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportQueryResultXlsx(filePath: string, sheetName: string | undefined, columns: string[], columnTypes: string[], columnComments: readonly (string | null)[] | undefined, rows: readonly (readonly XlsxCellValue[])[], numericColumnRightAlign?: boolean): Promise<void> {
  const { buildXlsxWorkbook } = await import("@/lib/export/xlsxExport");
  const workbook = buildXlsxWorkbook({
    sheetName: sheetName || "Export",
    columns,
    columnTypes,
    columnComments,
    rows,
    numericColumnRightAlign,
  });
  const fileName = filePath.split(/[\\/]/).pop() || "export.xlsx";
  const blob = new Blob([new Uint8Array(workbook)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportQueryResultsXlsx(
  filePath: string,
  worksheets: readonly {
    sheetName?: string;
    columns: readonly string[];
    columnTypes?: readonly string[];
    columnComments?: readonly (string | null)[];
    rows: readonly (readonly XlsxCellValue[])[];
    numericColumnRightAlign?: boolean;
  }[],
): Promise<void> {
  const { buildXlsxWorkbookMulti } = await import("@/lib/export/xlsxExport");
  const workbook = buildXlsxWorkbookMulti(worksheets);
  const fileName = filePath.split(/[\\/]/).pop() || "export.xlsx";
  const blob = new Blob([new Uint8Array(workbook)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportQueryResultJson(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  const result = await post<{ content: string }>("/api/export/query-result-json", { columns, rows });
  downloadTextFile(filePath, "export.json", result.content, "application/json;charset=utf-8");
}

export async function exportQueryResultMarkdown(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  const result = await post<{ content: string }>("/api/export/query-result-markdown", { columns, rows });
  downloadTextFile(filePath, "export.md", result.content, "text/markdown;charset=utf-8");
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function saveHistory(entry: HistoryEntry): Promise<void> {
  return post("/api/history/save", { entry });
}

export async function loadHistory(limit: number, offset: number, activityKind?: string): Promise<HistoryEntry[]> {
  return get(`/api/history?${qs({ limit, offset, activity_kind: activityKind })}`);
}

export async function searchHistory(request: HistorySearchRequest): Promise<HistorySearchResult> {
  return post("/api/history/search", request);
}

export async function loadHistoryConnectionOptions(): Promise<HistoryConnectionOption[]> {
  return get("/api/history/options");
}

export async function clearHistory(): Promise<void> {
  return del("/api/history");
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  return del(`/api/history/${id}`);
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export async function checkForUpdates(locale?: string, source?: UpdateDownloadSource): Promise<UpdateInfo> {
  const params = new URLSearchParams();
  if (locale) params.set("locale", locale);
  if (source) params.set("source", source);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return get(`/api/update/check${query}`);
}

export async function fetchChangelog(lang?: string): Promise<import("@/lib/app/changelog").ChangelogData> {
  const query = lang ? `?lang=${encodeURIComponent(lang)}` : "";
  return get(`/api/changelog${query}`);
}

export async function getSystemProxyUrl(): Promise<string | null> {
  return null;
}

export async function downloadUpdate(_source: UpdateDownloadSource, _latestVersion?: string): Promise<void> {
  throw new Error("In-app update downloads are only available in the desktop app.");
}

export async function cancelUpdateDownload(): Promise<void> {}

export async function installDownloadedUpdate(): Promise<void> {
  throw new Error("In-app update installation is only available in the desktop app.");
}

export async function getAppVersion(): Promise<string> {
  const res: { version: string } = await get("/api/version");
  return res.version;
}

export async function getAppSupportInfo(): Promise<AppSupportInfo> {
  const appVersion = await getAppVersion();
  return {
    appVersion,
    runtime: "web",
    osName: navigator.platform || "web",
    osVersion: null,
    arch: "",
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export async function saveSidebarLayout(layout: SidebarLayout): Promise<void> {
  return post("/api/layout/sidebar", { layout });
}

export async function loadSidebarLayout(): Promise<SidebarLayout | null> {
  return get("/api/layout/sidebar");
}

export async function refreshConnections(): Promise<void> {
  // Web mode doesn't maintain persistent connection pools - no-op
}

// ---------------------------------------------------------------------------
// openGauss PL debugger
// ---------------------------------------------------------------------------

export type { OpenGaussDebugBacktraceFrame, OpenGaussDebugBreakpoint, OpenGaussDebugCodeLine, OpenGaussDebugLocal, OpenGaussDebugPosition, OpenGaussDebugStartResult, OpenGaussDebugTarget } from "@/lib/backend/tauri";

export async function opengaussDebugStart(params: { connectionId: string; database: string; schema: string; kind: string; name: string; signature?: string; callSql: string }): Promise<import("@/lib/backend/tauri").OpenGaussDebugStartResult> {
  return post("/api/debug/start", {
    connection_id: params.connectionId,
    database: params.database,
    schema: params.schema,
    kind: params.kind,
    name: params.name,
    signature: params.signature,
    call_sql: params.callSql,
  });
}

export async function opengaussDebugStep(sessionId: string, action: "next" | "step" | "finish" | "continue"): Promise<import("@/lib/backend/tauri").OpenGaussDebugPosition> {
  return post("/api/debug/step", { session_id: sessionId, action });
}

export async function opengaussDebugLocals(sessionId: string): Promise<import("@/lib/backend/tauri").OpenGaussDebugLocal[]> {
  return post("/api/debug/locals", { session_id: sessionId });
}

export async function opengaussDebugSetVar(sessionId: string, name: string, value: string): Promise<boolean> {
  return post("/api/debug/set-var", { session_id: sessionId, name, value });
}

export async function opengaussDebugBacktrace(sessionId: string): Promise<import("@/lib/backend/tauri").OpenGaussDebugBacktraceFrame[]> {
  return post("/api/debug/backtrace", { session_id: sessionId });
}

export async function opengaussDebugBreakpoints(sessionId: string): Promise<import("@/lib/backend/tauri").OpenGaussDebugBreakpoint[]> {
  return post("/api/debug/breakpoints", { session_id: sessionId });
}

export async function opengaussDebugAddBreakpoint(sessionId: string, lineno: number): Promise<import("@/lib/backend/tauri").OpenGaussDebugBreakpoint[]> {
  return post("/api/debug/breakpoints/add", { session_id: sessionId, lineno });
}

export async function opengaussDebugDeleteBreakpoint(sessionId: string, breakpointno: number): Promise<import("@/lib/backend/tauri").OpenGaussDebugBreakpoint[]> {
  return post("/api/debug/breakpoints/delete", { session_id: sessionId, breakpointno });
}

export async function opengaussDebugToggleBreakpoint(sessionId: string, breakpointno: number, enable: boolean): Promise<import("@/lib/backend/tauri").OpenGaussDebugBreakpoint[]> {
  return post("/api/debug/breakpoints/toggle", { session_id: sessionId, breakpointno, enable });
}

export async function opengaussDebugStop(sessionId: string): Promise<void> {
  return post("/api/debug/stop", { session_id: sessionId });
}

export async function opengaussDebugCallResult(sessionId: string): Promise<string | null> {
  return post("/api/debug/call-result", { session_id: sessionId });
}

export * from "@/lib/backend/git-http";
export type * from "@/types/git";
