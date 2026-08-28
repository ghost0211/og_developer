import { invoke } from "@tauri-apps/api/core";
import { BackendErrorException, type BackendError } from "@/lib/backend/errorUtils";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Normalize Tauri rejections once at the public backend boundary. */
async function invokeBackend<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw error instanceof BackendErrorException ? error : new BackendErrorException(error);
  }
}
import type {
  ConnectionConfig,
  ConnectionTestResult,
  DatabaseConnectionInfo,
  DatabaseInfo,
  DatabaseStorageInfo,
  SchemaInfo,
  TableInfo,
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
  FunctionInfo,
  SequenceInfo,
  RuleInfo,
  OwnerInfo,
  ExtensionInfo,
  QueryResult,
  SqlReferenceAnalysis,
  DatabaseType,
  InstalledPlugin,
  JdbcDriverInfo,
  JdbcLocalBundleInfo,
  JdbcMavenBundleInfo,
  JdbcPluginStatus,
  SavedSqlFile,
  SavedSqlFolder,
  SavedSqlLibrary,
  SshConfigHostEntry,
  TunnelProfile,
  TransactionLog,
} from "@/types/database";
import { isTauriCommandUnavailable, normalizeConnectionTestResult } from "@/lib/connection/connectionDatabaseInfo";
import type { SidebarObjectKind } from "@/lib/database/databaseObjectCapabilities";
import type { AiChatSelectionState, AiConfig, AiConfigItem, AiEffortCapability, AiEffortLevel, AiTestConnectionResult } from "@/types/ai";
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
import type { DataCompareFromTablesOptions, DataCompareFromTablesPreparation, DataCompareSyncPlan, DataCompareSyncPlanOptions, DataComparePreparation, DataComparePreparationOptions } from "@/lib/dataGrid/dataCompare";
import type { SchemaDiffPreparation, SchemaDiffPreparationOptions, TableDiff, FunctionDiff, SequenceDiff, RuleDiff, OwnerDiff } from "@/lib/schema/schemaDiff";
import type { BuildTableStructureChangeSqlOptions, BuildSingleColumnAlterSqlOptions, TableStructureChangeSql } from "@/lib/table/tableStructureEditorSql";
import type { BuildTableSelectSqlOptions } from "@/lib/table/tableSelectSql";
import type { DatabaseSearchSql, DatabaseSearchSqlOptions, SearchResultWhereOptions } from "@/lib/database/databaseSearch";
import type { BuildEditableObjectSourceSqlInput, BuildRoutineRenameObjectSourceInput } from "@/lib/table/objectSourceEditor";
import type { BuildViewDdlInput } from "@/lib/table/viewDdl";
import type { BuildRenameObjectSqlOptions } from "@/lib/table/objectRenameSql";
import type { CreateDatabaseSqlOptions } from "@/lib/database/createDatabaseSql";
import type { DatabaseNameSqlOptions, DatabasePropertyEditSqlOptions, DropTableChildObjectSqlOptions, DropObjectSqlOptions, DuplicateTableStructureSqlOptions, CopyTableDataSqlOptions, SchemaNameSqlOptions, TableAdminSqlOptions } from "@/lib/database/dbAdminSql";
import type { BuildDatabaseSqlExportOptions, BuildExportInsertStatementsOptions } from "@/lib/export/databaseExport";

export interface SshPromptResolution {
  id: string;
  action: "accept" | "reject" | "secret";
  remember?: boolean;
  secret?: string;
}

export interface AgentDriverInfo {
  db_type: string;
  label: string;
  version: string;
  size: number;
  installed: boolean;
  installed_version: string | null;
  update_available: boolean;
  requires_java_runtime?: boolean;
  jre: string;
  jre_installed: boolean;
}

export interface AgentDriverUpdateIssue {
  db_type: string;
  error: string;
}

export interface UpgradeAllAgentDriversResult {
  upgraded: number;
  failed: AgentDriverUpdateIssue[];
}

export interface AgentUpdateBlocker {
  db_type: string;
  label: string;
}

export type JavaRuntimeMode = "managed" | "system" | "custom";

export interface JavaRuntimeConfig {
  mode: JavaRuntimeMode;
  custom_java_path: string | null;
}

export interface DriverStoreUsageItem {
  id: string;
  bytes: number;
}

export interface DriverStoreUsage {
  total_bytes: number;
  jre_bytes: number;
  agent_driver_bytes: number;
  download_cache_bytes?: number;
  jdbc_plugin_bytes: number;
  jdbc_driver_bytes: number;
  jres: DriverStoreUsageItem[];
  agent_drivers: DriverStoreUsageItem[];
}

export type DriverRuntimeHealth = "healthy" | "warning" | "error";
export type DriverRuntimeStatus = "running" | "stopped" | "error" | "unknown";

export interface DriverRuntimeInfo {
  id: string;
  driver_key: string;
  label: string;
  kind: string;
  source: string;
  status: DriverRuntimeStatus;
  pid: number | null;
  memory_bytes: number | null;
  cpu_percent: number | null;
  uptime_seconds: number | null;
  version: string | null;
  last_error: string | null;
  can_stop: boolean;
  can_restart: boolean;
  control_unavailable_reason: string | null;
  protocol_mode: "multi_session" | "legacy" | null;
  active_sessions: number | null;
}

export interface DriverRuntimeSummary {
  running_count: number;
  total_memory_bytes: number;
  last_error: string | null;
  health: DriverRuntimeHealth;
  runtimes: DriverRuntimeInfo[];
}

export interface DesktopSettings {
  icon_theme: "default" | "black";
  close_action_prompted: boolean;
  debug_logging_enabled: boolean;
  duckdb_worker_process_isolation: boolean;
  duckdb_worker_max_processes: number;
  saved_sql_sync_dir?: string | null;
  driver_store_dir?: string | null;
  plugin_store_dir?: string | null;
  agent_store_dir?: string | null;
  sidebar_table_page_size?: number | null;
}

export interface SavedSqlSyncEntry {
  folderName?: string;
  fileName: string;
  sql: string;
}

export interface SavedSqlSyncRequest {
  targetDir: string;
  entries: SavedSqlSyncEntry[];
}

export interface AppSupportInfo {
  appVersion: string;
  runtime: "desktop" | "web";
  osName: string;
  osVersion?: string | null;
  arch: string;
}

export interface QueryPagination {
  limit: number;
  offset: number;
  sessionId?: string;
}

export interface QueryPaginationExecutionPlanOptions {
  sql: string;
  queryBaseSql: string;
  databaseType?: DatabaseType;
  pagination: QueryPagination;
  useAgentCursor: boolean;
  firstPageUsesActualSql?: boolean;
}

export interface QueryPaginationExecutionPlan {
  sqlToExecute: string;
  pageSql?: string;
  pageLimit?: number;
  pageOffset?: number;
  countSql?: string;
  useAgentResultSession: boolean;
}

export type QuerySortDirection = "asc" | "desc";

export interface SortedQuerySqlOptions {
  originalSql: string;
  databaseType?: DatabaseType;
  resultColumns: string[];
  columnIndex: number;
  column: string;
  direction: QuerySortDirection;
}

export interface QuerySqlBuildResult {
  ok: boolean;
  sql?: string;
  reason?: "empty" | "multi" | "not_select" | "unsupported" | "with";
}

export interface BuildExplainSqlOptions {
  databaseType?: DatabaseType;
  sql: string;
  /** MySQL can return either the existing JSON plan or its native tabular plan. */
  format?: "json" | "standard";
  /** PostgreSQL only: run the statement so the plan carries measured rows and timings. */
  analyze?: boolean;
}

export interface ExplainSqlBuildResult {
  ok: boolean;
  sql?: string;
  reason?: "unsupported" | "empty" | "unsafe";
}

export type XlsxCellValue = string | number | boolean | null;

export interface DriverInstallProgress {
  operation_id?: string;
  step: string;
  downloaded?: number;
  total?: number;
  db_type?: string;
  current?: number;
  total_drivers?: number;
}

export interface AiMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AiTaskContract {
  action?: string;
  mode?: string;
  userRequest?: string;
}

export interface AiCompletionRequest {
  config: AiConfig;
  systemPrompt: string;
  messages: AiMessage[];
  taskContract?: AiTaskContract;
  maxTokens?: number;
}

export interface AiModelInfo {
  id: string;
  displayName?: string;
  supportedEffortLevels?: AiEffortLevel[];
  effortCapability?: AiEffortCapability;
}

export async function aiComplete(request: AiCompletionRequest): Promise<string> {
  return invoke("ai_complete", { request });
}

export interface AiStreamChunk {
  session_id: string;
  delta: string;
  reasoning_delta?: string;
  done: boolean;
}

export async function aiStream(sessionId: string, request: AiCompletionRequest, onChunk: (chunk: AiStreamChunk) => void): Promise<void> {
  const unlisten: UnlistenFn = await listen<AiStreamChunk>("ai-stream-chunk", (event) => {
    if (event.payload.session_id === sessionId) {
      onChunk(event.payload);
      if (event.payload.done) unlisten();
    }
  });
  try {
    await invoke("ai_stream", { sessionId, request });
  } catch (e) {
    unlisten();
    throw e;
  }
}

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | {
      type: "tool_call_start";
      tool_call_id: string;
      tool_name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_call_end";
      tool_call_id: string;
      tool_name: string;
      result: unknown;
      is_error: boolean;
    }
  | { type: "turn_end"; turn: number }
  | { type: "agent_end"; input_tokens?: number; output_tokens?: number }
  | {
      type: "context_compacted";
      summary: string;
      summary_tokens: number;
      compacted_messages: number;
      estimated_before: number;
      estimated_after: number;
    }
  | { type: "error"; message: string };

export async function aiAgentStream(
  sessionId: string,
  request: AiCompletionRequest,
  connectionId: string,
  database: string,
  schema: string | undefined,
  dbType: string,
  onEvent: (event: AgentEvent) => void,
  mode?: string,
  allowWriteSql = false,
  confirmedWriteSql?: string,
  confirmedConnectionId?: string,
  confirmedDatabase?: string,
  confirmedSchema?: string,
  _signal?: AbortSignal,
): Promise<string> {
  const unlisten: UnlistenFn = await listen<AgentEvent>("ai-agent-event", (event) => {
    onEvent(event.payload);
    if (event.payload.type === "agent_end" || event.payload.type === "error") {
      unlisten();
    }
  });
  try {
    return await invoke("ai_agent_stream", {
      sessionId,
      request,
      connectionId,
      database,
      schema,
      dbType,
      mode,
      allowWriteSql,
      confirmedWriteSql,
      confirmedConnectionId,
      confirmedDatabase,
      confirmedSchema,
    });
  } catch (e) {
    unlisten();
    throw e;
  }
}

export async function saveAiConfig(config: AiConfig): Promise<void> {
  return invoke("save_ai_config", { config });
}

export async function saveAiProviderConfig(provider: string, config: AiConfig): Promise<void> {
  return invoke("save_ai_provider_config", { provider, config });
}

export async function loadAiProviderConfigs(): Promise<Record<string, AiConfig>> {
  return invoke("load_ai_provider_configs");
}

export async function aiTestConnection(config: AiConfig): Promise<AiTestConnectionResult> {
  return invoke("ai_test_connection", { config });
}

export async function aiListModels(config: AiConfig): Promise<AiModelInfo[]> {
  return invoke("ai_list_models", { config });
}

export async function aiResolveModelEffort(config: AiConfig, modelId: string): Promise<AiEffortCapability> {
  return invoke("ai_resolve_model_effort", { config, modelId });
}

export async function saveAiChatSelection(selection: AiChatSelectionState): Promise<void> {
  return invoke("save_ai_chat_selection", { selection });
}

export async function loadAiChatSelection(): Promise<AiChatSelectionState | null> {
  return invoke("load_ai_chat_selection");
}

export async function aiCancelStream(sessionId: string): Promise<boolean> {
  return invoke("ai_cancel_stream", { sessionId });
}

export async function saveAiConfigs(configs: AiConfigItem[]): Promise<void> {
  return invoke("save_ai_configs", { configs });
}

export async function loadAiConfigs(): Promise<AiConfigItem[]> {
  return invoke("load_ai_configs");
}

export async function setDefaultAiConfig(configId: string): Promise<void> {
  return invoke("set_default_ai_config", { configId });
}

export async function saveAiConfigItem(config: AiConfigItem): Promise<void> {
  return invoke("save_ai_config_item", { config });
}

export async function deleteAiConfig(configId: string): Promise<void> {
  return invoke("delete_ai_config", { configId });
}

export async function loadAiConfig(): Promise<AiConfig | null> {
  return invoke("load_ai_config");
}

export async function loadDesktopSettings(): Promise<DesktopSettings> {
  return invoke("load_desktop_settings");
}

export async function saveDesktopSettings(settings: DesktopSettings): Promise<void> {
  return invoke("save_desktop_settings", { settings });
}

export async function loadMaxAgentTurns(): Promise<number> {
  return invoke("load_max_agent_turns");
}

export async function saveMaxAgentTurns(maxAgentTurns: number): Promise<void> {
  return invoke("save_max_agent_turns", { maxAgentTurns });
}

export async function loadMaxRetries(): Promise<number> {
  return invoke("load_max_retries");
}

export async function saveMaxRetries(maxRetries: number): Promise<void> {
  return invoke("save_max_retries", { maxRetries });
}

export interface OpenTabsStatePayload {
  tabs: unknown[];
  activeTabId: string | null;
}

export async function loadEditorSettings(): Promise<unknown | null> {
  return invoke("load_editor_settings");
}

export async function saveEditorSettings(settings: unknown): Promise<void> {
  return invoke("save_editor_settings", { settings });
}

export async function loadOpenTabsState(): Promise<OpenTabsStatePayload | null> {
  return invoke("load_open_tabs_state");
}

export async function saveOpenTabsState(payload: OpenTabsStatePayload): Promise<void> {
  return invoke("save_open_tabs_state", { payload });
}

export async function loadSavedSqlEditorPositions(): Promise<unknown[] | null> {
  return invoke("load_saved_sql_editor_positions");
}

export async function saveSavedSqlEditorPositions(positions: unknown[]): Promise<void> {
  return invoke("save_saved_sql_editor_positions", { positions });
}

export async function completeAppClose(_action?: "quit" | "hide"): Promise<void> {
  return invoke("complete_app_close", { action: "quit" });
}

export async function requestAppClose(): Promise<void> {
  return invoke("request_app_close_from_window_controls");
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

export async function setDriverStoreDir(newDir: string | null): Promise<DriverStoreMigrationResult> {
  return invoke("set_driver_store_dir", { newDir });
}

export async function setPluginStoreDir(newDir: string | null): Promise<DriverStoreMigrationResult> {
  return invoke("set_plugin_store_dir", { newDir });
}

export async function setAgentStoreDir(newDir: string | null): Promise<DriverStoreMigrationResult> {
  return invoke("set_agent_store_dir", { newDir });
}

export interface DriverStorePathInfo {
  driver_store_dir: string | null;
  plugin_store_dir: string | null;
  agent_store_dir: string | null;
  plugins_dir: string;
  agents_dir: string;
}

export async function getDriverStorePath(): Promise<DriverStorePathInfo> {
  return invoke("get_driver_store_path");
}

export async function loadPinnedTreeNodeIds(): Promise<string[]> {
  return invoke("load_pinned_tree_node_ids");
}

export async function savePinnedTreeNodeIds(ids: string[]): Promise<void> {
  return invoke("save_pinned_tree_node_ids", { ids });
}

export async function listSystemFonts(): Promise<string[]> {
  return invoke("list_system_fonts");
}

export async function listSshConfigHosts(): Promise<SshConfigHostEntry[]> {
  return invoke("list_ssh_config_hosts");
}

export async function pendingOpenSqlFiles(): Promise<string[]> {
  return invoke("pending_open_sql_files");
}

export async function pendingOpenDbFiles(): Promise<string[]> {
  return invoke("pending_open_db_files");
}

export async function pendingOpenConnectionLinks(): Promise<string[]> {
  return invoke("pending_open_connection_links");
}

export async function readExternalSqlFile(path: string): Promise<string> {
  return invoke("read_text_file", { path });
}

export async function searchFiles(root: string, query: string, limit = 200): Promise<Awaited<ReturnType<typeof import("./http").searchFiles>>[number][]> {
  return invoke("search_files", { root, query, limit });
}

export async function listDatabaseSearchScopeTargets(): Promise<import("./http").DatabaseSearchScopeTarget[]> {
  return invokeBackend("list_database_search_scope_targets");
}

export async function searchMetadata(query: string, limit = 200, targets?: import("./http").DatabaseSearchScopeTarget[]): Promise<Awaited<ReturnType<typeof import("./http").searchMetadata>>[number][]> {
  return invokeBackend("search_metadata", { query, limit, targets });
}

export async function searchObjectDefinitions(query: string, limit = 100, targets?: import("./http").DatabaseSearchScopeTarget[]): Promise<Awaited<ReturnType<typeof import("./http").searchObjectDefinitions>>[number][]> {
  return invokeBackend("search_object_definitions", { query, limit, targets });
}

export async function listSessions(): Promise<Awaited<ReturnType<typeof import("./http").listSessions>>[number][]> {
  return invoke("list_sessions");
}

export async function killSession(connectionId: string, pid: number): Promise<void> {
  return invoke("kill_session", { connectionId, pid });
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  return invoke("write_text_file", { path, content });
}

export async function ensureDirectory(path: string): Promise<void> {
  return invoke("ensure_directory", { path });
}

export async function defaultProjectsRoot(): Promise<string> {
  return invoke("default_projects_root");
}

export async function listDirectories(path: string): Promise<string[]> {
  return invoke("list_directories", { path });
}

export async function writeExternalSqlFile(path: string, content: string): Promise<void> {
  return invoke("write_external_sql_file", { path, content });
}

export async function saveExternalSqlFile(defaultFileName: string, content: string): Promise<string | null> {
  return invoke("save_external_sql_file", { defaultFileName, content });
}

export interface SqlFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: SqlFileEntry[];
}

export async function listSqlFilesInFolder(folderPath: string): Promise<SqlFileEntry[]> {
  return invoke("list_sql_files_in_folder", { folderPath });
}

export async function listFilesInFolder(folderPath: string): Promise<SqlFileEntry[]> {
  return invoke("list_files_in_folder", { folderPath });
}

// --- AI Conversations ---

export interface AiChatMessage {
  role: string;
  content: string;
  mentions?: unknown[];
  reasoning?: string;
  kind?: "contextSummary";
}

export interface AiConversation {
  id: string;
  title: string;
  connectionName: string;
  database: string;
  messages: AiChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export async function saveAiConversation(conversation: AiConversation): Promise<void> {
  return invoke("save_ai_conversation", { conversation });
}

export async function loadAiConversations(): Promise<AiConversation[]> {
  return invoke("load_ai_conversations");
}

export async function deleteAiConversation(id: string): Promise<void> {
  return invoke("delete_ai_conversation", { id });
}

// --- Prompt Templates ---

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export async function loadPromptTemplates(): Promise<PromptTemplate[]> {
  return invoke("load_prompt_templates");
}

export async function savePromptTemplate(id: string, name: string, content: string): Promise<PromptTemplate> {
  return invoke("save_prompt_template", { id, name, content });
}

export async function deletePromptTemplate(id: string): Promise<void> {
  return invoke("delete_prompt_template", { id });
}

export async function getAiGlobalCustomInstructions(): Promise<string> {
  return invoke("get_ai_global_custom_instructions");
}

export async function setAiGlobalCustomInstructions(content: string): Promise<void> {
  return invoke("set_ai_global_custom_instructions", { content });
}

export async function testConnection(config: ConnectionConfig): Promise<string> {
  return invokeBackend("test_connection", { config });
}

export async function testConnectionWithInfo(config: ConnectionConfig): Promise<ConnectionTestResult> {
  try {
    const result = await invoke<unknown>("test_connection_with_info", {
      config,
    });
    return normalizeConnectionTestResult(result, config);
  } catch (error) {
    if (!isTauriCommandUnavailable(error, "test_connection_with_info")) throw error;
    return normalizeConnectionTestResult(await testConnection(config), config);
  }
}

export async function connectDb(config: ConnectionConfig, clientAttempt?: number): Promise<string> {
  return invokeBackend("connect_db", { config, clientAttempt });
}

export async function connectionDatabaseInfo(connectionId: string, database?: string): Promise<DatabaseConnectionInfo | undefined> {
  const info = await invokeBackend<DatabaseConnectionInfo | null>("connection_database_info", { connectionId, database });
  return info ?? undefined;
}

export async function saveConnectionDatabaseInfo(connectionId: string, databaseInfo: DatabaseConnectionInfo): Promise<void> {
  return invokeBackend("save_connection_database_info", {
    connectionId,
    databaseInfo,
  });
}

export async function connectionFinalProxyPort(config: ConnectionConfig): Promise<number> {
  return invokeBackend("connection_final_proxy_port", { config });
}

export async function disconnectDb(connectionId: string, clientAttempt?: number): Promise<void> {
  return invokeBackend("disconnect_db", { connectionId, clientAttempt });
}

export async function checkConnectionHealth(connectionId: string): Promise<void> {
  return invokeBackend("check_connection_health", { connectionId });
}

export async function connectionIdentifierQuote(connectionId: string, database?: string): Promise<string | undefined> {
  const quote = await invoke<string | null>("connection_identifier_quote", {
    connectionId,
    database,
  });
  return quote ?? undefined;
}

export async function closeDatabaseConnection(connectionId: string, database: string): Promise<boolean> {
  return invoke("close_database_connection", { connectionId, database });
}

export async function listDatabases(connectionId: string): Promise<DatabaseInfo[]> {
  return invoke("list_databases", { connectionId });
}

export async function listDatabaseStorage(connectionId: string, databases: string[]): Promise<DatabaseStorageInfo[]> {
  return invoke("list_database_storage", { connectionId, databases });
}

export async function saveSchemaCache(cacheKey: string, payload: unknown): Promise<void> {
  return invoke("save_schema_cache", { cacheKey, payload });
}

export async function loadSchemaCache<T = unknown>(cacheKey: string): Promise<T | null> {
  return invoke("load_schema_cache", { cacheKey });
}

export async function deleteSchemaCachePrefix(prefix: string): Promise<void> {
  return invoke("delete_schema_cache_prefix", { prefix });
}

export async function listTables(connectionId: string, database: string, schema: string, filter?: string, limit?: number, offset?: number, objectTypes?: SidebarObjectKind[], catalog?: string, tableNameFilter?: import("@/types/database").TableNameFilter): Promise<TableInfo[]> {
  return invoke("list_tables", {
    connectionId,
    database,
    schema,
    filter,
    limit,
    offset,
    objectTypes,
    catalog,
    tableNameFilter,
  });
}

export async function getTableComment(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<string | null> {
  return invoke("get_table_comment", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listObjects(connectionId: string, database: string, schema: string, objectTypes?: (SidebarObjectKind | "EVENT")[], filter?: string, limit?: number, offset?: number, catalog?: string): Promise<ObjectInfo[]> {
  return invoke("list_objects", {
    connectionId,
    database,
    schema,
    objectTypes,
    filter,
    limit,
    offset,
    catalog,
  });
}

export async function listObjectStatistics(connectionId: string, database: string, schema: string): Promise<ObjectStatistics[]> {
  return invoke("list_object_statistics", { connectionId, database, schema });
}

export async function listCompletionObjects(connectionId: string, database: string, schema: string): Promise<ObjectInfo[]> {
  return invoke("list_completion_objects", { connectionId, database, schema });
}

export async function completionAssistantSearch(request: CompletionAssistantRequest): Promise<CompletionAssistantResponse> {
  return invoke("completion_assistant_search", { request });
}

export async function getObjectSource(connectionId: string, database: string, schema: string, name: string, objectType: ObjectSourceKind, signature?: string, relationName?: string): Promise<ObjectSource> {
  return invoke("get_object_source", {
    connectionId,
    database,
    schema,
    name,
    objectType,
    signature,
    relationName,
  });
}

export async function listSchemas(connectionId: string, database: string, applyVisibleFilter = false): Promise<string[]> {
  return invoke("list_schemas", { connectionId, database, applyVisibleFilter });
}

export async function listSchemaInfos(connectionId: string, database: string): Promise<SchemaInfo[]> {
  return invoke("list_schema_infos", { connectionId, database });
}

export async function getColumns(connectionId: string, database: string, schema: string, table: string, catalog?: string, clientSessionId?: string): Promise<ColumnInfo[]> {
  return invoke("get_columns", {
    connectionId,
    database,
    schema,
    table,
    catalog,
    clientSessionId,
  });
}

export interface TableColumnsResult {
  table_name: string;
  columns: ColumnInfo[];
  error?: string;
}

export async function getAllColumns(connectionId: string, database: string, schema: string): Promise<TableColumnsResult[]> {
  return invoke("get_all_columns", { connectionId, database, schema });
}

export async function listDataTypes(connectionId: string, database: string): Promise<string[]> {
  return invoke("list_data_types", { connectionId, database });
}

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
  try {
    return await invoke("execute_query", {
      connectionId,
      database,
      sql,
      schema,
      executionId,
      ...options,
    });
  } catch (error) {
    throw new BackendErrorException(error);
  }
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
  try {
    return await invoke("execute_multi", {
      connectionId,
      database,
      sql,
      schema,
      executionId,
      ...options,
    });
  } catch (error) {
    throw new BackendErrorException(error);
  }
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
  const { executionId: _executionId, ...invokeOptions } = options ?? {};
  const unlisten = await listen<ExecuteMultiProgress>("query-batch-progress", (event) => {
    if (event.payload.executionId === executionId) onProgress(event.payload);
  });
  try {
    return await invoke("execute_multi", { connectionId, database, sql, schema, executionId, ...invokeOptions });
  } catch (error) {
    throw new BackendErrorException(error);
  } finally {
    unlisten();
  }
}

export async function refreshConnections(): Promise<void> {
  return invoke("refresh_connections");
}

export async function cancelQuery(executionId: string): Promise<boolean> {
  return invoke("cancel_query", { executionId });
}

export async function closeQuerySession(connectionId: string, database: string, sessionId: string, clientSessionId?: string, catalog?: string): Promise<boolean> {
  return invoke("close_query_session", {
    connectionId,
    database,
    sessionId,
    clientSessionId,
    catalog,
  });
}

export async function closeClientConnectionSession(connectionId: string, database: string, clientSessionId: string, catalog?: string): Promise<boolean> {
  return invoke("close_client_connection_session", {
    connectionId,
    database,
    clientSessionId,
    catalog,
  });
}

export async function executeBatch(connectionId: string, database: string, statements: string[], schema?: string, timeoutSecs?: number): Promise<QueryResult> {
  return invoke("execute_batch", {
    connectionId,
    database,
    statements,
    schema,
    timeoutSecs,
  });
}

export async function executeScript(connectionId: string, database: string, sql: string, schema?: string): Promise<QueryResult> {
  return invoke("execute_script", { connectionId, database, sql, schema });
}

export async function executeScriptWith2pc(connectionId: string, database: string, statements: string[], schema?: string): Promise<TransactionLog> {
  return invoke("execute_script_with_2pc", {
    connectionId,
    database,
    statements,
    schema,
  });
}

export async function executeInTransaction(connectionId: string, database: string, statements: string[], schema?: string, catalog?: string): Promise<QueryResult> {
  return invoke("execute_in_transaction", {
    connectionId,
    database,
    statements,
    schema,
    catalog,
  });
}

export async function beginManualTransaction(connectionId: string, database: string, schema?: string, catalog?: string): Promise<string> {
  return invoke("begin_manual_transaction", { connectionId, database, schema, catalog });
}

export async function executeInManualTransaction(txnSessionId: string, sql: string, database: string, schema?: string, maxRows?: number): Promise<QueryResult[]> {
  return invoke("execute_in_manual_transaction", {
    txnSessionId,
    sql,
    database,
    schema,
    maxRows,
  });
}

export async function commitManualTransaction(txnSessionId: string): Promise<QueryResult> {
  return invoke("commit_manual_transaction", { txnSessionId });
}

export async function rollbackManualTransaction(txnSessionId: string): Promise<QueryResult> {
  return invoke("rollback_manual_transaction", { txnSessionId });
}

export async function analyzeSqlReferences(sql: string, dialect?: string): Promise<SqlReferenceAnalysis> {
  return invoke("analyze_sql_references", { sql, dialect });
}

export async function findStatementAtCursor(sql: string, cursorPos: number, databaseType?: DatabaseType): Promise<string> {
  return invoke("find_statement_at_cursor", { sql, cursorPos, databaseType });
}

export async function prepareQueryPaginationExecutionPlan(options: QueryPaginationExecutionPlanOptions): Promise<QueryPaginationExecutionPlan> {
  return invoke("prepare_query_pagination_execution_plan", { options });
}

export async function buildSortedQuerySql(options: SortedQuerySqlOptions): Promise<QuerySqlBuildResult> {
  return invoke("build_sorted_query_sql", { options });
}

export async function buildExplainSql(options: BuildExplainSqlOptions): Promise<ExplainSqlBuildResult> {
  return invoke("build_explain_sql", { options });
}

export async function buildCreateUserSql(username: string, password: string, tablespace: string): Promise<string> {
  return invoke("build_create_user_sql", { username, password, tablespace });
}

export async function getExplainInfo(connectionId: string, database: string | undefined, schema: string | undefined, sql: string, mode: string): Promise<string | undefined> {
  // Preserve Agent/driver errors so the explain view can show the actionable cause.
  return invoke<string>("get_explain_info", {
    connectionId,
    database,
    schema,
    sql,
    mode,
  });
}

export async function buildTableSelectSql(options: BuildTableSelectSqlOptions): Promise<string> {
  return invoke("build_table_select_sql", { options });
}

export async function buildDatabaseSearchSql(options: DatabaseSearchSqlOptions): Promise<DatabaseSearchSql | null> {
  return invoke("build_database_search_sql", { options });
}

export async function buildSearchResultWhere(options: SearchResultWhereOptions): Promise<string> {
  return invoke("build_search_result_where", { options });
}

export async function buildRenameObjectSql(options: BuildRenameObjectSqlOptions): Promise<string> {
  return invoke("build_rename_object_sql", { options });
}

export async function buildCreateDatabaseSql(options: CreateDatabaseSqlOptions): Promise<string> {
  return invoke("build_create_database_sql", { options });
}

export async function buildDropObjectSql(options: DropObjectSqlOptions): Promise<string> {
  return invoke("build_drop_object_sql", { options });
}

export async function buildDropTableSql(options: TableAdminSqlOptions): Promise<string> {
  return invoke("build_drop_table_sql", { options });
}

export async function buildDropTableChildObjectSql(options: DropTableChildObjectSqlOptions): Promise<string> {
  return invoke("build_drop_table_child_object_sql", { options });
}

export async function buildEmptyTableSql(options: TableAdminSqlOptions): Promise<string> {
  return invoke("build_empty_table_sql", { options });
}

export async function buildTruncateTableSql(options: TableAdminSqlOptions): Promise<string> {
  return invoke("build_truncate_table_sql", { options });
}

export async function buildDropDatabaseSql(options: DatabaseNameSqlOptions): Promise<string> {
  return invoke("build_drop_database_sql", { options });
}

export async function buildCreateSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return invoke("build_create_schema_sql", { options });
}

export async function buildUpdateDatabasePropertiesSql(options: DatabasePropertyEditSqlOptions): Promise<string> {
  return invoke("build_update_database_properties_sql", { options });
}

export async function buildDropSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return invoke("build_drop_schema_sql", { options });
}

export async function buildDuplicateTableStructureSql(options: DuplicateTableStructureSqlOptions): Promise<string> {
  return invoke("build_duplicate_table_structure_sql", { options });
}

export async function buildCopyTableDataSql(options: CopyTableDataSqlOptions): Promise<string> {
  return invoke("build_copy_table_data_sql", { options });
}

export async function buildExecutableObjectSourceStatements(input: BuildEditableObjectSourceSqlInput): Promise<string[]> {
  return invoke("build_executable_object_source_statements", { input });
}

export async function buildExecutableObjectSourceSql(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return invoke("build_executable_object_source_sql", { input });
}

export async function buildEditableObjectSource(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return invoke("build_editable_object_source", { input });
}

export async function buildRoutineRenameObjectSourceStatements(input: BuildRoutineRenameObjectSourceInput): Promise<string[]> {
  return invoke("build_routine_rename_object_source_statements", { input });
}

export async function buildViewDdlSql(input: BuildViewDdlInput): Promise<string> {
  return invoke("build_view_ddl_sql", { input });
}

export async function buildTableStructureChangeSql(options: BuildTableStructureChangeSqlOptions): Promise<TableStructureChangeSql> {
  return invoke("build_table_structure_change_sql", { options });
}

export async function buildCreateTableSql(options: BuildTableStructureChangeSqlOptions): Promise<TableStructureChangeSql> {
  return invoke("build_create_table_sql", { options });
}

export async function buildSingleColumnAlterSql(options: BuildSingleColumnAlterSqlOptions): Promise<TableStructureChangeSql> {
  return invoke("build_single_column_alter_sql", { options });
}

export async function analyzeEditableQueryEditability(sql: string): Promise<QueryEditability> {
  return invoke("analyze_editable_query_editability", { sql });
}

export interface DataGridSavePreparation {
  validationError?: string;
  statements: string[];
  rollbackStatements: string[];
  executionSchema?: string;
}

export async function prepareDataGridSave(options: DataGridSaveStatementOptions): Promise<DataGridSavePreparation> {
  return invoke("prepare_data_grid_save", { options });
}

export async function extractDataGridSelection(request: DataGridExtractRequest): Promise<DataGridExtractResult> {
  return invoke("extract_data_grid_selection", { request });
}

export async function buildDataGridCopyUpdateStatements(options: DataGridCopyUpdateStatementOptions): Promise<string[]> {
  return invoke("build_data_grid_copy_update_statements", { options });
}

export async function buildDataGridCopyInsertStatement(options: DataGridCopyInsertStatementOptions): Promise<string | undefined> {
  const result = await invoke<string | null>("build_data_grid_copy_insert_statement", { options });
  return result ?? undefined;
}

export async function buildDataGridContextFilterCondition(options: DataGridContextFilterConditionOptions): Promise<string | undefined> {
  const result = await invoke<string | null>("build_data_grid_context_filter_condition", { options });
  return result ?? undefined;
}

export async function buildDataGridColumnValueFilterCondition(options: DataGridColumnValueFilterConditionOptions): Promise<string | undefined> {
  const result = await invoke<string | null>("build_data_grid_column_value_filter_condition", { options });
  return result ?? undefined;
}

export async function buildDataGridColumnValuesFilterCondition(options: DataGridColumnValuesFilterConditionOptions): Promise<string | undefined> {
  const result = await invoke<string | null>("build_data_grid_column_values_filter_condition", { options });
  return result ?? undefined;
}

export async function buildDataGridColumnDistinctValuesSql(options: DataGridColumnDistinctValuesSqlOptions): Promise<string> {
  return invoke("build_data_grid_column_distinct_values_sql", { options });
}

export async function buildDataGridCountSql(options: DataGridCountSqlOptions): Promise<string> {
  return invoke("build_data_grid_count_sql", { options });
}

export async function buildExportInsertStatements(options: BuildExportInsertStatementsOptions): Promise<string[]> {
  return invoke("build_export_insert_statements", { options });
}

export async function buildExportSqlInsert(options: BuildExportInsertStatementsOptions): Promise<string> {
  return invoke("build_export_sql_insert", { options });
}

export async function buildDatabaseSqlExport(options: BuildDatabaseSqlExportOptions): Promise<string> {
  return invoke("build_database_sql_export", { options });
}

export async function prepareDataCompare(options: DataComparePreparationOptions): Promise<DataComparePreparation> {
  return invoke("prepare_data_compare", { options });
}

export async function prepareDataCompareFromTables(options: DataCompareFromTablesOptions): Promise<DataCompareFromTablesPreparation> {
  return invoke("prepare_data_compare_from_tables", { options });
}

export async function prepareDataCompareMissingTarget(options: import("@/lib/dataGrid/dataCompare").DataCompareMissingTargetOptions): Promise<DataCompareFromTablesPreparation> {
  return invoke("prepare_data_compare_missing_target", { options });
}

export async function buildDataCompareSyncPlan(options: DataCompareSyncPlanOptions): Promise<DataCompareSyncPlan> {
  return invoke("build_data_compare_sync_plan", { options });
}

export async function listIndexes(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<IndexInfo[]> {
  return invoke("list_indexes", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listForeignKeys(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<ForeignKeyInfo[]> {
  return invoke("list_foreign_keys", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listTriggers(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<TriggerInfo[]> {
  return invoke("list_triggers", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listConstraints(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<ConstraintInfo[]> {
  return invoke("list_constraints", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listPartitions(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<PartitionInfo[]> {
  return invoke("list_partitions", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listSubpartitions(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<SubpartitionInfo[]> {
  return invoke("list_subpartitions", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function getTableDdl(connectionId: string, database: string, schema: string, table: string, objectType?: ObjectSourceKind, catalog?: string): Promise<string> {
  return invoke("get_table_ddl", {
    connectionId,
    database,
    schema,
    table,
    objectType,
    catalog,
  });
}

export async function getTableDisplayDdl(connectionId: string, database: string, schema: string, table: string, objectType?: ObjectSourceKind, catalog?: string): Promise<string> {
  return invoke("get_table_ddl", {
    connectionId,
    database,
    schema,
    table,
    objectType,
    catalog,
    includePostgresAccess: true,
  });
}

export async function prepareSchemaDiff(options: SchemaDiffPreparationOptions): Promise<SchemaDiffPreparation> {
  return invoke("prepare_schema_diff", { options });
}

export async function listDialectDataTypes(dialectName: string): Promise<string[]> {
  return invoke("list_dialect_data_types", { dialectName });
}

export async function generateSchemaSyncSql(diffs: TableDiff[], databaseType: DatabaseType, targetSchema?: string, functionDiffs?: FunctionDiff[], sequenceDiffs?: SequenceDiff[], ruleDiffs?: RuleDiff[], ownerDiffs?: OwnerDiff[], cascadeDelete?: boolean): Promise<string> {
  return invoke("generate_schema_sync_sql", {
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
  return invoke("list_functions", { connectionId, database, schema });
}

export async function listOpengaussPackageSubprograms(connectionId: string, database: string, schema: string, packageName: string): Promise<FunctionInfo[]> {
  return invoke("list_opengauss_package_subprograms", { connectionId, database, schema, package: packageName });
}

// ---------------------------------------------------------------------------
// openGauss PL debugger
// ---------------------------------------------------------------------------

export interface OpenGaussDebugTarget {
  oid: number;
  schema: string;
  name: string;
  kind: string;
  signature?: string;
}

export interface OpenGaussDebugPosition {
  funcoid: number;
  funcname: string;
  lineno?: number | null;
  query: string;
  finished: boolean;
}

export interface OpenGaussDebugCodeLine {
  lineno?: number | null;
  query: string;
  canbreak: boolean;
}

export interface OpenGaussDebugLocal {
  varname: string;
  vartype: string;
  value?: string | null;
  packageName?: string | null;
  isconst: boolean;
}

export interface OpenGaussDebugBreakpoint {
  breakpointno: number;
  funcoid: number;
  lineno: number;
  query: string;
  enable: boolean;
}

export interface OpenGaussDebugBacktraceFrame {
  frameno: number;
  funcname: string;
  lineno?: number | null;
  query: string;
  funcoid: number;
}

export interface OpenGaussDebugStartResult {
  sessionId: string;
  target: OpenGaussDebugTarget;
  position: OpenGaussDebugPosition;
  code: OpenGaussDebugCodeLine[];
  breakpoints: OpenGaussDebugBreakpoint[];
}

export async function opengaussDebugStart(params: { connectionId: string; database: string; schema: string; kind: string; name: string; signature?: string; callSql: string }): Promise<OpenGaussDebugStartResult> {
  return invoke("opengauss_debug_start", params);
}

export async function opengaussDebugStep(sessionId: string, action: "next" | "step" | "finish" | "continue"): Promise<OpenGaussDebugPosition> {
  return invoke("opengauss_debug_step", { sessionId, action });
}

export async function opengaussDebugLocals(sessionId: string): Promise<OpenGaussDebugLocal[]> {
  return invoke("opengauss_debug_locals", { sessionId });
}

export async function opengaussDebugBreakpoints(sessionId: string): Promise<OpenGaussDebugBreakpoint[]> {
  return invoke("opengauss_debug_breakpoints", { sessionId });
}

export async function opengaussDebugSetVar(sessionId: string, name: string, value: string): Promise<boolean> {
  return invoke("opengauss_debug_set_var", { sessionId, name, value });
}

export async function opengaussDebugBacktrace(sessionId: string): Promise<OpenGaussDebugBacktraceFrame[]> {
  return invoke("opengauss_debug_backtrace", { sessionId });
}

export async function opengaussDebugAddBreakpoint(sessionId: string, lineno: number): Promise<OpenGaussDebugBreakpoint[]> {
  return invoke("opengauss_debug_add_breakpoint", { sessionId, lineno });
}

export async function opengaussDebugDeleteBreakpoint(sessionId: string, breakpointno: number): Promise<OpenGaussDebugBreakpoint[]> {
  return invoke("opengauss_debug_delete_breakpoint", { sessionId, breakpointno });
}

export async function opengaussDebugToggleBreakpoint(sessionId: string, breakpointno: number, enable: boolean): Promise<OpenGaussDebugBreakpoint[]> {
  return invoke("opengauss_debug_toggle_breakpoint", { sessionId, breakpointno, enable });
}

export async function opengaussDebugStop(sessionId: string): Promise<void> {
  return invoke("opengauss_debug_stop", { sessionId });
}

export async function opengaussDebugCallResult(sessionId: string): Promise<string | null> {
  return invoke("opengauss_debug_call_result", { sessionId });
}

export async function listSequences(connectionId: string, database: string, schema: string, withLastValues: boolean): Promise<SequenceInfo[]> {
  return invoke("list_sequences", {
    connectionId,
    database,
    schema,
    withLastValues,
  });
}

export async function listRules(connectionId: string, database: string, schema: string): Promise<RuleInfo[]> {
  return invoke("list_rules", { connectionId, database, schema });
}

export async function listOwners(connectionId: string, database: string, schema: string): Promise<OwnerInfo[]> {
  return invoke("list_owners", { connectionId, database, schema });
}

export async function listExtensions(connectionId: string, database: string, schema?: string): Promise<ExtensionInfo[]> {
  return invoke("list_extensions", { connectionId, database, schema });
}

export async function listAvailableExtensions(connectionId: string, database: string): Promise<ExtensionInfo[]> {
  return invoke("list_available_extensions", { connectionId, database });
}

export interface SynonymTargetInfo {
  targetSchema: string;
  targetName: string;
  targetKind: string;
}

export async function resolveSynonymTarget(connectionId: string, database: string, schema: string, name: string): Promise<SynonymTargetInfo | null> {
  return invoke("resolve_synonym_target", { connectionId, database, schema, name });
}

export async function listTypeAttributes(connectionId: string, database: string, schema: string, name: string): Promise<ColumnInfo[]> {
  return invoke("list_type_attributes", { connectionId, database, schema, name });
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
  return invoke("list_object_references", { connectionId, database, schema, objectType, name, direction });
}

export async function listInvalidObjects(connectionId: string, database: string, schema?: string): Promise<InvalidObjectInfo[]> {
  return invoke("list_invalid_objects", { connectionId, database, schema });
}

export async function recompileObject(connectionId: string, database: string, schema: string, objectName: string, objectType: string): Promise<RecompileObjectResult> {
  return invoke("recompile_object", { connectionId, database, schema, objectName, objectType });
}

export async function opengaussProfilerStatus(connectionId: string, database: string): Promise<ProfilerStatus> {
  return invoke("opengauss_profiler_status", { connectionId, database });
}

export async function opengaussProfilerRun(connectionId: string, database: string, schema: string | undefined, callSql: string, comment: string): Promise<ProfilerRunResult> {
  return invoke("opengauss_profiler_run", { connectionId, database, schema, callSql, comment });
}

export async function saveConnections(configs: ConnectionConfig[]): Promise<void> {
  return invoke("save_connections", { configs });
}

export async function loadConnections(): Promise<ConnectionConfig[]> {
  return invoke("load_connections");
}

export async function loadTunnelProfiles(): Promise<TunnelProfile[]> {
  return invoke("load_tunnel_profiles");
}

export async function saveTunnelProfiles(profiles: TunnelProfile[]): Promise<void> {
  return invoke("save_tunnel_profiles", { profiles });
}

export async function testTunnelProfile(profile: TunnelProfile): Promise<string> {
  return invoke("test_tunnel_profile", { profile });
}

export async function resolveSshPrompt(resolution: SshPromptResolution): Promise<void> {
  await invoke("resolve_ssh_prompt", { resolution });
}

export async function readKeychainPassword(service: string): Promise<string> {
  return invoke("read_keychain_password", { service, account: null });
}

export async function readKeychainPasswords(services: string[]): Promise<[string, string][]> {
  return invoke("read_keychain_passwords", { services });
}

export async function decryptConfig(payload: unknown, passphrase: string): Promise<string> {
  const { decryptConfig: decryptConfigPayload } = await import("@/lib/backend/configCrypto");
  return decryptConfigPayload(payload as any, passphrase);
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
  return invoke("list_plugins");
}

export async function listJdbcDrivers(): Promise<JdbcDriverInfo[]> {
  return invoke("list_jdbc_drivers");
}

export async function listJdbcMavenBundles(): Promise<JdbcMavenBundleInfo[]> {
  return invoke("list_jdbc_maven_bundles");
}

export async function listJdbcLocalBundles(): Promise<JdbcLocalBundleInfo[]> {
  return invoke("list_jdbc_local_bundles");
}

export async function importJdbcDrivers(paths: (string | File)[]): Promise<JdbcDriverInfo[]> {
  if (paths.some((path) => typeof path !== "string")) {
    throw new Error("Desktop JDBC driver import requires local file paths");
  }
  return invoke("import_jdbc_drivers", { paths });
}

export async function installJdbcDriverFromMaven(coordinate: string, repositories: string[] = []): Promise<JdbcDriverInfo[]> {
  return invoke("install_jdbc_driver_from_maven", {
    request: { coordinate, repositories },
  });
}

export async function deleteJdbcDriver(path: string): Promise<JdbcDriverInfo[]> {
  return invoke("delete_jdbc_driver", { path });
}

export async function deleteJdbcMavenBundle(bundleId: string): Promise<JdbcDriverInfo[]> {
  return invoke("delete_jdbc_maven_bundle", { bundleId });
}

export async function deleteJdbcLocalBundle(bundleId: string): Promise<JdbcDriverInfo[]> {
  return invoke("delete_jdbc_local_bundle", { bundleId });
}

export async function jdbcPluginStatus(): Promise<JdbcPluginStatus> {
  return invoke("jdbc_plugin_status");
}

export async function installJdbcPlugin(): Promise<JdbcPluginStatus> {
  return invoke("install_jdbc_plugin");
}

export async function installJdbcPluginLocal(path: string | File): Promise<JdbcPluginStatus> {
  if (typeof path !== "string") {
    throw new Error("Desktop JDBC plugin install requires a local file path");
  }
  return invoke("install_jdbc_plugin_local", { path });
}

export async function uninstallJdbcPlugin(): Promise<JdbcPluginStatus> {
  return invoke("uninstall_jdbc_plugin");
}

export async function listInstalledAgentsLocal(): Promise<AgentDriverInfo[]> {
  return invoke("list_installed_agents_local");
}

export async function listInstalledAgents(source?: UpdateDownloadSource): Promise<AgentDriverInfo[]> {
  return invoke("list_installed_agents", { source });
}

export async function isAgentInstalled(dbType: string): Promise<boolean> {
  return invoke("is_agent_installed", { dbType });
}

export async function getDriverStoreUsage(): Promise<DriverStoreUsage> {
  return invoke("get_driver_store_usage");
}

export async function clearDriverDownloadCache(): Promise<void> {
  return invoke("clear_driver_download_cache");
}

export async function getDriverRuntimeSummary(): Promise<DriverRuntimeSummary> {
  return invoke("get_driver_runtime_summary");
}

export async function stopDriverRuntime(runtimeId: string): Promise<void> {
  return invoke("stop_driver_runtime", { runtimeId });
}

export async function restartDriverRuntime(runtimeId: string): Promise<void> {
  return invoke("restart_driver_runtime", { runtimeId });
}

export async function installAgent(dbType: string, source?: UpdateDownloadSource, operationId?: string): Promise<void> {
  return invoke("install_agent", { dbType, source, operationId });
}

export async function upgradeAllAgents(source?: UpdateDownloadSource, operationId?: string): Promise<UpgradeAllAgentDriversResult> {
  return invoke("upgrade_all_agents", { source, operationId });
}

export async function checkAgentUpdateBlockers(dbTypes: string[]): Promise<AgentUpdateBlocker[]> {
  return invoke("check_agent_update_blockers", { dbTypes });
}

export async function uninstallAgent(dbType: string): Promise<void> {
  return invoke("uninstall_agent", { dbType });
}

export async function getAgentJavaRuntimeConfig(): Promise<JavaRuntimeConfig> {
  return invoke("get_agent_java_runtime_config");
}

export async function setAgentJavaRuntimeConfig(config: JavaRuntimeConfig): Promise<JavaRuntimeConfig> {
  return invoke("set_agent_java_runtime_config", { config });
}

export async function invalidateAgentRegistryCache(): Promise<void> {
  return invoke("invalidate_agent_registry_cache");
}

export async function importAgentsFromZip(path: string | File, operationId?: string): Promise<number> {
  if (typeof path !== "string") {
    throw new Error("Desktop offline package import requires a local file path");
  }
  return invoke("import_agents_from_zip", { path, operationId });
}

export async function importAgentDriver(dbType: string, path: string | File): Promise<void> {
  if (typeof path !== "string") {
    throw new Error("Desktop driver import requires a local file path");
  }
  return invoke("import_agent_driver_cmd", { dbType, path });
}

export const importAgentJar = importAgentDriver;

export async function reinstallJre(jreKey?: string, source?: UpdateDownloadSource, operationId?: string): Promise<void> {
  return invoke("reinstall_jre", { jreKey, source, operationId });
}

export async function uninstallJre(jreKey: string): Promise<void> {
  return invoke("uninstall_jre", { jreKey });
}

export async function listenAgentInstallProgress(handler: (progress: DriverInstallProgress) => void): Promise<UnlistenFn> {
  return listen<DriverInstallProgress>("agent-install-progress", (event) => handler(event.payload));
}

export async function loadSavedSqlLibrary(): Promise<SavedSqlLibrary> {
  return invoke("load_saved_sql_library");
}

export async function loadSavedSqlFile(id: string): Promise<SavedSqlFile | null> {
  return invoke("load_saved_sql_file", { id });
}

export async function saveSavedSqlFolder(folder: SavedSqlFolder): Promise<SavedSqlFolder> {
  return invoke("save_saved_sql_folder", { folder });
}

export async function deleteSavedSqlFolder(id: string): Promise<void> {
  return invoke("delete_saved_sql_folder", { id });
}

export async function saveSavedSqlFile(file: SavedSqlFile): Promise<SavedSqlFile> {
  return invoke("save_saved_sql_file", { file });
}

export async function deleteSavedSqlFile(id: string): Promise<void> {
  return invoke("delete_saved_sql_file", { id });
}

export async function savedSqlStorageDir(): Promise<string> {
  return invoke("saved_sql_storage_dir");
}

export async function openSavedSqlStorageDir(dir?: string | null): Promise<void> {
  return invoke("open_saved_sql_storage_dir", { dir });
}

export async function revealPathInFileManager(path: string): Promise<void> {
  return invoke("reveal_path_in_file_manager", { path });
}

export async function deleteDatabaseBackupFiles(paths: string[]): Promise<number> {
  return invoke("delete_database_backup_files", { paths });
}

export async function syncSavedSqlDirectory(request: SavedSqlSyncRequest): Promise<void> {
  return invoke("sync_saved_sql_directory", { request });
}

export async function saveSidebarLayout(layout: import("@/types/database").SidebarLayout): Promise<void> {
  return invoke("save_sidebar_layout", { layout });
}

export async function loadSidebarLayout(): Promise<import("@/types/database").SidebarLayout | null> {
  return invoke("load_sidebar_layout");
}

// --- Updates ---
export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  portable_mode: boolean;
  manual_update_only: boolean;
  release_name: string;
  release_url: string;
  release_notes: string;
}

export type UpdateDownloadSource = "official" | "cnb";

export interface UpdateDownloadProgress {
  downloaded: number;
  total: number | null;
}

export async function checkForUpdates(locale?: string, source?: UpdateDownloadSource): Promise<UpdateInfo> {
  return invoke("check_for_updates", { locale, source });
}

export async function fetchChangelog(lang?: string): Promise<import("@/lib/app/changelog").ChangelogData> {
  return invoke("fetch_changelog", { lang });
}

export async function getSystemProxyUrl(): Promise<string | null> {
  return invoke("get_system_proxy_url");
}

export async function downloadUpdate(source: UpdateDownloadSource, latestVersion?: string): Promise<void> {
  return invoke("download_update", { source, latestVersion });
}

export async function cancelUpdateDownload(): Promise<void> {
  return invoke("cancel_update_download");
}

export async function installDownloadedUpdate(): Promise<void> {
  return invoke("install_downloaded_update");
}

export async function getAppVersion(): Promise<string> {
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

export async function getAppSupportInfo(): Promise<AppSupportInfo> {
  return invoke<AppSupportInfo>("get_app_support_info");
}

// --- History ---
export interface HistoryEntry {
  id: string;
  connection_id?: string;
  connection_name: string;
  database: string;
  sql: string;
  executed_at: string;
  execution_time_ms: number;
  success: boolean;
  error?: string;
  activity_kind?: "query" | "data_change" | "schema_change" | "import" | "transfer" | "redis_command";
  operation?: string;
  target?: string;
  affected_rows?: number | null;
  rollback_sql?: string | null;
  details_json?: string | null;
}

export interface HistoryConnectionFilter {
  connection_id: string;
  connection_name: string;
}

export interface HistoryDatabaseFilter extends HistoryConnectionFilter {
  database: string;
}

export interface HistoryCursor {
  executed_at: string;
  id: string;
}

export interface HistorySearchRequest {
  search_text: string;
  connections: HistoryConnectionFilter[];
  databases: HistoryDatabaseFilter[];
  activity_kind?: string;
  success?: boolean;
  started_at?: string;
  ended_at?: string;
  cursor?: HistoryCursor;
  limit: number;
}

export interface HistorySearchResult {
  entries: HistoryEntry[];
  next_cursor?: HistoryCursor | null;
  total: number;
}

export interface HistoryConnectionOption extends HistoryConnectionFilter {
  databases: string[];
}

export async function saveHistory(entry: HistoryEntry): Promise<void> {
  return invoke("save_history", { entry });
}

export async function loadHistory(limit: number, offset: number, activityKind?: string): Promise<HistoryEntry[]> {
  return invoke("load_history", {
    limit,
    offset,
    activityKind: activityKind ?? null,
  });
}

export async function searchHistory(request: HistorySearchRequest): Promise<HistorySearchResult> {
  return invoke("search_history", { request });
}

export async function loadHistoryConnectionOptions(): Promise<HistoryConnectionOption[]> {
  return invoke("load_history_connection_options");
}

export async function clearHistory(): Promise<void> {
  return invoke("clear_history");
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  return invoke("delete_history_entry", { id });
}

// --- SQL File Execution ---
export type SqlFileStatus = "started" | "running" | "statementDone" | "statementFailed" | "done" | "error" | "cancelled";

export interface SqlFileRequest {
  executionId: string;
  connectionId: string;
  database: string;
  filePath: string;
  continueOnError: boolean;
}

export interface SqlFilePreview {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  preview: string;
  canExecuteWithoutSelectedDatabase: boolean;
  establishesDatabaseContext?: boolean;
}

export interface SqlFileProgress {
  executionId: string;
  status: SqlFileStatus;
  statementIndex: number;
  successCount: number;
  failureCount: number;
  affectedRows: number;
  elapsedMs: number;
  statementSummary: string;
  error?: string | null;
  fileIndex?: number;
  fileName?: string;
}

export async function previewSqlFile(filePath: string): Promise<SqlFilePreview> {
  return invoke("preview_sql_file", { filePath });
}

export async function executeSqlFile(request: SqlFileRequest): Promise<void> {
  return invoke("execute_sql_file", { request });
}

export async function executeSqlFiles(request: SqlFileRequest, filePaths: string[]): Promise<void> {
  return invoke("execute_sql_files", { request, filePaths });
}

export async function cancelSqlFileExecution(executionId: string): Promise<boolean> {
  return invoke("cancel_sql_file_execution", { executionId });
}

export async function listenSqlFileProgress(handler: (progress: SqlFileProgress) => void): Promise<UnlistenFn> {
  return listen<SqlFileProgress>("sql-file-progress", (event) => handler(event.payload));
}

// --- Data Transfer ---
export type TransferMode = "append" | "overwrite" | "upsert";
export type TransferTableNameCase = "preserve" | "lower" | "upper";
export type TransferOwnershipPolicy = "preserve" | "skip" | "reassignMissing";
export type TransferContent = "structureAndData" | "structureOnly" | "dataOnly";
export type TransferObjectKind = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "EVENT";

export interface TransferObjectSelection {
  objectType: TransferObjectKind;
  names: string[];
}

export interface TransferRequest {
  transferId: string;
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  sourceCatalog?: string;
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  targetCatalog?: string;
  tables: string[];
  createTable: boolean;
  content: TransferContent;
  objects: TransferObjectSelection[];
  mode: TransferMode;
  targetTableNameCase: TransferTableNameCase;
  ownershipPolicy?: TransferOwnershipPolicy;
  batchSize: number;
}

export interface TransferOwnershipPreview {
  missingOwners: string[];
  targetOwner: string;
}

export interface TransferProgress {
  transferId: string;
  table: string;
  tableIndex: number;
  totalTables: number;
  rowsTransferred: number;
  totalRows: number | null;
  status: "running" | "tableDone" | "done" | "error" | "cancelled";
  error: string | null;
  terminal: boolean;
  transferFailuresOmitted?: number;
}

export async function startTransfer(request: TransferRequest, onProgress: (progress: TransferProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      try {
        unlisten = await listen<TransferProgress>("transfer-progress", (event) => {
          if (event.payload.transferId !== request.transferId) return;
          onProgress(event.payload);
          if (isTerminalTransferProgress(event.payload)) {
            unlisten?.();
            resolve();
          }
        });

        await invoke("start_transfer", { request });
      } catch (e) {
        unlisten?.();
        reject(e instanceof BackendErrorException ? e : new BackendErrorException(e));
      }
    })();
  });
}

export async function cancelTransfer(transferId: string): Promise<void> {
  return invoke("cancel_transfer", { transferId });
}

export async function previewTransferOwnership(request: TransferRequest): Promise<TransferOwnershipPreview> {
  return invoke("preview_transfer_ownership", { request });
}

export interface SortTablesByFkOptions {
  connectionId: string;
  database: string;
  schema: string;
  tables: string[];
  parentsFirst: boolean;
}

export async function sortTablesByFkDependency(options: SortTablesByFkOptions): Promise<string[]> {
  return invoke("sort_tables_by_fk_dependency", {
    connectionId: options.connectionId,
    database: options.database,
    schema: options.schema,
    tables: options.tables,
    parentsFirst: options.parentsFirst,
  });
}

// --- Table File Import ---
export type TableImportMode = "append" | "truncate";
export type TableImportStatus = "running" | "done" | "error" | "cancelled";
export type TableImportPhase = "preparing" | "detectingEncoding" | "reading" | "writing" | "finalizing" | "done";
export type TableImportSourceFormat = "csv" | "tsv" | "delimited" | "json" | "excel";
export type TableImportJsonShape = "auto" | "objects" | "arrays";
export type TableImportTextEncoding = "auto" | "utf8" | "gbk" | "utf16Le" | "utf16Be";

export interface TableImportColumnMapping {
  sourceColumn: string;
  targetColumn: string;
  targetDataType?: string | null;
}

export interface TableImportParseOptions {
  delimiter?: string | null;
  encoding?: TableImportTextEncoding | null;
  hasHeader?: boolean | null;
  titleRow?: number | null;
  dataStartRow?: number | null;
  lastDataRow?: number | null;
  trimValues?: boolean | null;
  emptyStringAsNull?: boolean | null;
  sheetName?: string | null;
  sheetIndex?: number | null;
  jsonShape?: TableImportJsonShape | null;
}

export interface TableImportPreviewRequest {
  filePath: string;
  sourceRef?: string | null;
  sourceFormat?: TableImportSourceFormat | null;
  parseOptions?: TableImportParseOptions | null;
  previewLimit?: number | null;
}

export interface TableImportPreview {
  fileName: string;
  filePath: string;
  sourceRef?: string | null;
  fileType: string;
  sizeBytes: number;
  columns: string[];
  rows: unknown[][];
  totalRows: number;
  totalRowsExact?: boolean;
  sourceFingerprint: string;
  effectiveEncoding?: TableImportTextEncoding | null;
  sheets?: string[];
}

export interface TableImportPreparedSource {
  fingerprint: string;
  columns: string[];
  rows: unknown[][];
  totalRows: number;
  totalRowsExact?: boolean;
  effectiveEncoding?: TableImportTextEncoding | null;
}

export interface TableImportRequest {
  importId: string;
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  filePath: string;
  sourceRef?: string | null;
  sourceFormat?: TableImportSourceFormat | null;
  parseOptions?: TableImportParseOptions | null;
  mappings: TableImportColumnMapping[];
  mode: TableImportMode;
  createTable?: boolean;
  batchSize: number;
  dateTimeFormat?: string;
  preparedSource?: TableImportPreparedSource | null;
  retainSource?: boolean;
}

export interface TableImportSummary {
  importId: string;
  rowsImported: number;
  totalRows: number;
  elapsedMs: number;
}

export interface TableImportProgress {
  importId: string;
  status: TableImportStatus;
  phase?: TableImportPhase;
  rowsImported: number;
  totalRows: number;
  totalRowsExact?: boolean;
  bytesRead?: number;
  totalBytes?: number;
  elapsedMs: number;
  error?: string | null;
}

export async function previewTableImportFile(filePathOrRequest: string | File | TableImportPreviewRequest, options: Partial<TableImportPreviewRequest> = {}): Promise<TableImportPreview> {
  if (typeof filePathOrRequest !== "string" && !("filePath" in filePathOrRequest)) {
    throw new Error("previewTableImportFile in desktop mode requires a file path, not a File object");
  }
  const request: TableImportPreviewRequest = typeof filePathOrRequest === "string" ? { ...options, filePath: filePathOrRequest } : filePathOrRequest;
  return invoke("preview_table_import_file", { request });
}

export async function importTableFile(request: TableImportRequest, onProgress: (progress: TableImportProgress) => void): Promise<TableImportSummary> {
  const unlisten: UnlistenFn = await listen<TableImportProgress>("table-import-progress", (event) => {
    if (event.payload.importId === request.importId) {
      onProgress(event.payload);
      if (event.payload.status === "done" || event.payload.status === "error" || event.payload.status === "cancelled") {
        unlisten();
      }
    }
  });
  try {
    const summary = await invoke<TableImportSummary>("import_table_file", {
      request,
    });
    unlisten();
    return summary;
  } catch (e) {
    unlisten();
    throw e instanceof BackendErrorException ? e : new BackendErrorException(e);
  }
}

export async function cancelTableImport(importId: string): Promise<boolean> {
  return invoke("cancel_table_import", { importId });
}

export async function releaseTableImportSource(_sourceRef: string): Promise<boolean> {
  return false;
}

// --- Database Export ---
export interface DatabaseExportRequest {
  exportId: string;
  connectionId: string;
  database: string;
  schema: string;
  filePath: string;
  selectedTables?: string[];
  excludedTables?: string[];
  includeStructure: boolean;
  includeData: boolean;
  includeObjects: boolean;
  includeCreateDatabase?: boolean;
  dropTableIfExists?: boolean;
  omitAutoIncrement?: boolean;
  failOnError?: boolean;
  snapshotSessionId?: string;
  batchSize: number;
}

export interface DatabaseBackupSnapshot {
  sessionId: string;
  schemas: string[];
}

export interface ExportProgress {
  exportId: string;
  currentObject: string;
  objectIndex: number;
  totalObjects: number;
  rowsExported: number;
  totalRows: number | null;
  status: "Running" | "Done" | "Error" | "Cancelled";
  error: string | null;
  /** True while listing schema / prefetching metadata before objects are written. */
  preparing?: boolean;
}

// --- Table Export ---
export type TableExportStatus = "Running" | "Writing" | "Done" | "Error" | "Cancelled";

export interface TableExportRequest {
  exportId: string;
  connectionId: string;
  database: string;
  schema?: string;
  identifierQuote?: string;
  tableName: string;
  filePath: string;
  format: "csv" | "xlsx" | "json" | "markdown" | "sql" | "txt";
  columns?: string[];
  columnTypes?: Array<string | null | undefined>;
  columnComments?: Array<string | null> | null;
  primaryKeys?: string[];
  whereInput?: string;
  orderBy?: string;
  skipCount?: boolean;
  batchSize?: number;
  rowLimit?: number | null;
  dateTimeFormat?: string;
  numericColumnRightAlign?: boolean;
}

export interface TableCsvExportOptions {
  filePath: string;
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
  columns?: string[];
  pageSize?: number;
  timeoutSecs?: number;
}

export interface TableExportProgress {
  exportId: string;
  tableName: string;
  rowsExported: number;
  totalRows: number | null;
  status: TableExportStatus;
  errorMessage?: string;
}

export interface QueryResultExportRequest {
  exportId: string;
  connectionId: string;
  database: string;
  schema?: string;
  sql: string;
  queryBaseSql: string;
  setupSql?: string[];
  databaseType: DatabaseType;
  useAgentCursor: boolean;
  filePath: string;
  format: "csv" | "xlsx" | "txt" | "sql";
  includeSqlSheet?: boolean;
  pageSize: number;
  rowLimit?: number | null;
  totalRows?: number | null;
  timeoutSecs?: number;
  keysetOptimizationEnabled: boolean;
  clientSessionId?: string;
  executionId?: string;
  dateTimeFormat?: string;
  exportTableName?: string;
  exportColumnTypes?: Array<string | null | undefined>;
  numericColumnRightAlign?: boolean;
  columnComments?: Array<string | null> | null;
}

export async function startTableExport(request: TableExportRequest, onProgress: (progress: TableExportProgress) => void): Promise<TableExportProgress> {
  let unlisten: UnlistenFn | undefined;
  let settled = false;
  let resolveTerminal: (progress: TableExportProgress) => void = () => {};
  let rejectTerminal: (error: unknown) => void = () => {};

  const terminalProgress = new Promise<TableExportProgress>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });

  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    unlisten?.();
    callback();
  };

  try {
    unlisten = await listen<TableExportProgress>("table-export-progress", (event) => {
      if (event.payload.exportId !== request.exportId) return;
      onProgress(event.payload);
      if (event.payload.status === "Done" || event.payload.status === "Error" || event.payload.status === "Cancelled") {
        if (event.payload.status === "Error") {
          finish(() => rejectTerminal(new BackendErrorException(event.payload.errorMessage || "Export failed")));
        } else {
          finish(() => resolveTerminal(event.payload));
        }
      }
    });
    await invoke("start_table_export", { request });
    return await terminalProgress;
  } catch (error) {
    if (!settled) {
      settled = true;
      unlisten?.();
    }
    throw error instanceof BackendErrorException ? error : new BackendErrorException(error);
  }
}

export async function cancelTableExport(exportId: string): Promise<void> {
  return invoke("cancel_table_export", { exportId });
}

export async function startQueryResultExport(request: QueryResultExportRequest, onProgress: (progress: TableExportProgress) => void): Promise<TableExportProgress> {
  let unlisten: UnlistenFn | undefined;
  let settled = false;
  let resolveTerminal: (progress: TableExportProgress) => void = () => {};
  let rejectTerminal: (error: unknown) => void = () => {};

  const terminalProgress = new Promise<TableExportProgress>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });

  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    unlisten?.();
    callback();
  };

  try {
    unlisten = await listen<TableExportProgress>("query-result-export-progress", (event) => {
      if (event.payload.exportId !== request.exportId) return;
      onProgress(event.payload);
      if (event.payload.status === "Done" || event.payload.status === "Error" || event.payload.status === "Cancelled") {
        if (event.payload.status === "Error") {
          finish(() => rejectTerminal(new BackendErrorException(event.payload.errorMessage || "Export failed")));
        } else {
          finish(() => resolveTerminal(event.payload));
        }
      }
    });
    await invoke("start_query_result_export", { request });
    return await terminalProgress;
  } catch (error) {
    if (!settled) {
      settled = true;
      unlisten?.();
    }
    throw error instanceof BackendErrorException ? error : new BackendErrorException(error);
  }
}

export async function cancelQueryResultExport(exportId: string, executionId?: string): Promise<void> {
  return invoke("cancel_query_result_export", {
    exportId,
    executionId: executionId || null,
  });
}

export async function beginDatabaseBackupSnapshot(connectionId: string, database: string): Promise<DatabaseBackupSnapshot> {
  return invoke("begin_database_backup_snapshot", { connectionId, database });
}

export async function exportDatabaseSql(request: DatabaseExportRequest, onProgress: (progress: ExportProgress) => void): Promise<void> {
  const unlisten: UnlistenFn = await listen<ExportProgress>("database-export-progress", (event) => {
    if (event.payload.exportId === request.exportId) {
      onProgress(event.payload);
      if (event.payload.status === "Done" || event.payload.status === "Error" || event.payload.status === "Cancelled") {
        unlisten();
      }
    }
  });
  try {
    await invoke("export_database_sql", { request });
  } catch (e) {
    unlisten();
    throw e;
  }
}

export async function cancelDatabaseExport(exportId: string): Promise<void> {
  await invoke("cancel_database_export", { exportId });
}

export async function exportQueryResultCsv(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  return invoke("export_query_result_csv", {
    request: {
      filePath,
      columns,
      rows,
    },
  });
}

export async function exportTableDataCsv(options: TableCsvExportOptions): Promise<number> {
  return invoke("export_table_data_csv", { request: options });
}

export async function exportQueryResultXlsx(filePath: string, sheetName: string | undefined, columns: string[], columnTypes: string[], columnComments: readonly (string | null)[] | undefined, rows: readonly (readonly XlsxCellValue[])[], numericColumnRightAlign?: boolean): Promise<void> {
  return invoke("export_query_result_xlsx", {
    request: {
      filePath,
      sheetName,
      columns,
      columnTypes,
      columnComments,
      rows,
      numericColumnRightAlign,
    },
  });
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
  return invoke("export_query_results_xlsx", {
    request: {
      filePath,
      worksheets,
    },
  });
}

export async function exportQueryResultJson(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  return invoke("export_query_result_json", {
    request: {
      filePath,
      columns,
      rows,
    },
  });
}

export async function exportQueryResultMarkdown(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  return invoke("export_query_result_markdown", {
    request: {
      filePath,
      columns,
      rows,
    },
  });
}

export * from "@/lib/backend/git-tauri";
export type * from "@/types/git";
