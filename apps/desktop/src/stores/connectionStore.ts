import { defineStore } from "pinia";
import { uuid } from "@/lib/common/utils";
import { containsHan, orderedSubsequenceSpan, pinyinFirstLetters } from "@/lib/common/pinyin";
import { ref, computed, watch, markRaw } from "vue";
import { safeLocalStorageSet, safeLocalStorageRemove, safeLocalStorageGet } from "@/lib/backend/safeStorage";
import type {
  ColumnInfo,
  CompletionAssistantCandidate,
  CompletionAssistantObjectKind,
  CompletionAssistantRequest,
  ConnectionConfig,
  DatabaseType,
  DatabaseConnectionInfo,
  DatabaseStorageInfo,
  ForeignKeyInfo,
  ObjectInfo,
  ObjectStatistics,
  SchemaInfo,
  SidebarLayout,
  TableNameFilter,
  TableInfo,
  TreeNode,
  TunnelProfile,
} from "@/types/database";
import {
  inheritNaturalTreeNodeOrder,
  migrateLegacyPinnedTreeNodeOrder,
  normalizePinnedTreeNodeOrder,
  orderItemsByPinnedTreeNodeOrder,
  pinnedTreeNodeIdentityMatches,
  removePinnedTreeNodesFromOrder,
  reorderPinnedTreeNodeOrder,
  replacePinnedTreeNodeInOrder,
  syncPinnedTreeNodeStateInPlace,
  treeNodePinIdentity,
  treeNodePinKey,
  type PinnedTreeNodeIdentity,
  type PinnedTreeNodeIdentityCanonicalizer,
} from "@/lib/app/pinnedItems";
import {
  reconcileLayout,
  buildTreeNodesFromLayout,
  emptyLayout,
  appendConnectionToLayout,
  removeConnectionFromSidebarLayout,
  findConnectionLocation,
  createGroup as createGroupOp,
  renameGroup as renameGroupOp,
  deleteGroup as deleteGroupOp,
  toggleGroupCollapsed as toggleGroupCollapsedOp,
  collapseAllGroups as collapseAllGroupsOp,
  moveConnectionToGroup as moveConnectionToGroupOp,
  remapSidebarLayoutConnectionIds,
  reorderEntry as reorderEntryOp,
  buildConnectionGroupPathMap,
  type DropPosition,
} from "@/lib/sidebar/sidebarLayout";
import type { SqlCompletionColumn, SqlCompletionForeignKey, SqlCompletionObject, SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import { mergeSqlObjectNavigationType, sqlObjectNavigationTypeFromTableType } from "@/lib/sql/sqlNavigation";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useTunnelProfileStore } from "@/stores/tunnelProfileStore";
import { isSchemaAware, normalizeSidebarObjectKind, sidebarObjectKindsForDatabase, usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import { connectionObjectTreeNodeSchema, connectionObjectTreeQuerySchema, connectionShouldDiscoverJdbcSchemas, connectionShouldLoadIdentifierQuote, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection, gaussdbIdentifierQuoteOverride } from "@/lib/database/jdbcDialect";
import { buildDatabaseTreeNodes, sortSidebarNames } from "@/lib/database/databaseTree";
import { loadRoutineParameters } from "@/lib/table/routineParameters";
import { collapseExpandedTreeNodes } from "@/lib/sidebar/sidebarTreeCollapse";
import { findDatabaseTreeNode } from "@/lib/sidebar/treeRefreshTarget";
import { simpleModeEmptyShellNeedsConfirmedLoad, treeNodeLoadedChildrenContentPresent } from "@/lib/sidebar/treeLoadedChildrenMarker";
import { shouldMarkDisconnected } from "@/lib/connection/connectionHealth";
import { connectionAttemptOriginalErrorMessage, connectionAttemptTimeoutMessage, connectionAttemptTimeoutMs } from "@/lib/connection/connectionAttemptTimeout";
import { deleteTabResultSnapshotsForOwner } from "@/lib/tabs/tabResultCache";
import { connectionUsesVisibleSchemaFilter, filterDatabaseNamesForConnection, filterSchemaNamesForConnection, normalizeVisibleDatabaseSelection } from "@/lib/database/visibleDatabases";
import {
  buildObjectGroupPlaceholderNodes,
  buildGroupedObjectTreeNodes,
  buildSimpleObjectTreeNodes,
  buildTableTreeNodes,
  appendTableTreeLoadMoreNode,
  expandCachedObjectBrowserNodes,
  filterSimpleSidebarSupplementalObjects,
  mergeTableInfosIntoObjects,
  mergeTableTreePageChildren,
  objectGroupRefreshParentId,
  objectTypesForGroupNode,
  sortDatabaseObjectsByName,
  tablePartitionGroups,
  withoutTableTreeLoadMoreNodes,
  type TableTreeLoadMoreParent,
  type DatabaseObjectTreeKind,
} from "@/lib/table/tableTree";
import { hasTreeNodeDatabaseContext, normalizeCataloglessDatabaseNodes, treeNodeSchemaCachePrefix } from "@/lib/sidebar/treeNodeContext";
import { decodeSchemaTreeCache, encodeSchemaTreeCache } from "@/lib/metadata/schemaTreeCache";
import { sortSidebarTreeChildrenForParent } from "@/lib/sidebar/sidebarNodeOrdering";
import { connectionSupportsDatabaseUserAdmin } from "@/lib/database/databaseUserAdmin";
import { getTableMetadataCapabilities } from "@/lib/table/tableMetadataCapabilities";
import { useSettingsStore } from "@/stores/settingsStore";
import { completionSchemasFromTree, completionTablesFromTree } from "@/lib/metadata/completionTreeIndex";
import { appendAgentDriverUpdateHint, hasAgentDriverUpdate, type AgentDriverInstallState } from "@/lib/connection/agentDriverInstallHint";
import { appendConnectionErrorHints } from "@/lib/connection/connectionErrorHints";
import { appendVisibleDatabaseSelection } from "@/lib/connection/connectionVisibleDatabases";
import { configuredDatabaseProductName, connectionConfigFingerprint, normalizeDatabaseConnectionInfo } from "@/lib/connection/connectionDatabaseInfo";
import { createMetadataLoadTrace, logMetadataLoadTrace, MetadataLoadCoordinator, type MetadataLoadTraceLogger } from "@/lib/metadata/metadataLoadCoordinator";
import type { MetadataScopeInput } from "@/lib/metadata/metadataLoadScope";
import { MetadataResultCache, type MetadataCacheInvalidation } from "@/lib/metadata/metadataResultCache";
import { invalidateTableMetadataCache } from "@/lib/metadata/tableMetadataCache";
import { invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { MetadataTaskLimiter } from "@/lib/metadata/metadataTaskLimiter";
import { TreeNodeLoadRegistry, type TreeNodeLoadHandle } from "@/lib/metadata/treeNodeLoadHandle";
import i18n from "@/i18n";
import { applySidebarDatabaseStorage, applySidebarTableStorage, sidebarDatabaseNames, supportsSidebarDatabaseStorage, supportsSidebarTableStorage, type SidebarTableStorageScope } from "@/lib/sidebar/sidebarDatabaseStorage";

const PINNED_TREE_NODES_STORAGE_KEY = "ogdeveloper-pinned-tree-nodes";
const ACTIVE_CONNECTION_STORAGE_KEY = "ogdeveloper-active-connection";
const SIDEBAR_TABLE_NAME_FILTERS_STORAGE_KEY = "ogdeveloper-sidebar-table-name-filters";
const CONNECTION_HEALTH_CHECK_TTL_MS = 2000;
const CONNECTION_HEALTH_CHECK_TIMEOUT_MS = 5000;
const METADATA_LOAD_MIN_TIMEOUT_MS = 15_000;
const METADATA_LOAD_DISABLED_QUERY_TIMEOUT_MS = 60_000;
const DISCONNECT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_KEEPALIVE_INTERVAL_SECS = 30;
const METADATA_LIST_PAGE_CACHE_TTL_MS = 30_000;
const METADATA_LIST_PAGE_CACHE_MAX_ENTRIES = 160;
const SIDEBAR_DATABASE_STORAGE_CACHE_TTL_MS = 30_000;
export const COMPLETION_METADATA_CONCURRENCY = 2;
const SUPERSEDED_CONNECTION_ATTEMPT_MESSAGE = "Connection attempt was superseded by a newer attempt";

function normalizeTableNameFilter(filter: Partial<TableNameFilter> | undefined | null): TableNameFilter {
  const normalizePatterns = (patterns: unknown): string[] => (Array.isArray(patterns) ? patterns.map((pattern) => (typeof pattern === "string" ? pattern.trim() : "")).filter(Boolean) : []);
  return {
    includePatterns: normalizePatterns(filter?.includePatterns),
    excludePatterns: normalizePatterns(filter?.excludePatterns),
  };
}

function tableNameFilterIsEmpty(filter: TableNameFilter | undefined | null): boolean {
  return !filter || (filter.includePatterns.length === 0 && filter.excludePatterns.length === 0);
}

function loadSidebarTableNameFilters(): Record<string, TableNameFilter> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(safeLocalStorageGet(SIDEBAR_TABLE_NAME_FILTERS_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, TableNameFilter> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const filter = normalizeTableNameFilter(value as Partial<TableNameFilter>);
      if (!tableNameFilterIsEmpty(filter)) result[key] = filter;
    }
    return result;
  } catch {
    return {};
  }
}

function saveSidebarTableNameFilters(filters: Record<string, TableNameFilter>) {
  if (typeof localStorage === "undefined") return;
  safeLocalStorageSet(SIDEBAR_TABLE_NAME_FILTERS_STORAGE_KEY, JSON.stringify(filters));
}

function sidebarObjectGroupPageSize(): number {
  const settingsStore = useSettingsStore();
  const size = settingsStore.desktopSettings.sidebar_table_page_size;
  return typeof size === "number" && size > 0 ? size : 500;
}

type ImportSource = "dbx" | "navicat" | "dbeaver" | "datagrip";

interface LocateTableTarget {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
}

// Temporary storage for DataGrip import payload (used to read Keychain passwords after import)
let pendingDataGripPayload: { format: "datagrip-import"; dataSources: string; dataSourcesLocal?: string; dbForestConfig?: string } | null = null;

interface TreeClipboardTableEntry {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
  tableComment?: string | null;
}

interface TreeClipboardConnectionEntry {
  config: ConnectionConfig;
  sourceGroupId: string | null;
}

export type TreeClipboard =
  | {
      kind: "table-copy";
      tables: TreeClipboardTableEntry[];
    }
  | {
      kind: "connection-copy";
      connections: TreeClipboardConnectionEntry[];
    };

interface LoadTreeOptions {
  force?: boolean;
  connectedOnly?: boolean;
  expectedSidebarSearchQuery?: string;
  searchFilter?: string;
  sidebarTableSearchParentId?: string;
  expectedSidebarTableSearchQuery?: string;
  tableNameFilterScopeKey?: string;
  expectedTableNameFilterRevision?: number;
}

interface PersistedTreeChildrenLoadResult {
  hit: boolean;
  isStale: boolean;
}

type MetadataListPageResult = TableInfo[] | ObjectInfo[];

type BeforeConnectHandler = (config: ConnectionConfig) => Promise<void>;

export const CONNECTION_ATTEMPT_CANCELLED_MESSAGE = "Connection attempt was cancelled";

function metadataDriverProfile(config?: ConnectionConfig): string | undefined {
  return config?.driver_profile || config?.db_type;
}

export const useConnectionStore = defineStore("connection", () => {
  const settingsStore = useSettingsStore();
  const tunnelProfileStore = useTunnelProfileStore();
  const connections = ref<ConnectionConfig[]>([]);
  const isDesktop = isTauriRuntime();
  const activeConnectionId = ref<string | null>(safeLocalStorageGet(ACTIVE_CONNECTION_STORAGE_KEY));
  const selectedTreeNodeId = ref<string | null>(null);
  const selectedTreeNodeIds = ref<string[]>([]);
  // O(1) membership set — rebuilds only when selectedTreeNodeIds changes.
  // Avoids O(N) Array.includes() in every visible TreeItem's isMultiSelected
  // computed during scrolling and selection changes.
  const selectedTreeNodeIdsSet = computed(() => new Set(selectedTreeNodeIds.value));
  const treeSelectionAnchorId = ref<string | null>(null);
  const connectionMultiSelectActive = ref(false);
  const treeClipboard = ref<TreeClipboard | null>(null);

  watch(activeConnectionId, (id) => {
    if (id) safeLocalStorageSet(ACTIVE_CONNECTION_STORAGE_KEY, id);
    else safeLocalStorageRemove(ACTIVE_CONNECTION_STORAGE_KEY);
  });
  const treeNodes = ref<TreeNode[]>([]);
  const sidebarDatabaseStorageCache = new Map<string, { expiresAt: number; value: DatabaseStorageInfo[] }>();
  const sidebarDatabaseStorageInFlight = new Map<string, Promise<DatabaseStorageInfo[]>>();
  const sidebarTableStorageCache = new Map<string, { expiresAt: number; value: ObjectStatistics[] }>();
  const sidebarTableStorageInFlight = new Map<string, Promise<ObjectStatistics[]>>();
  const pinnedTreeNodeOrder = ref<string[]>([]);
  const pinnedTreeNodeIds = ref<Set<string>>(new Set());
  const activePinnedTreeNodeReorderKey = ref<string | null>(null);
  let pinnedTreeNodePersistQueue: Promise<void> = Promise.resolve();
  const connectedIds = ref<Set<string>>(new Set());
  const identifierQuotes = ref<Record<string, string>>({});
  const lastConnectionHealthCheckAt = ref<Record<string, number>>({});
  const agentDrivers = ref<AgentDriverInstallState[]>([]);
  let agentDriversRefreshPromise: Promise<void> | null = null;
  const loadedTreeNodeChildrenIds = ref<Set<string>>(new Set());
  /** Simple-mode database/schema nodes loaded successfully with zero objects (not refresh stale shells). */
  const confirmedEmptyTreeNodeIds = ref<Set<string>>(new Set());
  const connectionErrors = ref<Record<string, string>>({});
  const connectingIds = ref<Set<string>>(new Set());
  const editingConnectionId = ref<string | null>(null);
  const newConnectionGroupId = ref<string | null>(null);
  const completionTablesCache = ref<Record<string, SqlCompletionTable[]>>({});
  const completionObjectsCache = ref<Record<string, SqlCompletionObject[]>>({});
  const completionColumnsCache = ref<Record<string, ColumnInfo[]>>({});
  const completionForeignKeysCache = ref<Record<string, ForeignKeyInfo[]>>({});
  const completionDatabasesCache = ref<Record<string, string[]>>({});
  const schemaListCache = ref<Record<string, string[]>>({});
  const sidebarSearchQuery = ref("");
  const sidebarTableSearchQueries = ref<Record<string, string>>({});
  const sidebarTableNameFilters = ref<Record<string, TableNameFilter>>(loadSidebarTableNameFilters());
  const sidebarTableNameFilterRevisions = new Map<string, number>();
  const completionTableIndex = new Map<string, { touched: number; tables: SqlCompletionTable[] }>();
  const completionObjectIndex = new Map<string, { touched: number; objects: SqlCompletionObject[] }>();
  const completionColumnIndex = new Map<string, { touched: number; columns: SqlCompletionColumn[] }>();
  const completionForeignKeyIndex = new Map<string, { touched: number; foreignKeys: SqlCompletionForeignKey[] }>();
  const completionInFlight = new Map<string, Promise<unknown>>();
  const completionMetadataLimiter = new MetadataTaskLimiter(COMPLETION_METADATA_CONCURRENCY, (event) => {
    console.debug("[ogdeveloper][completion-metadata:limit]", event);
  });
  const transferSource = ref<{
    connectionId: string;
    database: string;
    catalog?: string;
    schema?: string;
    tables?: string[];
    targetConnectionId?: string;
    targetDatabase?: string;
    targetSchema?: string;
  } | null>(null);
  const schemaDiffSource = ref<{ connectionId: string; database: string; schema?: string } | null>(null);
  const dataCompareSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName?: string;
  } | null>(null);
  const sqlFileSource = ref<{ connectionId: string; database: string; filePath?: string } | null>(null);
  const diagramSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName?: string;
  } | null>(null);
  const tableImportSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName?: string;
  } | null>(null);
  const tableDataGenerateSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName: string;
  } | null>(null);
  const fieldLineageSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName: string;
    columnName: string;
  } | null>(null);
  const databaseSearchSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    keyword?: string;
  } | null>(null);
  const databaseExportSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName?: string;
    tableNames?: string[];
    allDatabases?: boolean;
  } | null>(null);
  const sidebarLayout = ref<SidebarLayout>(emptyLayout());
  const connectionGroupPaths = computed(() => buildConnectionGroupPathMap(sidebarLayout.value));
  let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;
  const staleTreeRefreshIds = new Set<string>();
  const activeTreeRefreshGenerations = new Map<string, number>();
  let nextTreeRefreshGeneration = 0;
  const metadataLoadCoordinator = new MetadataLoadCoordinator((event) => {
    console.debug("[ogdeveloper][metadata-load:coordinator]", event);
  });
  const metadataListPageCache = new MetadataResultCache<MetadataListPageResult>({
    ttlMs: METADATA_LIST_PAGE_CACHE_TTL_MS,
    maxEntries: METADATA_LIST_PAGE_CACHE_MAX_ENTRIES,
  });
  const metadataTraceLogger: MetadataLoadTraceLogger = (event) => {
    console.debug("[ogdeveloper][metadata-load:trace]", event);
  };
  const connectInFlight = new Map<string, Promise<void>>();
  const disconnectInFlight = new Map<string, Promise<void>>();
  const disconnectInFlightScoped = new Map<string, boolean>();
  const cancelDisconnectInFlight = new Map<string, Promise<void>>();
  const activeLocalConnectionAttempts = new Map<string, number>();
  const cancelledLocalConnectionAttempts = new Map<string, Set<number>>();
  const successfulLocalConnectionAttempts = new Map<string, number>();
  const connectionStateRevisions = new Map<string, number>();
  const connectionErrorRevisions = new Map<string, number>();
  const treeNodeLoads = new TreeNodeLoadRegistry();
  let nextLocalConnectionAttempt = 0;
  let beforeConnectHandler: BeforeConnectHandler | null = null;
  let initFromDiskPromise: Promise<void> | null = null;

  // Loading/stale ownership stays on TreeNodeLoadRegistry (per-node generation), not the
  // coordinator: many specialty loaders bypass runTreeMetadataLoad, and coordinator would
  // otherwise need TreeNode/connected awareness. Keep coordinator for scope dedupe only.
  // connectionStateRevision remains for disconnect/error cleanup; reconnect also invalidates
  // tree loads via bump → treeNodeLoads.invalidateConnection.
  function runTreeMetadataLoad<T>(scope: MetadataScopeInput, task: () => Promise<T>, options?: LoadTreeOptions): Promise<T> {
    return metadataLoadCoordinator.run(scope, task, { force: options?.force, kind: scope.kind });
  }

  async function loadCachedMetadataListPage<T extends MetadataListPageResult>(scope: MetadataScopeInput, load: () => Promise<T>, options?: { force?: boolean }): Promise<T> {
    const trace = createMetadataLoadTrace(scope);
    if (!options?.force) {
      const cached = metadataListPageCache.get(scope);
      if (cached) {
        logMetadataLoadTrace(metadataTraceLogger, trace, "cache-hit", {
          cacheStatus: cached.stale ? "stale" : "hit",
          resultCount: cached.value.length,
          stale: cached.stale,
        });
        return cached.value as T;
      }
    }

    logMetadataLoadTrace(metadataTraceLogger, trace, "cache-miss", { cacheStatus: options?.force ? "refresh" : "miss", force: options?.force === true });
    const errorRevision = connectionErrorRevision(scope.connectionId);
    const result = await load();
    clearConnectionErrorIfUnchanged(scope.connectionId, errorRevision);
    // Do not cache empty list pages: a transient backend failure or an older
    // driver that lacked the metadata would otherwise pin an empty result for
    // the whole TTL, forcing manual refreshes to reveal objects.
    if (result.length > 0) {
      metadataListPageCache.set(scope, result);
    }
    logMetadataLoadTrace(metadataTraceLogger, trace, "done", {
      cacheStatus: options?.force ? "refresh" : "miss",
      resultCount: result.length,
      force: options?.force === true,
    });
    return result;
  }

  function startEditing(id: string) {
    editingConnectionId.value = id;
  }

  function stopEditing() {
    editingConnectionId.value = null;
  }

  function startCreatingConnectionInGroup(groupId: string) {
    stopEditing();
    newConnectionGroupId.value = groupId;
  }

  function stopCreatingConnectionInGroup() {
    newConnectionGroupId.value = null;
  }

  const configById = computed(() => new Map(connections.value.map((c) => [c.id, c])));

  function getConfig(connectionId: string) {
    return configById.value.get(connectionId);
  }

  function connectionIdentifierQuote(connectionId?: string): string | undefined {
    if (!connectionId) return undefined;
    const override = gaussdbIdentifierQuoteOverride(getConfig(connectionId));
    if (override != null) return override;
    return identifierQuotes.value[connectionId];
  }

  function clearConnectionIdentifierQuote(connectionId: string) {
    if (!(connectionId in identifierQuotes.value)) return;
    const next = { ...identifierQuotes.value };
    delete next[connectionId];
    identifierQuotes.value = next;
  }

  async function refreshConnectionIdentifierQuote(connectionId: string, config: ConnectionConfig) {
    clearConnectionIdentifierQuote(connectionId);
    if (!connectionShouldLoadIdentifierQuote(config)) return;
    const quote = await api.connectionIdentifierQuote(connectionId).catch(() => undefined);
    if (quote != null) identifierQuotes.value = { ...identifierQuotes.value, [connectionId]: quote };
  }

  function connectionErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  function isSupersededConnectionAttempt(error: unknown): boolean {
    return connectionErrorMessage(error).includes(SUPERSEDED_CONNECTION_ATTEMPT_MESSAGE);
  }

  function isCancelledConnectionAttempt(error: unknown): boolean {
    return connectionErrorMessage(error).includes(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
  }

  function beginLocalConnectionAttempt(connectionId: string): number {
    const attempt = ++nextLocalConnectionAttempt;
    bumpConnectionStateRevision(connectionId);
    activeLocalConnectionAttempts.set(connectionId, attempt);
    connectingIds.value.add(connectionId);
    const node = findConnectionNode(connectionId);
    if (node) node.isLoading = true;
    return attempt;
  }

  function markSuccessfulLocalConnectionAttempt(connectionId: string, attempt: number) {
    successfulLocalConnectionAttempts.set(connectionId, attempt);
  }

  function forgetSuccessfulLocalConnectionAttempt(connectionId: string) {
    successfulLocalConnectionAttempts.delete(connectionId);
  }

  function bumpConnectionStateRevision(connectionId: string): number {
    const revision = (connectionStateRevisions.get(connectionId) ?? 0) + 1;
    connectionStateRevisions.set(connectionId, revision);
    // Invalidate per-node load generations under this connection (and clear sticky
    // spinners on surviving nodes). Active loaders reclaim after ensureConnected.
    treeNodeLoads.invalidateConnection(connectionId, findConnectionNode(connectionId));
    return revision;
  }

  function connectionStateRevision(connectionId: string): number {
    return connectionStateRevisions.get(connectionId) ?? 0;
  }

  function isCurrentConnectionStateRevision(connectionId: string, revision: number): boolean {
    return connectionStateRevision(connectionId) === revision;
  }

  function isCurrentLocalConnectionAttempt(connectionId: string, attempt: number): boolean {
    return activeLocalConnectionAttempts.get(connectionId) === attempt;
  }

  function isCancelledLocalConnectionAttempt(connectionId: string, attempt: number): boolean {
    return cancelledLocalConnectionAttempts.get(connectionId)?.has(attempt) === true;
  }

  function getLocalConnectionAttempt(connectionId: string): number | undefined {
    return activeLocalConnectionAttempts.get(connectionId);
  }

  function finishLocalConnectionAttempt(connectionId: string, attempt: number) {
    if (isCancelledLocalConnectionAttempt(connectionId, attempt)) {
      const attempts = cancelledLocalConnectionAttempts.get(connectionId);
      attempts?.delete(attempt);
      if (attempts?.size === 0) {
        cancelledLocalConnectionAttempts.delete(connectionId);
      }
    }
    if (!isCurrentLocalConnectionAttempt(connectionId, attempt)) return;
    activeLocalConnectionAttempts.delete(connectionId);
    connectingIds.value.delete(connectionId);
    clearConnectionNodeLoading(connectionId);
  }

  function cancelLocalConnectionAttempt(connectionId: string): boolean {
    const attempt = activeLocalConnectionAttempts.get(connectionId);
    if (attempt == null) return false;
    const attempts = cancelledLocalConnectionAttempts.get(connectionId) ?? new Set<number>();
    attempts.add(attempt);
    cancelledLocalConnectionAttempts.set(connectionId, attempts);
    activeLocalConnectionAttempts.delete(connectionId);
    connectingIds.value.delete(connectionId);
    clearConnectionNodeLoading(connectionId);
    clearConnectionRootMetadataLoad(connectionId);
    connectInFlight.delete(connectionId);
    return true;
  }

  function clearConnectionRootMetadataLoad(connectionId: string) {
    metadataLoadCoordinator.clear({
      kind: "connection-databases",
      connectionId,
      driverProfile: metadataDriverProfile(getConfig(connectionId)),
    });
  }

  function getBlockingDisconnectInFlight(connectionId: string): Promise<void> | undefined {
    return disconnectInFlightScoped.get(connectionId) ? undefined : disconnectInFlight.get(connectionId);
  }

  async function waitForBlockingDisconnectInFlight(connectionId: string): Promise<void> {
    const pending = getBlockingDisconnectInFlight(connectionId);
    if (pending) await pending;
  }

  function trackDisconnectRequest(connectionId: string, request: Promise<void>, scoped: boolean): Promise<void> {
    const bounded = withDisconnectRequestTimeout(connectionId, request);
    const tracked = bounded
      .catch((error) => {
        console.warn("[ogdeveloper][connection:disconnect-error]", { connectionId, error });
      })
      .finally(() => {
        if (disconnectInFlight.get(connectionId) === tracked) {
          disconnectInFlight.delete(connectionId);
          disconnectInFlightScoped.delete(connectionId);
        }
      });
    disconnectInFlight.set(connectionId, tracked);
    disconnectInFlightScoped.set(connectionId, scoped);
    return bounded;
  }

  function startDisconnectRequest(connectionId: string): Promise<void> {
    const clientAttempt = activeLocalConnectionAttempts.get(connectionId) ?? successfulLocalConnectionAttempts.get(connectionId);
    let request: Promise<void>;
    try {
      request = api.disconnectDb(connectionId, clientAttempt);
    } catch (error) {
      request = Promise.reject(error);
    }
    return trackDisconnectRequest(connectionId, request, clientAttempt != null);
  }

  function cancelDisconnectKey(connectionId: string, attempt: number): string {
    return `${connectionId}:${attempt}`;
  }

  function startCancelDisconnectRequest(connectionId: string, attempt: number): Promise<void> {
    const key = cancelDisconnectKey(connectionId, attempt);
    const existing = cancelDisconnectInFlight.get(key);
    if (existing) return existing;
    let request: Promise<void>;
    try {
      request = api.disconnectDb(connectionId, attempt);
    } catch (error) {
      request = Promise.reject(error);
    }
    const tracked = withDisconnectRequestTimeout(connectionId, request)
      .catch((error) => {
        console.warn("[ogdeveloper][connection:cancel-disconnect-error]", { connectionId, attempt, error });
        throw error;
      })
      .finally(() => {
        if (cancelDisconnectInFlight.get(key) === tracked) {
          cancelDisconnectInFlight.delete(key);
        }
      });
    cancelDisconnectInFlight.set(key, tracked);
    return tracked;
  }

  async function cleanupResolvedCancelledConnectionAttempt(connectionId: string, attempt: number) {
    try {
      // A cancel request can reach the backend before connect_db registers the
      // attempt, so clean again if that cancelled connect later returns a pool.
      await withDisconnectRequestTimeout(connectionId, api.disconnectDb(connectionId, attempt));
    } catch (error) {
      console.warn("[ogdeveloper][connection:cancel-result-cleanup-error]", { connectionId, attempt, error });
    }
  }

  async function ensureLocalConnectionAttemptActiveAfterConnectResult(connectionId: string, attempt: number, cleanupConnectionId: string) {
    if (isCancelledLocalConnectionAttempt(connectionId, attempt)) {
      await cleanupResolvedCancelledConnectionAttempt(cleanupConnectionId, attempt);
      throw new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
    }
    ensureLocalConnectionAttemptActive(connectionId, attempt);
  }

  function ensureLocalConnectionAttemptActive(connectionId: string, attempt: number) {
    if (isCancelledLocalConnectionAttempt(connectionId, attempt)) {
      throw new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
    }
    if (!isCurrentLocalConnectionAttempt(connectionId, attempt)) {
      throw new Error(SUPERSEDED_CONNECTION_ATTEMPT_MESSAGE);
    }
  }

  function setConnectionError(connectionId: string, message: string) {
    connectionErrors.value[connectionId] = message;
    connectionErrorRevisions.set(connectionId, connectionErrorRevision(connectionId) + 1);
  }

  function updateConnectionErrorPresentation(connectionId: string, expectedMessage: string, message: string) {
    // Hints decorate the current error event and must not invalidate a retry's recovery revision.
    if (connectionErrors.value[connectionId] !== expectedMessage) return;
    connectionErrors.value[connectionId] = message;
  }

  function connectionErrorRevision(connectionId?: string | null): number {
    return connectionId ? (connectionErrorRevisions.get(connectionId) ?? 0) : 0;
  }

  function clearConnectionErrorIfUnchanged(connectionId: string | null | undefined, revision: number) {
    if (!connectionId || connectionErrorRevision(connectionId) !== revision) return;
    clearConnectionError(connectionId);
  }

  function agentDriverUpdateHint(): string {
    return i18n.global.t("connection.agentDriverUpdateConnectionHint");
  }

  function connectionErrorWithDriverUpdateHint(config: ConnectionConfig | undefined, message: string): string {
    if (!config) return message;
    message = appendConnectionErrorHints(config, message, i18n.global.t);
    if (!hasAgentDriverUpdate(config.db_type, agentDrivers.value, config.driver_profile)) return message;
    return appendAgentDriverUpdateHint(message, agentDriverUpdateHint());
  }

  function refreshAgentDriversForErrorHint(): Promise<void> {
    if (agentDriversRefreshPromise) return agentDriversRefreshPromise;
    agentDriversRefreshPromise = api
      .listInstalledAgents()
      .then((drivers) => {
        agentDrivers.value = drivers;
      })
      .catch(() => undefined)
      .finally(() => {
        agentDriversRefreshPromise = null;
      });
    return agentDriversRefreshPromise;
  }

  function maybeAppendAgentDriverUpdateHint(connectionId: string, baseMessage: string) {
    const config = getConfig(connectionId);
    const message = connectionErrorWithDriverUpdateHint(config, baseMessage);
    if (message !== baseMessage) {
      updateConnectionErrorPresentation(connectionId, baseMessage, message);
      return;
    }
    void refreshAgentDriversForErrorHint().then(() => {
      if (connectionErrors.value[connectionId] !== baseMessage) return;
      const refreshedMessage = connectionErrorWithDriverUpdateHint(config, baseMessage);
      if (refreshedMessage !== baseMessage) updateConnectionErrorPresentation(connectionId, baseMessage, refreshedMessage);
    });
  }

  function clearConnectionError(connectionId: string) {
    if (!connectionErrors.value[connectionId]) return;
    delete connectionErrors.value[connectionId];
    connectionErrorRevisions.set(connectionId, connectionErrorRevision(connectionId) + 1);
  }

  function markConnectionHealthChecked(connectionId: string) {
    lastConnectionHealthCheckAt.value[connectionId] = Date.now();
  }

  function clearConnectionHealthCheck(connectionId: string) {
    if (!lastConnectionHealthCheckAt.value[connectionId]) return;
    delete lastConnectionHealthCheckAt.value[connectionId];
  }

  function hasRecentConnectionHealthCheck(connectionId: string) {
    const checkedAt = lastConnectionHealthCheckAt.value[connectionId];
    return typeof checkedAt === "number" && Date.now() - checkedAt < CONNECTION_HEALTH_CHECK_TTL_MS;
  }

  function clearConnectionNodeLoading(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (node) node.isLoading = false;
  }

  function metadataLoadTimeoutMs(config?: ConnectionConfig): number {
    const queryTimeoutSecs = Number(config?.query_timeout_secs);
    if (queryTimeoutSecs === 0) return METADATA_LOAD_DISABLED_QUERY_TIMEOUT_MS;
    const boundedTimeoutSecs = Number.isFinite(queryTimeoutSecs) && queryTimeoutSecs > 0 ? queryTimeoutSecs + 5 : 35;
    return Math.max(METADATA_LOAD_MIN_TIMEOUT_MS, boundedTimeoutSecs * 1000);
  }

  async function withConnectionHealthTimeout(connectionId: string, promise: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Connection health check timed out after ${Math.ceil(CONNECTION_HEALTH_CHECK_TIMEOUT_MS / 1000)}s.`));
          }, CONNECTION_HEALTH_CHECK_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      clearConnectionNodeLoading(connectionId);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function withMetadataLoadTimeout<T>(connectionId: string, promise: Promise<T>, label: string): Promise<T> {
    const timeoutMs = metadataLoadTimeoutMs(getConfig(connectionId));
    const errorRevision = connectionErrorRevision(connectionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Connection timed out while loading ${label} after ${Math.ceil(timeoutMs / 1000)}s. Please check the network or VPN and try again.`));
          }, timeoutMs);
        }),
      ]);
      clearConnectionErrorIfUnchanged(connectionId, errorRevision);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function withDisconnectRequestTimeout(connectionId: string, promise: Promise<void>): Promise<void> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void promise.catch((error) => {
      if (timedOut) console.warn("[ogdeveloper][connection:disconnect-late-error]", { connectionId, error });
    });
    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            console.warn("[ogdeveloper][connection:disconnect-timeout]", { connectionId, timeoutMs: DISCONNECT_REQUEST_TIMEOUT_MS });
            resolve();
          }, DISCONNECT_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function recordConnectionError(connectionId: string, error: unknown): string {
    const message = connectionErrorMessage(error);
    if (isCancelledConnectionAttempt(message)) {
      clearConnectionError(connectionId);
      return "";
    }
    setConnectionError(connectionId, message);
    maybeAppendAgentDriverUpdateHint(connectionId, message);
    return message;
  }

  function markConnectionLost(connectionId: string, error: unknown) {
    connectedIds.value.delete(connectionId);
    clearConnectionIdentifierQuote(connectionId);
    clearConnectionNodeLoading(connectionId);
    clearConnectionHealthCheck(connectionId);
    if (activeConnectionId.value === connectionId) activeConnectionId.value = null;
    recordConnectionError(connectionId, error);
  }

  function recordConnectionLostError(connectionId: string, error: unknown): boolean {
    if (shouldMarkDisconnected(error)) {
      markConnectionLost(connectionId, error);
      return true;
    }
    return false;
  }

  // Metadata loaders keep this internal: match connection-loss errors before recording generic errors.
  function recordMetadataLoadError(connectionId: string, error: unknown, load?: TreeNodeLoadHandle) {
    if (load && !load.isCurrent()) return;
    if (recordConnectionLostError(connectionId, error)) return;
    recordConnectionError(connectionId, error);
  }

  async function withConnectionAttemptTimeout<T>(promise: Promise<T>, config: ConnectionConfig): Promise<T> {
    const timeoutMs = connectionAttemptTimeoutMs(config, tunnelProfileStore.profileById);
    const timeoutMessage = connectionAttemptTimeoutMessage(timeoutMs);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void promise.then(
      (connectionId) => {
        if (!timedOut) return;
        const cleanupConnectionId = typeof connectionId === "string" && connectionId ? connectionId : config.id;
        if (connectedIds.value.has(cleanupConnectionId)) return;
        void api.disconnectDb(cleanupConnectionId).catch((error) => {
          console.warn("[ogdeveloper][connection:timeout-cleanup-failed]", { connectionId: cleanupConnectionId, error });
        });
      },
      (error) => {
        if (!timedOut) return;
        const current = connectionErrors.value[config.id];
        if (current !== timeoutMessage) return;
        setConnectionError(config.id, connectionAttemptOriginalErrorMessage(timeoutMessage, connectionErrorMessage(error)));
      },
    );
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(timeoutMessage));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function normalizeConnection(config: ConnectionConfig): ConnectionConfig {
    config = { ...config };
    const labelMap: Record<string, string> = {
      opengauss: "openGauss",
      postgres: "PostgreSQL",
      jdbc: "JDBC",
    };

    const profile = config.driver_profile || config.db_type;
    const dbType = config.db_type;

    return {
      ...config,
      db_type: dbType,
      driver_profile: profile,
      driver_label: config.driver_label || labelMap[profile] || config.db_type,
      url_params: config.url_params || "",
      agent_java_options: Array.isArray(config.agent_java_options) ? config.agent_java_options : [],
      init_script: config.init_script?.trim() ? config.init_script : undefined,
      transport_layers: Array.isArray(config.transport_layers) ? config.transport_layers : [],
      show_system_schemas: config.show_system_schemas === true,
      connect_timeout_secs: config.connect_timeout_secs || 10,
      query_timeout_secs: config.query_timeout_secs ?? 30,
      idle_timeout_secs: config.idle_timeout_secs ?? 60,
      keepalive_interval_secs: config.keepalive_interval_secs ?? DEFAULT_KEEPALIVE_INTERVAL_SECS,
      database_info: normalizeDatabaseConnectionInfo(config.database_info),
    };
  }

  function loadPinnedTreeNodeOrderFromLocalStorage(): string[] {
    try {
      if (typeof localStorage === "undefined") return [];
      const saved = safeLocalStorageGet(PINNED_TREE_NODES_STORAGE_KEY);
      const ids = saved ? JSON.parse(saved) : [];
      return normalizePinnedTreeNodeOrder(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
    } catch {
      return [];
    }
  }

  async function loadPinnedTreeNodeOrder(): Promise<string[]> {
    if (!isDesktop) return loadPinnedTreeNodeOrderFromLocalStorage();
    const ids = await api.loadPinnedTreeNodeIds().catch(() => []);
    const valid = normalizePinnedTreeNodeOrder(ids.filter((id): id is string => typeof id === "string"));
    if (valid.length > 0) return valid;

    // Migrate legacy localStorage values for existing desktop users.
    const legacy = loadPinnedTreeNodeOrderFromLocalStorage();
    if (legacy.length > 0) {
      await api.savePinnedTreeNodeIds(legacy).catch(() => undefined);
      if (typeof localStorage !== "undefined") {
        safeLocalStorageRemove(PINNED_TREE_NODES_STORAGE_KEY);
      }
    }
    return legacy;
  }

  function setPinnedTreeNodeOrder(order: readonly string[]) {
    const normalized = normalizePinnedTreeNodeOrder(order);
    pinnedTreeNodeOrder.value = normalized;
    pinnedTreeNodeIds.value = new Set(normalized);
  }

  function persistPinnedTreeNodeIds() {
    const snapshot = [...pinnedTreeNodeOrder.value];
    if (isDesktop) {
      // A later drag must never be persisted before an earlier request finishes:
      // otherwise a slow old request can overwrite the final ordering on disk.
      pinnedTreeNodePersistQueue = pinnedTreeNodePersistQueue.catch(() => undefined).then(() => api.savePinnedTreeNodeIds(snapshot).catch(() => undefined));
      return;
    }
    if (typeof localStorage === "undefined") return;
    safeLocalStorageSet(PINNED_TREE_NODES_STORAGE_KEY, JSON.stringify(snapshot));
  }

  function findLoadedTreeNodeById(nodes: readonly TreeNode[], id: string): TreeNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      const child = node.children ? findLoadedTreeNodeById(node.children, id) : null;
      if (child) return child;
      const hiddenChild = node.hiddenChildren ? findLoadedTreeNodeById(node.hiddenChildren, id) : null;
      if (hiddenChild) return hiddenChild;
    }
    return null;
  }

  function isTreeNodePinned(node: TreeNode | string): boolean {
    if (typeof node !== "string") return pinnedTreeNodeIds.value.has(treeNodePinKey(node)) || pinnedTreeNodeIds.value.has(node.id);
    if (pinnedTreeNodeIds.value.has(node)) return true;
    const loadedNode = findLoadedTreeNodeById(treeNodes.value, node);
    return !!loadedNode && pinnedTreeNodeIds.value.has(treeNodePinKey(loadedNode));
  }

  function isFixedPriorityTreeNode(node: TreeNode): boolean {
    if (node.type !== "database") return false;
    return !!node.connectionId && typeof node.database === "string" && isDefaultDatabase(node.connectionId, node.database);
  }

  function orderByPinnedTreeNodes<T>(items: readonly T[], matches: (item: T, identity: PinnedTreeNodeIdentity) => boolean): T[] {
    return orderItemsByPinnedTreeNodeOrder(items, pinnedTreeNodeOrder.value, matches, treeNodes.value);
  }

  function syncPinnedTreeState(nodes: TreeNode[]) {
    syncPinnedTreeNodeStateInPlace(nodes, pinnedTreeNodeIds.value, pinnedTreeNodeOrder.value, isFixedPriorityTreeNode);
  }

  function isConnectionUtilityNode(node: TreeNode): boolean {
    return node.type === "user-admin";
  }

  function connectionMetadataChildren(children: TreeNode[] | undefined): TreeNode[] {
    return (children || []).filter((child) => !isConnectionUtilityNode(child));
  }

  function hasConnectionMetadataChildren(children: TreeNode[] | undefined): boolean {
    return connectionMetadataChildren(children).length > 0;
  }

  function preserveExistingConnectionMetadataChildren(parent: TreeNode, children: TreeNode[]): TreeNode[] {
    if (parent.type !== "connection" || hasConnectionMetadataChildren(children)) return children;

    const existingMetadataChildren = connectionMetadataChildren(parent.children);
    const nextUtilityChildren = children.filter(isConnectionUtilityNode);
    if (existingMetadataChildren.length === 0 || nextUtilityChildren.length === 0) return children;

    return [...existingMetadataChildren, ...nextUtilityChildren];
  }

  // Leaf tree nodes (table columns / indexes / foreign keys / triggers) are
  // immutable data payloads: they never expand, never load children, and their
  // fields are never mutated after creation. A large schema can produce tens of
  // thousands of them, and Vue's deep reactivity wraps every node AND its nested
  // `meta` object in a Proxy — the dominant memory cost of the schema tree.
  // Marking each leaf raw keeps Vue from wrapping it (and, since Vue does not
  // recurse into raw objects, its `meta` too), mirroring the markRaw() treatment
  // queryStore already applies to result rows. Containers stay reactive so their
  // children / isExpanded / isLoading mutations still drive the UI.
  const LEAF_TREE_NODE_TYPES = new Set<TreeNode["type"]>(["column", "index", "fkey", "trigger"]);

  function markRawLeafTreeNodes(nodes: TreeNode[]): TreeNode[] {
    for (const node of nodes) {
      if (LEAF_TREE_NODE_TYPES.has(node.type)) {
        markRaw(node);
      } else if (node.children && node.children.length > 0) {
        markRawLeafTreeNodes(node.children);
      }
    }
    return nodes;
  }

  function clearDescendantLoadedChildrenMarkers(parentId: string) {
    const descendantPrefix = `${parentId}:`;
    for (const id of loadedTreeNodeChildrenIds.value) {
      if (id.startsWith(descendantPrefix)) loadedTreeNodeChildrenIds.value.delete(id);
    }
    for (const id of confirmedEmptyTreeNodeIds.value) {
      if (id.startsWith(descendantPrefix)) confirmedEmptyTreeNodeIds.value.delete(id);
    }
  }

  /** Drop loaded/confirmed-empty markers, metadata caches, and generations for a discarded shell. */
  function forgetTreeNodeLoadState(nodeId: string) {
    clearLoadedChildrenCache(nodeId);
    treeNodeLoads.invalidatePrefix(nodeId);
  }

  function syncConfirmedEmptyTreeNodeId(parent: TreeNode) {
    if (parent.type !== "database" && parent.type !== "schema") return;
    const childCount = parent.children?.length ?? 0;
    if (childCount === 0) confirmedEmptyTreeNodeIds.value.add(parent.id);
    else confirmedEmptyTreeNodeIds.value.delete(parent.id);
  }

  function sameConnectionMetadataChildIds(existing: TreeNode[] | undefined, next: TreeNode[]): boolean {
    const previousIds = new Set(connectionMetadataChildren(existing).map((child) => child.id));
    const nextIds = new Set(connectionMetadataChildren(next).map((child) => child.id));
    if (previousIds.size !== nextIds.size) return false;
    for (const id of previousIds) {
      if (!nextIds.has(id)) return false;
    }
    return true;
  }

  function directChildIdWasRemoved(existing: TreeNode[] | undefined, next: TreeNode[]): boolean {
    const nextIds = new Set(next.map((child) => child.id));
    for (const child of existing ?? []) {
      // Pagination placeholders are replaced on every page fetch, not structural removals.
      if (child.type === "load-more") continue;
      if (!nextIds.has(child.id)) return true;
    }
    return false;
  }

  function shouldClearDescendantLoadedMarkers(parent: TreeNode, nextChildren: TreeNode[]): boolean {
    if (parent.type === "connection") {
      return !sameConnectionMetadataChildIds(parent.children, nextChildren);
    }
    if (parent.type === "database" || parent.type === "schema" || objectTypesForGroupNode(parent.type)) {
      return directChildIdWasRemoved(parent.children, nextChildren);
    }
    return false;
  }

  function setChildren(parent: TreeNode, children: TreeNode[]) {
    // Compare markers against the resolved child list (after connection preserve), not the raw loader payload.
    children = preserveExistingConnectionMetadataChildren(parent, children);
    if (shouldClearDescendantLoadedMarkers(parent, children)) {
      clearDescendantLoadedChildrenMarkers(parent.id);
      // Parent load may still be current; only supersede descendant generations.
      treeNodeLoads.invalidateDescendants(parent.id);
    }
    if (parent.children && parent.children.length > 0) {
      const oldMap = new Map(parent.children.map((c) => [c.id, c] as const));
      const nextIds = new Set(children.map((child) => child.id));
      for (const [oldId, old] of oldMap) {
        // Removed children keep no loaded markers; also bump generations so in-flight
        // loads cannot apply if the same id is recreated later.
        if (!nextIds.has(oldId) && old.type !== "load-more") {
          forgetTreeNodeLoadState(oldId);
        }
      }
      children = children.map((child) => {
        const old = oldMap.get(child.id);
        if (old?.isLoading) {
          const isExpanded = old.isExpanded;
          const isLoading = old.isLoading;
          const oldChildren = old.children;
          const objectCount = child.objectCount ?? old.objectCount;
          Object.assign(old, child);
          old.isExpanded = isExpanded;
          old.isLoading = isLoading;
          old.children = oldChildren;
          old.objectCount = objectCount;
          return old;
        }
        if (old?.isExpanded) {
          return { ...child, isExpanded: true, children: old.children, objectCount: child.objectCount ?? old.objectCount };
        }
        if (old && objectTypesForGroupNode(old.type)) {
          return { ...child, objectCount: child.objectCount ?? old.objectCount };
        }
        // Same-id collapsed database/schema shell replace (e.g. DDL → force loadDatabases):
        // prior confirmed-empty markers belong to the discarded instance and must not skip
        // the next expand reload. Do not do this for tables/groups — load-more and list
        // refresh must preserve nested loaded markers (columns, etc.).
        if (old && (old.type === "database" || old.type === "schema")) {
          forgetTreeNodeLoadState(child.id);
        }
        return child;
      });
    }
    const migratedPins = migrateLegacyPinnedTreeNodeOrder(children, pinnedTreeNodeOrder.value);
    if (migratedPins.changed) {
      setPinnedTreeNodeOrder(migratedPins.order);
      persistPinnedTreeNodeIds();
    }
    syncPinnedTreeState(children);
    parent.children = markRawLeafTreeNodes(children);
    loadedTreeNodeChildrenIds.value.add(parent.id);
    syncConfirmedEmptyTreeNodeId(parent);
  }

  function removePinnedTreeNodes(nodes: readonly TreeNode[], canonicalize: PinnedTreeNodeIdentityCanonicalizer = (identity) => identity, legacyKeys: readonly string[] = []): boolean {
    const nextPinnedOrder = removePinnedTreeNodesFromOrder(pinnedTreeNodeOrder.value, nodes, canonicalize, legacyKeys);
    if (nextPinnedOrder.length === pinnedTreeNodeOrder.value.length && nextPinnedOrder.every((key, index) => key === pinnedTreeNodeOrder.value[index])) return false;
    setPinnedTreeNodeOrder(nextPinnedOrder);
    syncPinnedTreeState(treeNodes.value);
    persistPinnedTreeNodeIds();
    return true;
  }

  function replacePinnedTreeNode(oldNode: TreeNode, newNode: TreeNode, canonicalize: PinnedTreeNodeIdentityCanonicalizer = (identity) => identity, legacyKeys: readonly string[] = []): boolean {
    // Use the freshly loaded sidebar node when available so the persisted key
    // carries its real id, not the id of the pre-rename object.
    const loadedReplacement = findTreeNodes(treeNodes.value, (node) => pinnedTreeNodeIdentityMatches(treeNodePinIdentity(node), treeNodePinIdentity(newNode), canonicalize))[0];
    // A caller may provide a virtual row while the sidebar object is unloaded;
    // persisting that row id would create a pin that the sidebar cannot restore.
    const nextPinnedOrder = loadedReplacement ? replacePinnedTreeNodeInOrder(pinnedTreeNodeOrder.value, oldNode, loadedReplacement, canonicalize, legacyKeys) : removePinnedTreeNodesFromOrder(pinnedTreeNodeOrder.value, [oldNode], canonicalize, legacyKeys);
    if (nextPinnedOrder.length === pinnedTreeNodeOrder.value.length && nextPinnedOrder.every((key, index) => key === pinnedTreeNodeOrder.value[index])) return false;
    setPinnedTreeNodeOrder(nextPinnedOrder);
    syncPinnedTreeState(treeNodes.value);
    persistPinnedTreeNodeIds();
    return true;
  }

  function removeTreeNode(nodeId: string) {
    const node = findNode(treeNodes.value, nodeId);
    if (node) removePinnedTreeNodes([node]);

    const parent = findParentNode(treeNodes.value, nodeId);
    if (parent?.children) {
      parent.children = parent.children.filter((c) => c.id !== nodeId);
      // Keep the group badge in sync with remaining real children (exclude load-more).
      if (parent.objectCount != null) {
        parent.objectCount = withoutLoadMoreNodes(parent.children).length;
      }
    }
    if (parent?.hiddenChildren) {
      parent.hiddenChildren = parent.hiddenChildren.filter((child) => child.id !== nodeId);
    }
    if (selectedTreeNodeId.value === nodeId) selectedTreeNodeId.value = null;
    selectedTreeNodeIds.value = selectedTreeNodeIds.value.filter((id) => id !== nodeId);
    if (treeSelectionAnchorId.value === nodeId) treeSelectionAnchorId.value = null;
  }

  function buildUserAdminNode(connectionId: string, existingConnectionNode?: TreeNode): TreeNode | undefined {
    const config = getConfig(connectionId);
    if (!connectionSupportsDatabaseUserAdmin(config)) return undefined;
    const existing = existingConnectionNode?.children?.find((child) => child.type === "user-admin");
    return {
      id: `${connectionId}:__user_admin`,
      label: "tree.userAdmin",
      type: "user-admin",
      connectionId,
      database: "",
      isExpanded: existing?.isExpanded ?? false,
    };
  }

  function withConnectionUtilityNodes(connectionId: string, children: TreeNode[], existingConnectionNode?: TreeNode): TreeNode[] {
    const nonUtilityChildren = connectionMetadataChildren(children);
    const userAdminNode = buildUserAdminNode(connectionId, existingConnectionNode);
    return [...nonUtilityChildren, userAdminNode].filter(Boolean) as TreeNode[];
  }

  function withSavedSqlRoot(connectionId: string, children: TreeNode[], existingConnectionNode?: TreeNode): TreeNode[] {
    return withConnectionUtilityNodes(connectionId, children, existingConnectionNode);
  }

  function schemaCacheKey(...parts: string[]): string {
    return parts.map((part) => encodeURIComponent(part)).join(":");
  }

  function ownerAwareMetadataCacheVersion(_config: ConnectionConfig | undefined, version: string): string {
    return version;
  }

  // OG Developer: per-database sql_compatibility cache (datcompatibility is a
  // per-database attribute; the connection-level database_info only covers the
  // default database). Populated lazily when database nodes expand.
  const databaseCompatModes = ref(new Map<string, string>());
  const databaseCompatProbeInflight = new Set<string>();

  function databaseCompatMode(connectionId: string, database?: string, config?: ConnectionConfig): string | undefined {
    if (database) {
      const cached = databaseCompatModes.value.get(`${connectionId}|${database}`);
      if (cached) return cached;
    }
    return config?.database_info?.sqlCompatibility;
  }

  function ensureDatabaseCompatMode(connectionId: string, database: string) {
    const config = getConfig(connectionId);
    if (config?.db_type !== "opengauss" || !database) return;
    const key = `${connectionId}|${database}`;
    if (databaseCompatModes.value.has(key) || databaseCompatProbeInflight.has(key)) return;
    databaseCompatProbeInflight.add(key);
    void api
      .connectionDatabaseInfo(connectionId, database)
      .then((info) => {
        const mode = info?.sqlCompatibility?.trim().toUpperCase();
        if (mode) {
          const next = new Map(databaseCompatModes.value);
          next.set(key, mode);
          databaseCompatModes.value = next;
        }
      })
      .catch(() => undefined)
      .finally(() => databaseCompatProbeInflight.delete(key));
  }

  // Awaited variant: loadTables waits for the first probe so the object groups
  // are built with the correct mode on the very first expansion.
  async function awaitDatabaseCompatMode(connectionId: string, database: string) {
    const config = getConfig(connectionId);
    if (config?.db_type !== "opengauss" || !database) return;
    const key = `${connectionId}|${database}`;
    if (databaseCompatModes.value.has(key)) return;
    ensureDatabaseCompatMode(connectionId, database);
    // Poll briefly; probes are single tiny queries on a metadata pool.
    for (let attempt = 0; attempt < 40 && !databaseCompatModes.value.has(key); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  function supportedSidebarObjectTypes(config?: ConnectionConfig, database?: string): DatabaseObjectTreeKind[] {
    const dbType = effectiveDatabaseTypeForConnection(config);
    const compat = config?.id ? databaseCompatMode(config.id, database, config) : config?.database_info?.sqlCompatibility;
    return sidebarObjectKindsForDatabase(dbType, compat);
  }

  function sortSidebarSchemaInfos(schemas: readonly SchemaInfo[]): SchemaInfo[] {
    const byName = new Map<string, SchemaInfo>();
    for (const schema of schemas) {
      const name = schema.name.trim();
      if (!name) continue;
      byName.set(name, { name, comment: schema.comment ?? null });
    }
    return sortSidebarNames([...byName.keys()]).map((name) => byName.get(name)!);
  }

  function buildExtensionManagementNode(connectionId: string, database: string): TreeNode {
    return {
      id: `${connectionId}:${database}:__extensions`,
      label: "tree.extensions",
      type: "group-extensions",
      connectionId,
      database,
      isExpanded: false,
      children: [],
    };
  }

  function objectGroupCacheKey(node: TreeNode): string {
    const config = node.connectionId ? getConfig(node.connectionId) : undefined;
    const cacheVersion = ownerAwareMetadataCacheVersion(config, "objects-v8");
    return schemaCacheKey(node.connectionId || "", node.database || "", node.schema || "", node.type, cacheVersion);
  }

  function tableNameFilterScopeKey(parts: { connectionId?: string | null; database?: string | null; schema?: string | null; nodeKind?: string | null; catalog?: string | null }): string {
    return schemaCacheKey(parts.connectionId || "", parts.catalog || "", parts.database || "", parts.schema || "", parts.nodeKind || "group-tables");
  }

  function tableNameFilterForScope(parts: { connectionId?: string | null; database?: string | null; schema?: string | null; nodeKind?: string | null; catalog?: string | null }): TableNameFilter | undefined {
    return sidebarTableNameFilters.value[tableNameFilterScopeKey(parts)];
  }

  function activeTableNameFilterForScope(parts: { connectionId?: string | null; database?: string | null; schema?: string | null; nodeKind?: string | null; catalog?: string | null }): TableNameFilter | undefined {
    const filter = tableNameFilterForScope(parts);
    return tableNameFilterIsEmpty(filter) ? undefined : filter;
  }

  function tableNameFilterMetadataExtra(filter: TableNameFilter | undefined): MetadataScopeInput["extra"] {
    return filter
      ? {
          tableNameFilterInclude: filter.includePatterns,
          tableNameFilterExclude: filter.excludePatterns,
        }
      : undefined;
  }

  function setSidebarTableNameFilter(scopeKey: string, filter: TableNameFilter) {
    const normalized = normalizeTableNameFilter(filter);
    const next = { ...sidebarTableNameFilters.value };
    if (tableNameFilterIsEmpty(normalized)) delete next[scopeKey];
    else next[scopeKey] = normalized;
    sidebarTableNameFilters.value = next;
    saveSidebarTableNameFilters(next);
    const revision = (sidebarTableNameFilterRevisions.get(scopeKey) ?? 0) + 1;
    sidebarTableNameFilterRevisions.set(scopeKey, revision);
    return revision;
  }

  function removeSidebarTableNameFiltersForConnections(connectionIds: Iterable<string>) {
    const encodedPrefixes = [...connectionIds].map((connectionId) => `${encodeURIComponent(connectionId)}:`);
    if (encodedPrefixes.length === 0) return;
    let changed = false;
    const next = { ...sidebarTableNameFilters.value };
    for (const key of Object.keys(next)) {
      if (!encodedPrefixes.some((prefix) => key.startsWith(prefix))) continue;
      delete next[key];
      sidebarTableNameFilterRevisions.delete(key);
      changed = true;
    }
    if (!changed) return;
    sidebarTableNameFilters.value = next;
    saveSidebarTableNameFilters(next);
  }

  function tableNameFilterRevisionMatches(options?: LoadTreeOptions): boolean {
    if (!options?.tableNameFilterScopeKey) return true;
    return (sidebarTableNameFilterRevisions.get(options.tableNameFilterScopeKey) ?? 0) === options.expectedTableNameFilterRevision;
  }

  function listTablesWithOptionalTableNameFilter(connectionId: string, database: string, schema: string, filter?: string, limit?: number, offset?: number, objectTypes?: DatabaseObjectTreeKind[], catalog?: string, tableNameFilter?: TableNameFilter) {
    if (tableNameFilter) return api.listTables(connectionId, database, schema, filter, limit, offset, objectTypes, catalog, tableNameFilter);
    if (catalog) return api.listTables(connectionId, database, schema, filter, limit, offset, objectTypes, catalog);
    if (objectTypes) return api.listTables(connectionId, database, schema, filter, limit, offset, objectTypes);
    return api.listTables(connectionId, database, schema, filter, limit, offset);
  }

  function metadataListDriverProfile(connectionId?: string): string | undefined {
    return connectionId ? metadataDriverProfile(getConfig(connectionId)) : undefined;
  }

  function metadataListCacheScope(options: {
    kind: string;
    connectionId?: string | null;
    database?: string | null;
    schema?: string | null;
    nodeKind?: string | null;
    objectTypes?: readonly string[] | null;
    searchFilter?: string | null;
    limit?: number | null;
    offset?: number | null;
    sidebarDisplayMode?: string | null;
    extra?: MetadataScopeInput["extra"];
  }): MetadataScopeInput {
    return {
      kind: options.kind,
      connectionId: options.connectionId,
      database: options.database,
      schema: options.schema,
      nodeKind: options.nodeKind,
      objectTypes: options.objectTypes,
      searchFilter: options.searchFilter,
      limit: options.limit,
      offset: options.offset,
      sidebarDisplayMode: options.sidebarDisplayMode,
      driverProfile: metadataListDriverProfile(options.connectionId || undefined),
      extra: options.extra,
    };
  }

  function invalidateMetadataCaches(match: MetadataCacheInvalidation): number {
    return metadataListPageCache.invalidate(match) + invalidateTableMetadataCache(match) + invalidateObjectBrowserRowsCache(match);
  }

  function invalidateMetadataCachesByTreePrefix(prefix: string) {
    const [connectionId, database, schema, tableName] = prefix.split(":").map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
    if (!connectionId) return;
    invalidateMetadataCaches({
      connectionId,
      database: database || undefined,
      schema: schema || undefined,
      tableName: tableName && !tableName.startsWith("__") ? tableName : undefined,
    });
  }

  function invalidateMetadataCachesForNode(node: TreeNode) {
    if (!node.connectionId) return;
    const tableName = node.tableName || (node.type === "table" || node.type === "view" || node.type === "materialized_view" ? node.label : undefined);
    const match = {
      connectionId: node.connectionId,
      database: node.database || undefined,
      schema: node.schema || undefined,
      tableName,
    };
    invalidateMetadataCaches(match);
    void invalidateObjectDdlCache(match);
  }

  function invalidateMetadataCache(connectionId: string, database?: string, schema?: string, tableName?: string) {
    const match = { connectionId, database, schema, tableName };
    invalidateMetadataCaches(match);
    void invalidateObjectDdlCache(match);
  }

  function buildLoadMoreNode(parent: TreeNode, offset: number, pageSize: number): TreeNode {
    return {
      id: `${parent.id}:__load_more:${offset}`,
      label: "tree.loadMore",
      type: "load-more",
      connectionId: parent.connectionId,
      database: parent.database,
      schema: parent.schema,
      isLoading: false,
      loadMore: {
        parentId: parent.id,
        offset,
        pageSize,
      },
    };
  }

  function withoutLoadMoreNodes(children: TreeNode[] | undefined): TreeNode[] {
    return (children || []).filter((child) => child.type !== "load-more");
  }

  function objectGroupChildrenFromObjects(options: { node: TreeNode; parentNodeId: string; effectiveSchema?: string; objectTypes: DatabaseObjectTreeKind[]; objects: ObjectInfo[] }): TreeNode[] {
    const grouped = buildGroupedObjectTreeNodes({
      nodeId: options.parentNodeId,
      connectionId: options.node.connectionId || "",
      database: options.node.database || "",
      schema: options.effectiveSchema,
      objects: options.objects.filter((object) => options.objectTypes.includes(normalizedObjectTreeKind(object.object_type))),
    });
    const refreshedGroup = grouped.find((group) => group.type === options.node.type);
    return refreshedGroup?.children ?? [];
  }

  function tableInfosToCompletionTables(tables: readonly TableInfo[], schema?: string): SqlCompletionTable[] {
    return tables.map((table) => ({
      name: table.name,
      schema,
      type: sqlObjectNavigationTypeFromTableType(table.table_type),
    }));
  }

  function sameSidebarObjectName(left: string | undefined, right: string | undefined): boolean {
    return (left || "").toLowerCase() === (right || "").toLowerCase();
  }

  function treeNodeObjectIdentity(node: TreeNode): string {
    return `${node.type}\0${node.schema || ""}\0${node.label}`;
  }

  function mergeLocatedTreeChildren(parent: TreeNode, currentChildren: TreeNode[], pageChildren: TreeNode[], connectionId: string, database: string): TreeNode[] {
    const tableChildren = pageChildren.filter((child) => child.type === "table");
    const nonTableChildren = pageChildren.filter((child) => child.type !== "table");
    let merged = tableChildren.length ? mergeTableTreePageChildren(currentChildren, tableChildren, connectionId, database) : [...currentChildren];
    const existing = new Set(merged.map(treeNodeObjectIdentity));
    for (const child of nonTableChildren) {
      const key = treeNodeObjectIdentity(child);
      if (existing.has(key)) continue;
      merged.push(child);
      existing.add(key);
    }
    const config = parent.connectionId ? getConfig(parent.connectionId) : undefined;
    return sortSidebarTreeChildrenForParent(
      parent,
      sortDatabaseObjectsByName(merged, (node) => node.label),
      config?.db_type,
    );
  }

  function findTreeNodes(nodes: TreeNode[], predicate: (node: TreeNode) => boolean): TreeNode[] {
    const matches: TreeNode[] = [];
    for (const node of nodes) {
      if (predicate(node)) matches.push(node);
      if (node.children) matches.push(...findTreeNodes(node.children, predicate));
      const hiddenOnlyChildren = node.hiddenChildren?.filter((child) => !(node.children || []).includes(child));
      if (hiddenOnlyChildren?.length) matches.push(...findTreeNodes(hiddenOnlyChildren, predicate));
    }
    return matches;
  }

  async function loadPagedTableGroupChildren(options: {
    node: TreeNode;
    parentNodeId: string;
    querySchema: string;
    effectiveSchema?: string;
    objectTypes: DatabaseObjectTreeKind[];
    offset: number;
    pageSize: number;
    searchFilter?: string;
    force?: boolean;
  }): Promise<{ children: TreeNode[]; objectCount: number; hasMore: boolean; nextOffset: number; loadMoreParent?: TableTreeLoadMoreParent }> {
    if (!options.node.connectionId || options.node.database == null) {
      return { children: [], objectCount: 0, hasMore: false, nextOffset: options.offset };
    }
    const searchFilter = (options.searchFilter ?? sidebarSearchQuery.value) || undefined;
    const tableNameFilter = activeTableNameFilterForScope({
      connectionId: options.node.connectionId,
      database: options.node.database,
      schema: options.node.schema,
      nodeKind: options.node.type,
      catalog: options.node.catalog,
    });
    const fetchLimit = searchFilter ? options.pageSize : options.pageSize + 1;
    const fetchOffset = searchFilter ? undefined : options.offset;
    const tables = await loadCachedMetadataListPage<TableInfo[]>(
      metadataListCacheScope({
        kind: "table-list-page",
        connectionId: options.node.connectionId,
        database: options.node.database,
        schema: options.querySchema,
        nodeKind: options.node.type,
        objectTypes: options.objectTypes,
        searchFilter,
        limit: fetchLimit,
        offset: fetchOffset,
        sidebarDisplayMode: "grouped",
        extra: tableNameFilterMetadataExtra(tableNameFilter),
      }),
      () => listTablesWithOptionalTableNameFilter(options.node.connectionId!, options.node.database!, options.querySchema, searchFilter, fetchLimit, fetchOffset, options.objectTypes, options.node.catalog, tableNameFilter),
      { force: options.force },
    );
    const hasMore = searchFilter ? false : tables.length > options.pageSize;
    const pageTables = hasMore ? tables.slice(0, options.pageSize) : tables;
    indexCompletionTables(options.node.connectionId, options.node.database, options.effectiveSchema, tableInfosToCompletionTables(pageTables, options.effectiveSchema));
    const objects = mergeTableInfosIntoObjects([], pageTables, options.effectiveSchema);
    const children = objectGroupChildrenFromObjects({
      node: options.node,
      parentNodeId: options.parentNodeId,
      effectiveSchema: options.effectiveSchema,
      objectTypes: options.objectTypes,
      objects,
    });
    const lastTable = pageTables[pageTables.length - 1];
    return {
      children,
      objectCount: children.length,
      hasMore,
      nextOffset: options.offset + pageTables.length,
      loadMoreParent: lastTable?.parent_name ? { schema: lastTable.parent_schema, name: lastTable.parent_name } : undefined,
    };
  }

  async function loadPagedObjectGroupChildren(options: {
    node: TreeNode;
    parentNodeId: string;
    querySchema: string;
    effectiveSchema?: string;
    objectTypes: DatabaseObjectTreeKind[];
    offset: number;
    pageSize: number;
    searchFilter?: string;
    force?: boolean;
  }): Promise<{ children: TreeNode[]; objectCount: number; hasMore: boolean; nextOffset: number }> {
    if (!options.node.connectionId || options.node.database == null) {
      return { children: [], objectCount: 0, hasMore: false, nextOffset: options.offset };
    }
    const searchFilter = options.searchFilter || undefined;
    const fetchLimit = searchFilter ? undefined : options.pageSize + 1;
    const fetchOffset = searchFilter ? undefined : options.offset;
    const objects = await loadCachedMetadataListPage<ObjectInfo[]>(
      metadataListCacheScope({
        kind: "object-list-page",
        connectionId: options.node.connectionId,
        database: options.node.database,
        schema: options.querySchema,
        nodeKind: options.node.type,
        objectTypes: options.objectTypes,
        searchFilter,
        limit: fetchLimit,
        offset: fetchOffset,
        sidebarDisplayMode: useSettingsStore().editorSettings.sidebarObjectDisplay,
      }),
      () => api.listObjects(options.node.connectionId!, options.node.database!, options.querySchema, options.objectTypes, searchFilter, fetchLimit, fetchOffset),
      { force: options.force },
    );
    const hasMore = searchFilter ? false : objects.length > options.pageSize;
    const pageObjects = hasMore ? objects.slice(0, options.pageSize) : objects;
    const children = objectGroupChildrenFromObjects({
      node: options.node,
      parentNodeId: options.parentNodeId,
      effectiveSchema: options.effectiveSchema,
      objectTypes: options.objectTypes,
      objects: pageObjects,
    });
    return {
      children,
      objectCount: children.length,
      hasMore,
      nextOffset: options.offset + pageObjects.length,
    };
  }

  async function loadPagedSimpleTableChildren(options: {
    nodeId: string;
    connectionId: string;
    database: string;
    querySchema: string;
    effectiveSchema?: string;
    nonTableObjectTypes: DatabaseObjectTreeKind[];
    offset: number;
    pageSize: number;
    searchFilter?: string;
    force?: boolean;
  }): Promise<{ children: TreeNode[]; objectCount: number; hasMore: boolean; nextOffset: number; loadMoreParent?: TableTreeLoadMoreParent }> {
    const searchFilter = (options.searchFilter ?? sidebarSearchQuery.value) || undefined;
    const tableNameFilter = activeTableNameFilterForScope({
      connectionId: options.connectionId,
      database: options.database,
      schema: options.effectiveSchema ?? options.querySchema,
      nodeKind: "simple-tables",
    });
    const fetchLimit = searchFilter ? options.pageSize : options.pageSize + 1;
    const fetchOffset = searchFilter ? undefined : options.offset;
    const tables = await loadCachedMetadataListPage<TableInfo[]>(
      metadataListCacheScope({
        kind: "table-list-page",
        connectionId: options.connectionId,
        database: options.database,
        schema: options.querySchema,
        nodeKind: "simple-tables",
        searchFilter,
        limit: fetchLimit,
        offset: fetchOffset,
        sidebarDisplayMode: "simple",
        extra: tableNameFilterMetadataExtra(tableNameFilter),
      }),
      () => listTablesWithOptionalTableNameFilter(options.connectionId, options.database, options.querySchema, searchFilter, fetchLimit, fetchOffset, undefined, undefined, tableNameFilter),
      { force: options.force },
    );
    const hasMore = searchFilter ? false : tables.length > options.pageSize;
    const pageTables = hasMore ? tables.slice(0, options.pageSize) : tables;
    indexCompletionTables(options.connectionId, options.database, options.effectiveSchema, tableInfosToCompletionTables(pageTables, options.effectiveSchema));

    const children = buildTableTreeNodes({
      nodeId: options.nodeId,
      connectionId: options.connectionId,
      database: options.database,
      schema: options.effectiveSchema,
      tables: pageTables,
    });
    const lastTable = pageTables[pageTables.length - 1];
    return {
      children,
      objectCount: children.length,
      hasMore,
      nextOffset: options.offset + pageTables.length,
      loadMoreParent: lastTable?.parent_name ? { schema: lastTable.parent_schema, name: lastTable.parent_name } : undefined,
    };
  }

  async function loadSimpleSupplementalObjectChildren(options: {
    node: TreeNode;
    nodeId: string;
    connectionId: string;
    database: string;
    querySchema: string;
    effectiveSchema?: string;
    objectTypes: DatabaseObjectTreeKind[];
    cacheKey: string;
    loadOptions?: LoadTreeOptions;
    load: TreeNodeLoadHandle;
  }) {
    if (options.objectTypes.length === 0) return;
    const searchFilter = activeTreeLoadSearchFilter(options.loadOptions);
    if (searchFilter) return;

    try {
      const objects = await loadCachedMetadataListPage<ObjectInfo[]>(
        metadataListCacheScope({
          kind: "object-list-page",
          connectionId: options.connectionId,
          database: options.database,
          schema: options.querySchema,
          nodeKind: "simple-supplemental",
          objectTypes: options.objectTypes,
          sidebarDisplayMode: "simple",
        }),
        () => api.listObjects(options.connectionId, options.database, options.querySchema, options.objectTypes),
        { force: options.loadOptions?.force },
      );
      const supplementalObjects = filterSimpleSidebarSupplementalObjects(objects);
      if (supplementalObjects.length === 0) return;
      const supplementalChildren = buildSimpleObjectTreeNodes({
        nodeId: options.nodeId,
        connectionId: options.connectionId,
        database: options.database,
        schema: options.effectiveSchema,
        objects: supplementalObjects,
      });
      if (supplementalChildren.length === 0) return;
      if (isTreeLoadSearchChanged(searchFilter, options.loadOptions)) return;
      const targetNode = treeNodeLoadTarget(options.load);
      if (!targetNode) return;

      const loadMoreNodes = (targetNode.children || []).filter((child) => child.type === "load-more");
      const currentChildren = withoutLoadMoreNodes(targetNode.children);
      const mergedChildren = mergeLocatedTreeChildren(targetNode, currentChildren, supplementalChildren, options.connectionId, options.database);
      const nextChildren = [...mergedChildren, ...loadMoreNodes];
      setChildren(targetNode, nextChildren);
      await savePersistedTreeChildren(options.cacheKey, nextChildren);
    } catch (error) {
      // Some drivers only expose table metadata; keep the already-rendered table tree usable.
      console.debug("[ogdeveloper][metadata:simple-supplemental:error]", {
        connectionId: options.connectionId,
        database: options.database,
        schema: options.effectiveSchema,
        error,
      });
    }
  }

  function refreshStaleTreeNode(node: TreeNode) {
    const searchFilter = sidebarSearchQuery.value || "";
    if (searchFilter) return;
    const liveNode = treeNodeInSidebarTree(node);
    if (!liveNode) return;
    if (staleTreeRefreshIds.has(liveNode.id)) return;
    staleTreeRefreshIds.add(liveNode.id);
    const expandedIds = collectExpandedNodeIds([liveNode]);
    clearLoadedChildrenCache(liveNode.id);
    const refreshOptions = { force: true, expectedSidebarSearchQuery: searchFilter };
    void loadTreeNodeChildren(liveNode, refreshOptions)
      .then(() => {
        if ((sidebarSearchQuery.value || "") !== searchFilter) return;
        return restoreExpandedChildren(liveNode, expandedIds, refreshOptions);
      })
      .finally(() => staleTreeRefreshIds.delete(liveNode.id));
  }

  async function loadPersistedTreeChildren(node: TreeNode, cacheKey: string, load: TreeNodeLoadHandle): Promise<PersistedTreeChildrenLoadResult> {
    const trace = createMetadataLoadTrace({
      kind: "persisted-tree-cache",
      connectionId: node.connectionId,
      database: node.database,
      schema: node.schema,
      nodeKind: node.type,
      extra: { cacheKey },
    });
    const payload = await api.loadSchemaCache<unknown>(cacheKey).catch(() => null);
    const decoded = decodeSchemaTreeCache<TreeNode[]>(payload);
    if (!decoded) {
      logMetadataLoadTrace(metadataTraceLogger, trace, "cache-miss", { cacheStatus: "miss" });
      return { hit: false, isStale: false };
    }
    const config = node.connectionId ? getConfig(node.connectionId) : undefined;
    const cachedChildren = normalizeCataloglessDatabaseNodes(expandCachedObjectBrowserNodes(decoded.children));
    if (node.type === "connection" && !hasConnectionMetadataChildren(cachedChildren)) {
      logMetadataLoadTrace(metadataTraceLogger, trace, "cache-miss", { cacheStatus: "miss", resultCount: 0 });
      return { hit: false, isStale: false };
    }
    // Gate cache apply on the same per-node generation as network apply — connection
    // revision alone is not enough when a newer force-load supersedes this handle.
    const targetNode = treeNodeLoadTarget(load);
    if (!targetNode) {
      logMetadataLoadTrace(metadataTraceLogger, trace, "cache-miss", { cacheStatus: "miss" });
      return { hit: false, isStale: false };
    }
    const normalizedChildren = sortSidebarTreeChildrenForParent(targetNode, cachedChildren, config?.db_type);
    setChildren(targetNode, targetNode.type === "connection" && targetNode.connectionId ? withSavedSqlRoot(targetNode.connectionId, normalizedChildren, targetNode) : normalizedChildren);
    targetNode.isExpanded = true;
    logMetadataLoadTrace(metadataTraceLogger, trace, "cache-hit", {
      cacheStatus: decoded.isStale ? "stale" : "hit",
      resultCount: normalizedChildren.length,
      stale: decoded.isStale,
    });
    return { hit: true, isStale: decoded.isStale };
  }

  async function savePersistedTreeChildren(cacheKey: string, children: TreeNode[]) {
    await api.saveSchemaCache(cacheKey, encodeSchemaTreeCache(children)).catch(() => undefined);
  }

  function sidebarTableSearchTreeCacheKey(parent: TreeNode): string | null {
    if (!parent.connectionId || !parent.database) return null;
    if (parent.type === "group-tables") return objectGroupCacheKey(parent);
    if (parent.type !== "database" && parent.type !== "schema") return null;
    const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
    const cacheVersion = ownerAwareMetadataCacheVersion(getConfig(parent.connectionId), simpleObjectDisplay ? "objects-simple-v8" : "objects-grouped-v9");
    return schemaCacheKey(parent.connectionId, parent.database, parent.schema || "", cacheVersion);
  }

  function sidebarTableSearchIndexCacheKey(parent: TreeNode): string | null {
    const treeCacheKey = sidebarTableSearchTreeCacheKey(parent);
    return treeCacheKey ? `${treeCacheKey}:table-search-index-v1` : null;
  }

  async function loadSidebarTableSearchIndex(parentNodeId: string): Promise<TableInfo[] | null> {
    const parent = findNode(treeNodes.value, parentNodeId);
    if (!parent) return null;
    const cacheKey = sidebarTableSearchIndexCacheKey(parent);
    if (!cacheKey) return null;
    const decoded = decodeSchemaTreeCache<TreeNode[]>(await api.loadSchemaCache<unknown>(cacheKey).catch(() => null));
    const index = decoded?.tableSearchIndex;
    if (!index) return null;
    return index.entries.map((entry) => ({ name: entry.name, table_type: entry.tableType }));
  }

  async function refreshSidebarTableSearchIndex(parentNodeId: string): Promise<TableInfo[]> {
    const parent = findNode(treeNodes.value, parentNodeId);
    if (!parent?.connectionId || !hasTreeNodeDatabaseContext(parent)) return [];
    const cacheKey = sidebarTableSearchIndexCacheKey(parent);
    if (!cacheKey) return [];
    await ensureConnected(parent.connectionId);
    const config = getConfig(parent.connectionId);
    const querySchema = connectionObjectTreeQuerySchema(config, parent.database, parent.schema);
    const objectTypes = parent.type === "group-tables" ? (objectTypesForGroupNode(parent.type) ?? undefined) : undefined;
    const pageSize = sidebarObjectGroupPageSize();
    const entries: TableInfo[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await listTablesWithOptionalTableNameFilter(parent.connectionId, parent.database, querySchema, undefined, pageSize, offset, objectTypes, parent.catalog);
      entries.push(...page);
      if (page.length < pageSize) break;
    }
    const deduped = [...new Map(entries.map((entry) => [`${entry.table_type}\0${entry.name}`, entry])).values()];
    const tableSearchIndex = { complete: true as const, indexedAt: new Date().toISOString(), entries: deduped.map((entry) => ({ name: entry.name, tableType: entry.table_type })) };
    await api.saveSchemaCache(cacheKey, encodeSchemaTreeCache<TreeNode[]>([], Date.now(), tableSearchIndex));
    return deduped;
  }

  async function savePersistedConnectionTreeChildren(cacheKey: string, children: TreeNode[]) {
    const metadataChildren = connectionMetadataChildren(children);
    if (metadataChildren.length === 0) return;
    await savePersistedTreeChildren(cacheKey, metadataChildren);
  }

  function connectionRootCacheKey(connectionId: string, config: ConnectionConfig | undefined): string | null {
    if (!config) return null;
    if (connectionUsesVisibleSchemaFilter(config)) {
      return schemaCacheKey(connectionId, config.database || "", "schemas", config.show_system_schemas === true ? "show-system" : "hide-system");
    }
    return schemaCacheKey(connectionId, "databases-v2");
  }

  async function hydrateTreeNodeFromCache(node: TreeNode | null, cacheKey: string | null): Promise<boolean> {
    if (!node || !cacheKey || loadedTreeNodeChildrenIds.value.has(node.id)) return false;
    const load = beginTreeNodeLoad(node);
    try {
      return (await loadPersistedTreeChildren(node, cacheKey, load)).hit;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function hydrateConnectionRootFromCache(connectionId: string, config: ConnectionConfig | undefined): Promise<boolean> {
    return hydrateTreeNodeFromCache(findConnectionNode(connectionId), connectionRootCacheKey(connectionId, config));
  }

  function isTreeNodeLoadedChildrenUsable(node: TreeNode): boolean {
    const sidebarObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay;
    if (!treeNodeLoadedChildrenContentPresent(node, sidebarObjectDisplay)) return false;
    if (simpleModeEmptyShellNeedsConfirmedLoad(node, sidebarObjectDisplay) && !confirmedEmptyTreeNodeIds.value.has(node.id)) {
      return false;
    }
    return true;
  }

  function canUseLoadedTreeNodeToggle(node: TreeNode): boolean {
    return loadedTreeNodeChildrenIds.value.has(node.id) && isTreeNodeLoadedChildrenUsable(node);
  }

  function useCachedChildren(node: TreeNode, options: LoadTreeOptions | undefined, load: TreeNodeLoadHandle): boolean {
    if (options?.force || !loadedTreeNodeChildrenIds.value.has(node.id)) return false;
    if (!load.isCurrent()) return false;
    if (node.type === "connection" && node.connectionId) {
      if (!hasConnectionMetadataChildren(node.children)) {
        clearLoadedChildrenCache(node.id);
        return false;
      }
      const normalizedChildren = sortSidebarTreeChildrenForParent(node, withSavedSqlRoot(node.connectionId, node.children || [], node), getConfig(node.connectionId)?.db_type);
      const liveNode = treeNodeLoadTarget(load);
      if (!liveNode) return false;
      setChildren(liveNode, normalizedChildren);
      liveNode.isExpanded = true;
    } else if (!isTreeNodeLoadedChildrenUsable(node)) {
      clearLoadedChildrenCache(node.id);
      return false;
    }
    const liveNode = treeNodeLoadTarget(load);
    if (!liveNode) return false;
    liveNode.isExpanded = true;
    return true;
  }

  function isSidebarSearchQueryChanged(options?: LoadTreeOptions) {
    return options?.expectedSidebarSearchQuery !== undefined && (sidebarSearchQuery.value || "") !== options.expectedSidebarSearchQuery;
  }

  function isSidebarTableSearchQueryChanged(options?: LoadTreeOptions) {
    if (!options?.sidebarTableSearchParentId || options.expectedSidebarTableSearchQuery === undefined) return false;
    return (sidebarTableSearchQueries.value[options.sidebarTableSearchParentId]?.trim() || "") !== options.expectedSidebarTableSearchQuery;
  }

  function activeTreeLoadSearchFilter(options?: LoadTreeOptions): string {
    return (options?.searchFilter ?? sidebarSearchQuery.value) || "";
  }

  function isTreeLoadSearchChanged(searchFilter: string, options?: LoadTreeOptions): boolean {
    if (options?.sidebarTableSearchParentId) return isSidebarTableSearchQueryChanged(options);
    return (sidebarSearchQuery.value || "") !== searchFilter || isSidebarSearchQueryChanged(options);
  }

  function isTreeNodeChildrenLoaded(nodeId: string): boolean {
    return loadedTreeNodeChildrenIds.value.has(nodeId);
  }

  // Collapsing a node only hides it — its loaded children stay in memory, so a
  // long browsing session accumulates every schema the user ever expanded and
  // the webview creeps upward. When a *large* subtree is collapsed we drop its
  // children so the memory is reclaimed; re-expanding reloads them (fast, from
  // the schema cache). Small subtrees are kept so routine expand/collapse stays
  // instant and never triggers a reload.
  const RELEASE_COLLAPSED_SUBTREE_MIN_DESCENDANTS = 400;

  function countTreeNodeDescendants(node: TreeNode, cap: number): number {
    let count = 0;
    const stack: TreeNode[] = [...(node.children ?? [])];
    while (stack.length) {
      const current = stack.pop()!;
      count += 1;
      if (count >= cap) return count;
      if (current.children?.length) stack.push(...current.children);
    }
    return count;
  }

  function forgetLoadedChildrenIdsForSubtree(node: TreeNode) {
    loadedTreeNodeChildrenIds.value.delete(node.id);
    confirmedEmptyTreeNodeIds.value.delete(node.id);
    for (const child of node.children ?? []) {
      forgetLoadedChildrenIdsForSubtree(child);
    }
  }

  // Returns true when the collapsed node's children were released. Caller should
  // have already set node.isExpanded = false. Re-expanding reloads on demand
  // because the node id is removed from loadedTreeNodeChildrenIds.
  function releaseCollapsedTreeNodeChildren(nodeId: string): boolean {
    const node = findNode(treeNodes.value, nodeId);
    if (!node?.children?.length) return false;
    if (countTreeNodeDescendants(node, RELEASE_COLLAPSED_SUBTREE_MIN_DESCENDANTS) < RELEASE_COLLAPSED_SUBTREE_MIN_DESCENDANTS) {
      return false;
    }
    forgetLoadedChildrenIdsForSubtree(node);
    node.children = [];
    return true;
  }

  function treeNodeInSidebarTree(node: TreeNode): TreeNode | null {
    return findNode(treeNodes.value, node.id);
  }

  function beginTreeNodeLoad(node: TreeNode): TreeNodeLoadHandle {
    return treeNodeLoads.begin(node);
  }

  function reclaimTreeNodeLoad(load: TreeNodeLoadHandle, node: TreeNode): TreeNodeLoadHandle {
    return load.reclaim(treeNodeInSidebarTree(node) ?? node);
  }

  function treeNodeLoadTarget(load: TreeNodeLoadHandle): TreeNode | null {
    return load.targetNode(
      (nodeId) => findNode(treeNodes.value, nodeId),
      (connectionId) => connectedIds.value.has(connectionId),
    ) as TreeNode | null;
  }

  function finishTreeNodeLoad(load: TreeNodeLoadHandle) {
    load.finish((nodeId) => findNode(treeNodes.value, nodeId));
  }

  /** Apply to a related node only while this load handle is still current. */
  function treeNodeLoadRelatedTarget(load: TreeNodeLoadHandle, related: TreeNode): TreeNode | null {
    if (!load.isCurrent()) return null;
    const current = treeNodeInSidebarTree(related);
    if (!current) return null;
    if (current.connectionId && !connectedIds.value.has(current.connectionId)) return null;
    return current;
  }

  function clearLoadedChildrenCache(prefix: string, options?: { deletePersisted?: boolean }) {
    for (const id of loadedTreeNodeChildrenIds.value) {
      if (id === prefix || id.startsWith(`${prefix}:`)) {
        loadedTreeNodeChildrenIds.value.delete(id);
      }
    }
    for (const id of confirmedEmptyTreeNodeIds.value) {
      if (id === prefix || id.startsWith(`${prefix}:`)) {
        confirmedEmptyTreeNodeIds.value.delete(id);
      }
    }
    invalidateMetadataCachesByTreePrefix(prefix);
    if (options?.deletePersisted === false) return;
    const rawPrefix = `${prefix}:`;
    const encodedPrefix = `${schemaCacheKey(prefix)}:`;
    if (rawPrefix === encodedPrefix) {
      api.deleteSchemaCachePrefix(rawPrefix).catch(() => undefined);
    } else {
      Promise.all([api.deleteSchemaCachePrefix(rawPrefix), api.deleteSchemaCachePrefix(encodedPrefix)]).catch(() => undefined);
    }
  }

  function schemaCachePrefixForNode(node: TreeNode): string | null {
    return treeNodeSchemaCachePrefix(node);
  }

  async function clearPersistedTreeCacheForNode(node: TreeNode) {
    const prefix = schemaCachePrefixForNode(node);
    if (!prefix) return;
    await api.deleteSchemaCachePrefix(prefix).catch(() => undefined);
  }

  function findParentNode(nodes: TreeNode[], id: string, parent: TreeNode | null = null): TreeNode | null {
    for (const node of nodes) {
      if (node.id === id) return parent;
      if (node.children) {
        const found = findParentNode(node.children, id, node);
        if (found) return found;
      }
    }
    return null;
  }

  function toggleTreeNodePin(node: TreeNode) {
    const pinKey = treeNodePinKey(node);
    const wasPinned = pinnedTreeNodeIds.value.has(pinKey) || pinnedTreeNodeIds.value.has(node.id);
    // Remove the legacy bare id as part of every toggle so old ambiguous pins
    // cannot continue matching objects in a different database. Newly pinned
    // nodes append to the persisted order, placing them last in their sibling
    // pin section until the user explicitly reorders them.
    const next = pinnedTreeNodeOrder.value.filter((id) => id !== node.id && id !== pinKey);
    if (!wasPinned) next.push(pinKey);
    setPinnedTreeNodeOrder(next);
    persistPinnedTreeNodeIds();

    // Pinning is infrequent; synchronizing the loaded tree here also clears any
    // stale flags created by legacy unscoped ids without rebuilding metadata.
    syncPinnedTreeState(treeNodes.value);
  }

  function findPinnedTreeNodeLocation(nodes: TreeNode[], pinKey: string): { node: TreeNode; siblings: TreeNode[] } | null {
    for (const node of nodes) {
      if (treeNodePinKey(node) === pinKey) return { node, siblings: nodes };
      if (node.children) {
        const found = findPinnedTreeNodeLocation(node.children, pinKey);
        if (found) return found;
      }
      if (node.hiddenChildren) {
        const found = findPinnedTreeNodeLocation(node.hiddenChildren, pinKey);
        if (found) return found;
      }
    }
    return null;
  }

  function collectPinnedTreeNodeReorderTargets(draggedKey: string): Set<string> {
    const dragged = findPinnedTreeNodeLocation(treeNodes.value, draggedKey);
    if (!dragged || !isTreeNodePinned(dragged.node) || isFixedPriorityTreeNode(dragged.node)) return new Set();

    const targets = new Set<string>();
    for (const sibling of dragged.siblings) {
      const siblingKey = treeNodePinKey(sibling);
      if (siblingKey === draggedKey || !isTreeNodePinned(sibling) || isFixedPriorityTreeNode(sibling)) continue;
      targets.add(siblingKey);
    }
    return targets;
  }

  const activePinnedTreeNodeReorderTargets = computed(() => {
    const draggedKey = activePinnedTreeNodeReorderKey.value;
    return draggedKey ? collectPinnedTreeNodeReorderTargets(draggedKey) : new Set<string>();
  });

  function beginPinnedTreeNodeReorder(draggedKey: string) {
    activePinnedTreeNodeReorderKey.value = draggedKey || null;
  }

  function endPinnedTreeNodeReorder() {
    activePinnedTreeNodeReorderKey.value = null;
  }

  function isPinnedTreeNodeReorderTarget(targetKey: string): boolean {
    return !!targetKey && targetKey !== activePinnedTreeNodeReorderKey.value && activePinnedTreeNodeReorderTargets.value.has(targetKey);
  }

  function canReorderPinnedTreeNodes(draggedKey: string, targetKey: string): boolean {
    if (!draggedKey || !targetKey || draggedKey === targetKey) return false;
    if (activePinnedTreeNodeReorderKey.value === draggedKey) return activePinnedTreeNodeReorderTargets.value.has(targetKey);
    return collectPinnedTreeNodeReorderTargets(draggedKey).has(targetKey);
  }

  function reorderPinnedTreeNodes(draggedKey: string, targetKey: string, position: DropPosition): boolean {
    if (position === "inside" || !canReorderPinnedTreeNodes(draggedKey, targetKey)) return false;
    const next = reorderPinnedTreeNodeOrder(pinnedTreeNodeOrder.value, draggedKey, targetKey, position);
    if (next.length === pinnedTreeNodeOrder.value.length && next.every((key, index) => key === pinnedTreeNodeOrder.value[index])) return false;
    setPinnedTreeNodeOrder(next);
    syncPinnedTreeState(treeNodes.value);
    persistPinnedTreeNodeIds();
    return true;
  }

  async function addConnection(config: ConnectionConfig, targetGroupId?: string | null) {
    const normalized = normalizeConnection(config);
    const existing = connections.value.findIndex((c) => c.id === normalized.id);
    const nextConnections = [...connections.value];
    if (existing >= 0) {
      nextConnections[existing] = normalized;
    } else {
      nextConnections.push(normalized);
      const groupId = targetGroupId !== undefined ? targetGroupId : newConnectionGroupId.value;
      sidebarLayout.value = appendConnectionToLayout(sidebarLayout.value, normalized.id, groupId);
    }
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    rebuildTreeNodes();
    persistSidebarLayoutDebounced();
    stopCreatingConnectionInGroup();
  }

  function copyConnectionsToTreeClipboard(connectionIds: Iterable<string>): number {
    const seen = new Set<string>();
    const entries: TreeClipboardConnectionEntry[] = [];
    for (const connectionId of connectionIds) {
      if (seen.has(connectionId)) continue;
      seen.add(connectionId);
      const config = getConfig(connectionId);
      if (!config) continue;
      entries.push({
        config: { ...config },
        sourceGroupId: findConnectionLocation(sidebarLayout.value, connectionId)?.groupId ?? null,
      });
    }
    if (!entries.length) return 0;
    treeClipboard.value = { kind: "connection-copy", connections: entries };
    return entries.length;
  }

  async function pasteConnectionClipboard(targetGroupId?: string | null): Promise<number> {
    const clipboard = treeClipboard.value;
    if (clipboard?.kind !== "connection-copy" || clipboard.connections.length === 0) return 0;

    let pastedCount = 0;
    for (const entry of clipboard.connections) {
      await addConnection(
        {
          ...entry.config,
          id: uuid(),
          name: `${entry.config.name} (Copy)`,
        },
        targetGroupId === undefined ? entry.sourceGroupId : targetGroupId,
      );
      pastedCount += 1;
    }
    return pastedCount;
  }

  function invalidateCompletionCache(connectionId: string, database?: string) {
    invalidateMetadataCaches({ connectionId, database });
    if (database == null) delete completionDatabasesCache.value[connectionId];
    const cachePrefix = database == null ? `${connectionId}:` : `${connectionId}:${database}:`;
    const exactCacheKey = database == null ? null : `${connectionId}:${database}`;
    for (const key of Object.keys(completionTablesCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete completionTablesCache.value[key];
    }
    for (const key of Object.keys(completionObjectsCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete completionObjectsCache.value[key];
    }
    for (const key of Object.keys(completionColumnsCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete completionColumnsCache.value[key];
    }
    for (const key of Object.keys(completionForeignKeysCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete completionForeignKeysCache.value[key];
    }
    for (const key of Object.keys(schemaListCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete schemaListCache.value[key];
    }
    for (const key of completionTableIndex.keys()) {
      if (key.startsWith(cachePrefix)) completionTableIndex.delete(key);
    }
    for (const key of completionObjectIndex.keys()) {
      if (key.startsWith(cachePrefix)) completionObjectIndex.delete(key);
    }
    for (const key of completionColumnIndex.keys()) {
      if (key.startsWith(cachePrefix)) completionColumnIndex.delete(key);
    }
    for (const key of completionForeignKeyIndex.keys()) {
      if (key.startsWith(cachePrefix)) completionForeignKeyIndex.delete(key);
    }
    for (const key of completionInFlight.keys()) {
      if (key.startsWith(cachePrefix)) completionInFlight.delete(key);
    }
  }

  async function removeConnections(ids: Iterable<string>) {
    const connectionIds = [...new Set(ids)].filter((id) => connections.value.some((c) => c.id === id));
    if (!connectionIds.length) return;

    const removedIds = new Set(connectionIds);
    const nextConnections = connections.value.filter((c) => !removedIds.has(c.id));
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    let nextPinnedOrder = pinnedTreeNodeOrder.value;
    for (const id of removedIds) {
      const prefix = `${id}:`;
      nextPinnedOrder = nextPinnedOrder.filter((pinId) => pinId !== id && !pinId.startsWith(prefix));
    }
    setPinnedTreeNodeOrder(nextPinnedOrder);
    persistPinnedTreeNodeIds();
    removeSidebarTableNameFiltersForConnections(removedIds);
    for (const id of removedIds) {
      clearConnectionError(id);
      connectionErrorRevisions.delete(id);
      connectedIds.value.delete(id);
      clearConnectionIdentifierQuote(id);
      clearConnectionHealthCheck(id);
      sidebarLayout.value = removeConnectionFromSidebarLayout(sidebarLayout.value, id);
    }
    rebuildTreeNodes();
    persistSidebarLayoutDebounced();
    if (activeConnectionId.value && removedIds.has(activeConnectionId.value)) {
      activeConnectionId.value = null;
    }
    selectedTreeNodeIds.value = selectedTreeNodeIds.value.filter((id) => !removedIds.has(id));
    if (selectedTreeNodeId.value && removedIds.has(selectedTreeNodeId.value)) selectedTreeNodeId.value = null;
    if (treeSelectionAnchorId.value && removedIds.has(treeSelectionAnchorId.value)) treeSelectionAnchorId.value = null;
    for (const id of removedIds) {
      invalidateCompletionCache(id);
      void invalidateObjectDdlCache({ connectionId: id });
      clearLoadedChildrenCache(id);
      void deleteTabResultSnapshotsForOwner(id);
    }
  }

  async function removeConnection(id: string) {
    await removeConnections([id]);
  }

  async function updateConnection(config: ConnectionConfig) {
    config = normalizeConnection(config);
    const idx = connections.value.findIndex((c) => c.id === config.id);
    if (idx < 0) return;
    const runtimeConfigChanged = connectionConfigFingerprint(connections.value[idx]) !== connectionConfigFingerprint(config);
    const nextConnections = [...connections.value];
    nextConnections[idx] = config;
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    rebuildTreeNodes();
    if (!runtimeConfigChanged) return;
    connectedIds.value.delete(config.id);
    clearConnectionIdentifierQuote(config.id);
    clearConnectionHealthCheck(config.id);
    invalidateCompletionCache(config.id);
    void invalidateObjectDdlCache({ connectionId: config.id });
    clearLoadedChildrenCache(config.id);
    const node = findConnectionNode(config.id);
    if (node?.isExpanded) {
      await reloadConnectionDatabaseChildren(config.id);
    }
  }

  async function updateConnectionDatabaseInfo(connectionId: string, databaseInfo: DatabaseConnectionInfo, expectedConfigFingerprint?: string): Promise<void> {
    const normalized = normalizeDatabaseConnectionInfo(databaseInfo);
    if (!normalized) return;
    const current = connections.value.find((connection) => connection.id === connectionId);
    if (!current) return;
    if (expectedConfigFingerprint && connectionConfigFingerprint(current) !== expectedConfigFingerprint) return;
    if (JSON.stringify(current.database_info) === JSON.stringify(normalized)) return;

    await api.saveConnectionDatabaseInfo(connectionId, normalized);
    const index = connections.value.findIndex((connection) => connection.id === connectionId);
    if (index < 0) return;
    if (expectedConfigFingerprint && connectionConfigFingerprint(connections.value[index]) !== expectedConfigFingerprint) return;
    const nextConnections = [...connections.value];
    nextConnections[index] = { ...nextConnections[index], database_info: normalized };
    connections.value = nextConnections;
    // Database info is reactive connection metadata, not tree structure. Keep
    // navigator node identities stable so an in-flight first expansion can
    // still apply its loaded children after this background refresh completes.
  }

  async function refreshConnectedDatabaseInfo(connectionId: string, config: ConnectionConfig): Promise<void> {
    const expectedConfigFingerprint = connectionConfigFingerprint(config);
    try {
      const detected = await api.connectionDatabaseInfo(connectionId);
      const normalized = normalizeDatabaseConnectionInfo(detected, configuredDatabaseProductName(config), config.database);
      if (normalized) await updateConnectionDatabaseInfo(connectionId, normalized, expectedConfigFingerprint);
    } catch {
      // Database metadata is optional and must not turn a successful connection into a failure.
    }
  }

  async function setDefaultDatabase(connectionId: string, database: string) {
    const config = getConfig(connectionId);
    if (!config || config.database === database) return;
    await updateConnection({
      ...config,
      database,
    });
  }

  async function clearDefaultDatabase(connectionId: string) {
    const config = getConfig(connectionId);
    if (!config || !config.database) return;
    await updateConnection({
      ...config,
      database: undefined,
    });
  }

  function isDefaultDatabase(connectionId: string, database: string): boolean {
    const config = getConfig(connectionId);
    return config?.database === database && database !== "";
  }

  async function setVisibleDatabases(connectionId: string, databaseNames: string[]) {
    const config = getConfig(connectionId);
    if (!config) return;
    await updateVisibleDatabasesConfig(connectionId, normalizeVisibleDatabaseSelection(databaseNames, databaseNames));
    await reloadConnectionDatabaseChildren(connectionId);
  }

  async function clearVisibleDatabases(connectionId: string) {
    const config = getConfig(connectionId);
    if (!config || !Array.isArray(config.visible_databases)) return;
    await updateVisibleDatabasesConfig(connectionId, undefined);
    await reloadConnectionDatabaseChildren(connectionId);
  }

  async function ensureVisibleDatabase(connectionId: string, databaseName: string) {
    const config = getConfig(connectionId);
    if (!config) return;
    const visibleDatabases = appendVisibleDatabaseSelection(config.visible_databases, databaseName);
    if (visibleDatabases === config.visible_databases) return;
    await updateVisibleDatabasesConfig(connectionId, visibleDatabases);
  }

  async function updateVisibleDatabasesConfig(connectionId: string, visibleDatabases: string[] | undefined) {
    const idx = connections.value.findIndex((connection) => connection.id === connectionId);
    if (idx < 0) return;
    const nextConnections = [...connections.value];
    nextConnections[idx] = {
      ...nextConnections[idx],
      visible_databases: visibleDatabases,
    };
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    invalidateCompletionCache(connectionId);
    rebuildTreeNodes();
  }

  async function setVisibleSchemas(connectionId: string, database: string, schemaNames: string[]) {
    const config = getConfig(connectionId);
    if (!config) return;
    const key = database || "";
    await updateVisibleSchemasConfig(connectionId, key, schemaNames);
    await reloadSchemaChildren(connectionId, database);
  }

  async function clearVisibleSchemas(connectionId: string, database: string) {
    const config = getConfig(connectionId);
    if (!config || !config.visible_schemas) return;
    const key = database || "";
    await updateVisibleSchemasConfig(connectionId, key, undefined);
    await reloadSchemaChildren(connectionId, database);
  }

  async function updateVisibleSchemasConfig(connectionId: string, database: string, schemaNames: string[] | undefined) {
    const idx = connections.value.findIndex((connection) => connection.id === connectionId);
    if (idx < 0) return;
    const existing = connections.value[idx].visible_schemas;
    let nextSchemas: Record<string, string[]> | undefined;
    if (schemaNames) {
      nextSchemas = { ...existing, [database]: schemaNames };
    } else if (existing) {
      nextSchemas = { ...existing };
      delete nextSchemas[database];
      if (Object.keys(nextSchemas).length === 0) nextSchemas = undefined;
    }
    const nextConnections = [...connections.value];
    nextConnections[idx] = {
      ...nextConnections[idx],
      visible_schemas: nextSchemas,
    };
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    rebuildTreeNodes();
  }

  async function reloadSchemaChildren(connectionId: string, database?: string) {
    const config = getConfig(connectionId);
    if (!config) return;
    const db = database || config.database || "";
    clearLoadedChildrenCache(connectionId);
    clearLoadedChildrenCache(`${connectionId}:${db}`);
    await loadDatabases(connectionId, { force: true });
    // After saving schema filter, force-refresh database node's schema children
    // to avoid stale children from previously expanded nodes
    if (db) {
      const dbNode = findNode(treeNodes.value, `${connectionId}:${db}`);
      if (dbNode) {
        await loadTreeNodeChildren(dbNode, { force: true });
      }
    }
  }

  async function reloadConnectionDatabaseChildren(connectionId: string) {
    const config = getConfig(connectionId);
    if (!config) return;
    clearLoadedChildrenCache(connectionId);
    await loadDatabases(connectionId, { force: true });
  }

  async function connect(config: ConnectionConfig) {
    config = normalizeConnection(config);
    if (getBlockingDisconnectInFlight(config.id)) await waitForBlockingDisconnectInFlight(config.id);
    const localAttempt = beginLocalConnectionAttempt(config.id);
    try {
      await beforeConnectHandler?.(config);
      ensureLocalConnectionAttemptActive(config.id, localAttempt);
      const id = await withConnectionAttemptTimeout(api.connectDb(config, localAttempt), config);
      await ensureLocalConnectionAttemptActiveAfterConnectResult(config.id, localAttempt, id);
      activeConnectionId.value = id;
      connectedIds.value.add(id);
      void refreshConnectedDatabaseInfo(id, { ...config, id });
      await refreshConnectionIdentifierQuote(id, { ...config, id });
      if (id !== config.id) markSuccessfulLocalConnectionAttempt(config.id, localAttempt);
      markSuccessfulLocalConnectionAttempt(id, localAttempt);
      markConnectionHealthChecked(id);
      clearConnectionError(config.id);
      if (id !== config.id) clearConnectionError(id);

      const existing = findConnectionNode(id);
      if (existing) {
        existing.label = config.name;
        existing.type = "connection";
        existing.connectionId = id;
        existing.comment = config.note || null;
        existing.children = existing.children || [];
      } else {
        treeNodes.value.push({
          id,
          label: config.name,
          type: "connection",
          connectionId: id,
          isExpanded: false,
          children: [],
          comment: config.note || null,
        });
      }
      return id;
    } catch (e) {
      if (isCancelledLocalConnectionAttempt(config.id, localAttempt)) {
        clearConnectionError(config.id);
        throw new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
      }
      if (isCancelledConnectionAttempt(e) || isSupersededConnectionAttempt(e)) {
        clearConnectionError(config.id);
      } else {
        recordConnectionError(config.id, e);
      }
      throw e;
    } finally {
      finishLocalConnectionAttempt(config.id, localAttempt);
    }
  }

  async function cancelConnecting(connectionId: string): Promise<boolean> {
    const localAttempt = getLocalConnectionAttempt(connectionId);
    if (localAttempt == null) return false;
    const disconnectRequest = startCancelDisconnectRequest(connectionId, localAttempt);
    const cancelled = cancelLocalConnectionAttempt(connectionId);
    if (!cancelled) return false;
    clearConnectionError(connectionId);
    connectedIds.value.delete(connectionId);
    clearConnectionIdentifierQuote(connectionId);
    clearConnectionHealthCheck(connectionId);
    if (activeConnectionId.value === connectionId) activeConnectionId.value = null;
    invalidateCompletionCache(connectionId);
    await disconnectRequest;
    return true;
  }

  async function disconnect(connectionId: string) {
    const stateRevision = bumpConnectionStateRevision(connectionId);
    const disconnectRequest = startDisconnectRequest(connectionId);
    cancelLocalConnectionAttempt(connectionId);
    const shouldRemoveOneTimeConnection = getConfig(connectionId)?.one_time === true;

    connectedIds.value.delete(connectionId);
    clearConnectionIdentifierQuote(connectionId);
    forgetSuccessfulLocalConnectionAttempt(connectionId);
    clearConnectionHealthCheck(connectionId);
    const node = findConnectionNode(connectionId);
    if (node) {
      node.isLoading = false;
      node.isExpanded = false;
      node.children = [];
    }
    clearConnectionRootMetadataLoad(connectionId);
    // Disconnecting only tears down the live session. Keep the schema snapshot so
    // reconnecting can render databases and table names before the remote refresh.
    clearLoadedChildrenCache(connectionId, { deletePersisted: false });
    if (activeConnectionId.value === connectionId) {
      activeConnectionId.value = null;
    }
    invalidateCompletionCache(connectionId);
    invalidateObjectBrowserRowsCache({ connectionId });
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    switch (settingsStore.editorSettings.disconnectTabHandlingMode) {
      case "close-tabs":
        queryStore.closeConnectionTabs(connectionId);
        break;
      case "keep-tabs-clear-results":
        queryStore.releaseConnectionTabs(connectionId);
        break;
      case "keep-tabs-keep-results":
        queryStore.rollbackConnectionTransactions(connectionId);
        break;
    }
    await disconnectRequest;
    if (isCurrentConnectionStateRevision(connectionId, stateRevision)) {
      clearConnectionError(connectionId);
    }
    if (shouldRemoveOneTimeConnection && isCurrentConnectionStateRevision(connectionId, stateRevision)) {
      await removeConnection(connectionId);
    }
  }

  async function closeDatabaseConnection(connectionId: string, database: string) {
    await api.closeDatabaseConnection(connectionId, database);
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    switch (settingsStore.editorSettings.disconnectTabHandlingMode) {
      case "close-tabs":
        queryStore.closeDatabaseTabs(connectionId, database);
        break;
      case "keep-tabs-clear-results":
        queryStore.releaseDatabaseTabs(connectionId, database);
        break;
      case "keep-tabs-keep-results":
        queryStore.rollbackDatabaseTransactions(connectionId, database);
        break;
    }
    const node = findDatabaseTreeNode(treeNodes.value, connectionId, database);
    if (node) {
      node.isExpanded = false;
      node.children = [];
      clearLoadedChildrenCache(node.id);
    }
    invalidateCompletionCache(connectionId, database);
    invalidateObjectBrowserRowsCache({ connectionId, database });
  }

  async function ensureConnected(connectionId: string, options: { activate?: boolean } = {}) {
    if (connectedIds.value.has(connectionId)) {
      if (hasRecentConnectionHealthCheck(connectionId)) return;
      // Optimistic: verify backend pool is actually healthy
      try {
        await withConnectionHealthTimeout(connectionId, api.checkConnectionHealth(connectionId));
        markConnectionHealthChecked(connectionId);
        return;
      } catch {
        // Backend pool is dead — remove from connectedIds and reconnect
        connectedIds.value.delete(connectionId);
        clearConnectionHealthCheck(connectionId);
        if (activeConnectionId.value === connectionId) activeConnectionId.value = null;
      }
    }
    let config = getConfig(connectionId);
    if (!config) {
      await initFromDisk();
      config = getConfig(connectionId);
    }
    if (!config) {
      const error = new Error("Connection config not found");
      recordConnectionError(connectionId, error);
      throw error;
    }
    if (getBlockingDisconnectInFlight(connectionId)) await waitForBlockingDisconnectInFlight(connectionId);
    const existingConnect = connectInFlight.get(connectionId);
    if (existingConnect) {
      await existingConnect;
      if (options.activate !== false) activeConnectionId.value = connectionId;
      return;
    }
    const localAttempt = beginLocalConnectionAttempt(connectionId);
    const connectPromise = (async () => {
      await beforeConnectHandler?.(config);
      ensureLocalConnectionAttemptActive(connectionId, localAttempt);
      const id = await withConnectionAttemptTimeout(api.connectDb(config, localAttempt), config);
      await ensureLocalConnectionAttemptActiveAfterConnectResult(connectionId, localAttempt, id);
      connectedIds.value.add(connectionId);
      void refreshConnectedDatabaseInfo(connectionId, config);
      await refreshConnectionIdentifierQuote(connectionId, config);
      markSuccessfulLocalConnectionAttempt(connectionId, localAttempt);
      markConnectionHealthChecked(connectionId);
      clearConnectionError(connectionId);
    })();
    connectInFlight.set(connectionId, connectPromise);
    try {
      await connectPromise;
      if (options.activate !== false) activeConnectionId.value = connectionId;
    } catch (e) {
      if (isCancelledLocalConnectionAttempt(connectionId, localAttempt)) {
        clearConnectionError(connectionId);
        throw new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
      }
      if (isCancelledConnectionAttempt(e)) {
        clearConnectionError(connectionId);
        throw e;
      }
      if (isSupersededConnectionAttempt(e) && connectedIds.value.has(connectionId)) {
        clearConnectionError(connectionId);
        return;
      }
      recordConnectionError(connectionId, e);
      clearConnectionNodeLoading(connectionId);
      throw e;
    } finally {
      if (connectInFlight.get(connectionId) === connectPromise) {
        connectInFlight.delete(connectionId);
      }
      finishLocalConnectionAttempt(connectionId, localAttempt);
    }
  }

  function setBeforeConnectHandler(handler: BeforeConnectHandler | null) {
    beforeConnectHandler = handler;
  }

  function sidebarDatabaseStorageRequestKey(connectionId: string, databases: readonly string[]): string {
    return `${connectionId}\0${[...databases].sort().join("\0")}`;
  }

  async function loadSidebarDatabaseStorage(connectionId: string, options?: { force?: boolean }): Promise<void> {
    if (settingsStore.editorSettings.sidebarObjectInfoMode !== "size" || !connectedIds.value.has(connectionId)) return;
    if (!supportsSidebarDatabaseStorage(getConfig(connectionId))) return;
    const connectionNode = findConnectionNode(connectionId);
    const databases = sidebarDatabaseNames(connectionNode?.children);
    if (!databases.length) return;

    const requestKey = sidebarDatabaseStorageRequestKey(connectionId, databases);
    const cached = sidebarDatabaseStorageCache.get(requestKey);
    if (!options?.force && cached && cached.expiresAt > Date.now()) {
      applySidebarDatabaseStorage(connectionNode?.children, cached.value);
      return;
    }

    let request = sidebarDatabaseStorageInFlight.get(requestKey);
    if (!request) {
      request = api.listDatabaseStorage(connectionId, databases);
      sidebarDatabaseStorageInFlight.set(requestKey, request);
    }
    try {
      const storage = await request;
      sidebarDatabaseStorageCache.set(requestKey, {
        expiresAt: Date.now() + SIDEBAR_DATABASE_STORAGE_CACHE_TTL_MS,
        value: storage,
      });
      const currentNode = findConnectionNode(connectionId);
      const currentNames = sidebarDatabaseNames(currentNode?.children);
      if (sidebarDatabaseStorageRequestKey(connectionId, currentNames) === requestKey) {
        applySidebarDatabaseStorage(currentNode?.children, storage);
      }
    } catch (error) {
      console.debug("[ogdeveloper][sidebar-database-storage:unavailable]", { connectionId, error });
    } finally {
      if (sidebarDatabaseStorageInFlight.get(requestKey) === request) {
        sidebarDatabaseStorageInFlight.delete(requestKey);
      }
    }
  }

  function sidebarTableStorageRequestKey(scope: SidebarTableStorageScope): string {
    return `${scope.connectionId}\0${scope.database}\0${scope.schema}`;
  }

  async function loadSidebarTableStorage(scope: SidebarTableStorageScope, options?: { force?: boolean }): Promise<void> {
    if (settingsStore.editorSettings.sidebarObjectInfoMode !== "size" || !connectedIds.value.has(scope.connectionId)) return;
    if (!supportsSidebarTableStorage(getConfig(scope.connectionId))) return;
    const requestKey = sidebarTableStorageRequestKey(scope);
    const cached = sidebarTableStorageCache.get(requestKey);
    if (!options?.force && cached && cached.expiresAt > Date.now()) {
      applySidebarTableStorage(treeNodes.value, scope, cached.value);
      return;
    }

    let request = options?.force ? undefined : sidebarTableStorageInFlight.get(requestKey);
    if (!request) {
      request = api.listObjectStatistics(scope.connectionId, scope.database, scope.schema);
      sidebarTableStorageInFlight.set(requestKey, request);
    }
    try {
      const statistics = await request;
      if (sidebarTableStorageInFlight.get(requestKey) !== request) return;
      sidebarTableStorageCache.set(requestKey, {
        expiresAt: Date.now() + SIDEBAR_DATABASE_STORAGE_CACHE_TTL_MS,
        value: statistics,
      });
      applySidebarTableStorage(treeNodes.value, scope, statistics);
    } catch (error) {
      console.debug("[ogdeveloper][sidebar-table-storage:unavailable]", { ...scope, error });
    } finally {
      if (sidebarTableStorageInFlight.get(requestKey) === request) {
        sidebarTableStorageInFlight.delete(requestKey);
      }
    }
  }

  const sidebarDatabaseStorageScope = computed(() => {
    if (settingsStore.editorSettings.sidebarObjectInfoMode !== "size") return "";
    return [...connectedIds.value]
      .filter((connectionId) => supportsSidebarDatabaseStorage(getConfig(connectionId)))
      .map((connectionId) => sidebarDatabaseStorageRequestKey(connectionId, sidebarDatabaseNames(findConnectionNode(connectionId)?.children)))
      .sort()
      .join("\n");
  });

  watch(
    sidebarDatabaseStorageScope,
    () => {
      if (settingsStore.editorSettings.sidebarObjectInfoMode !== "size") return;
      for (const connectionId of connectedIds.value) {
        void loadSidebarDatabaseStorage(connectionId);
      }
    },
    { flush: "post" },
  );

  async function loadDatabases(connectionId: string, options?: LoadTreeOptions) {
    const configForScope = getConfig(connectionId);
    const searchFilter = activeTreeLoadSearchFilter(options);
    if (!options?.force && !options?.connectedOnly && !searchFilter) {
      const cacheHit = await hydrateConnectionRootFromCache(connectionId, configForScope);
      if (cacheHit) {
        // Render the last known metadata immediately; network validation and refresh
        // continue in the background so opening a connection never waits on them.
        void loadDatabases(connectionId, { ...options, force: true }).catch(() => undefined);
        return;
      }
    }
    return runTreeMetadataLoad(
      {
        kind: "connection-databases",
        connectionId,
        driverProfile: metadataDriverProfile(configForScope),
      },
      async () => {
        const node = findConnectionNode(connectionId);
        if (!node) return;
        let load = beginTreeNodeLoad(node);
        try {
          if (options?.connectedOnly) {
            if (!connectedIds.value.has(connectionId)) return;
          } else {
            await ensureConnected(connectionId);
            load = reclaimTreeNodeLoad(load, node);
          }
          if (useCachedChildren(node, options, load)) return;

          const config = getConfig(connectionId);
          if (config && connectionUsesVisibleSchemaFilter(config)) {
            const schemaFilterConfig = config;
            const effectiveDb = schemaFilterConfig.database || "";
            const showSystemSchemas = schemaFilterConfig.show_system_schemas === true;
            const cacheKey = schemaCacheKey(connectionId, effectiveDb, "schemas", showSystemSchemas ? "show-system" : "hide-system");
            if (!options?.force) {
              const cached = await loadPersistedTreeChildren(node, cacheKey, load);
              if (cached.hit) {
                if (cached.isStale) refreshStaleTreeNode(node);
                return;
              }
            }
            const schemas = await withMetadataLoadTimeout(connectionId, api.listSchemas(connectionId, effectiveDb, true), "schemas");
            const visibleSchemas = filterSchemaNamesForConnection(schemas, schemaFilterConfig, effectiveDb || "", { showSystemSchemas });
            const schemaNodes: TreeNode[] = sortSidebarNames(visibleSchemas).map((s) => ({
              id: `${connectionId}:${s}:${s}`,
              label: s,
              type: "schema" as const,
              connectionId,
              database: s,
              schema: s,
              isExpanded: false,
              children: [],
            }));
            if (isSidebarSearchQueryChanged(options)) return;
            const targetNode = treeNodeLoadTarget(load);
            if (!targetNode) return;
            setChildren(targetNode, withSavedSqlRoot(connectionId, schemaNodes, targetNode));
            await savePersistedConnectionTreeChildren(cacheKey, targetNode.children || schemaNodes);
          } else {
            const cacheKey = schemaCacheKey(connectionId, "databases-v2");
            if (!options?.force) {
              const cached = await loadPersistedTreeChildren(node, cacheKey, load);
              if (cached.hit) {
                if (cached.isStale) refreshStaleTreeNode(node);
                return;
              }
            }
            const databases = await withMetadataLoadTimeout(connectionId, api.listDatabases(connectionId), "databases");
            const visibleNames = filterDatabaseNamesForConnection(
              databases.map((database) => database.name),
              config,
            );
            const visibleNameSet = new Set(visibleNames);
            const visibleDatabases = databases.filter((database) => visibleNameSet.has(database.name));
            const databaseNodes = buildDatabaseTreeNodes(connectionId, visibleDatabases, {
              includeDefaultWhenEmpty: true,
            });
            const children = withSavedSqlRoot(connectionId, databaseNodes, node);
            if (isSidebarSearchQueryChanged(options)) return;
            const targetNode = treeNodeLoadTarget(load);
            if (!targetNode) return;
            setChildren(targetNode, children);
            await savePersistedConnectionTreeChildren(cacheKey, targetNode.children || children);
          }
          const liveNode = treeNodeLoadTarget(load);
          if (liveNode) liveNode.isExpanded = true;
          if (options?.force) void loadSidebarDatabaseStorage(connectionId, { force: true });
        } catch (e) {
          recordMetadataLoadError(connectionId, e, load);
          throw e;
        } finally {
          finishTreeNodeLoad(load);
        }
      },
      options,
    );
  }

  async function loadConnectedConnectionRootForSidebarSearch(connectionId: string) {
    if (!connectedIds.value.has(connectionId)) return;
    const config = getConfig(connectionId);
    if (!config) return;
    const node = findConnectionNode(connectionId);
    if (!node || node.type !== "connection" || node.isLoading || hasConnectionMetadataChildren(node.children)) return;
    const scope = { kind: "connection-databases" as const, connectionId, driverProfile: metadataDriverProfile(config) };
    if (metadataLoadCoordinator.has(scope)) return;

    const wasExpanded = !!node.isExpanded;
    const load = beginTreeNodeLoad(node);
    try {
      await loadDatabases(connectionId, { connectedOnly: true });
    } finally {
      const liveNode = treeNodeInSidebarTree(node);
      if (liveNode) liveNode.isExpanded = wasExpanded;
      finishTreeNodeLoad(load);
    }
  }

  async function loadSchemas(connectionId: string, database: string, options?: LoadTreeOptions) {
    const configForScope = getConfig(connectionId);
    return runTreeMetadataLoad(
      {
        kind: "database-schemas",
        connectionId,
        database,
        driverProfile: metadataDriverProfile(configForScope),
      },
      async () => {
        const nodeId = `${connectionId}:${database}`;
        const node = findNode(treeNodes.value, nodeId);
        if (!node) return;
        let load = beginTreeNodeLoad(node);
        try {
          await ensureConnected(connectionId);
          load = reclaimTreeNodeLoad(load, node);
          if (useCachedChildren(node, options, load)) return;
          const config = getConfig(connectionId);
          const showSystemSchemas = config?.show_system_schemas === true;
          const cacheVersion = ownerAwareMetadataCacheVersion(config, "schemas-v3");
          const cacheKey = schemaCacheKey(connectionId, database, cacheVersion, showSystemSchemas ? "show-system" : "hide-system");
          if (!options?.force) {
            const cached = await loadPersistedTreeChildren(node, cacheKey, load);
            if (cached.hit) {
              if (cached.isStale) refreshStaleTreeNode(node);
              return;
            }
          }

          const schemas = sortSidebarSchemaInfos(await withMetadataLoadTimeout(connectionId, api.listSchemaInfos(connectionId, database), "schemas"));
          const visibleSchemaNames = new Set(
            filterSchemaNamesForConnection(
              schemas.map((schema) => schema.name),
              getConfig(connectionId),
              database,
              { showSystemSchemas },
            ),
          );
          const children: TreeNode[] = schemas
            .filter((schema) => visibleSchemaNames.has(schema.name))
            .map((schema) => {
              const s = schema.name;
              return {
                id: `${connectionId}:${database}:${s}`,
                label: s,
                type: "schema" as const,
                connectionId,
                database,
                schema: s,
                comment: schema.comment,
                isExpanded: false,
                children: [],
              };
            });
          if (schemas.length === 0 && connectionShouldDiscoverJdbcSchemas(getConfig(connectionId))) {
            // Generic JDBC drivers vary widely: prefer schema navigation when the
            // driver reports schemas, but keep the legacy flat object tree when it
            // reports none so non-schema engines do not expand into an empty node.
            await loadTables(connectionId, database, undefined, options);
            return;
          }
          if (isPostgresLikeForExtensions(getConfig(connectionId)?.db_type)) {
            children.push(buildExtensionManagementNode(connectionId, database));
          }
          if (isSidebarSearchQueryChanged(options)) return;
          const targetNode = treeNodeLoadTarget(load);
          if (!targetNode) return;
          setChildren(targetNode, children);
          await savePersistedTreeChildren(cacheKey, children);
          const currentTargetNode = treeNodeLoadTarget(load);
          if (currentTargetNode) currentTargetNode.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(connectionId, e, load);
          throw e;
        } finally {
          finishTreeNodeLoad(load);
        }
      },
      options,
    );
  }

  async function loadTables(connectionId: string, database: string, schema?: string, options?: LoadTreeOptions) {
    await awaitDatabaseCompatMode(connectionId, database);
    const configForScope = getConfig(connectionId);
    const simpleObjectDisplayForScope = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
    const objectTypesForScope = simpleObjectDisplayForScope ? supportedSidebarObjectTypes(configForScope, database) : undefined;
    const searchFilter = activeTreeLoadSearchFilter(options);
    const querySchemaForScope = connectionObjectTreeQuerySchema(configForScope, database, schema);
    const effectiveSchemaForScope = connectionObjectTreeNodeSchema(configForScope, database, schema);
    const tableNameFilterForScope = activeTableNameFilterForScope({
      connectionId,
      database,
      schema: effectiveSchemaForScope ?? querySchemaForScope,
      nodeKind: simpleObjectDisplayForScope ? "simple-tables" : "group-tables",
    });
    if (!options?.force && simpleObjectDisplayForScope && !searchFilter && !options?.sidebarTableSearchParentId && !tableNameFilterForScope) {
      const nodeId = schema ? `${connectionId}:${database}:${schema}` : `${connectionId}:${database}`;
      const cacheKey = schemaCacheKey(connectionId, database, schema || "", ownerAwareMetadataCacheVersion(configForScope, "objects-simple-v8"));
      if (await hydrateTreeNodeFromCache(findNode(treeNodes.value, nodeId), cacheKey)) {
        void loadTables(connectionId, database, schema, { ...options, force: true }).catch(() => undefined);
        return;
      }
    }
    return runTreeMetadataLoad(
      {
        kind: "schema-tables",
        connectionId,
        database,
        schema,
        nodeKind: schema ? "schema" : "database",
        objectTypes: objectTypesForScope,
        searchFilter: activeTreeLoadSearchFilter(options),
        limit: simpleObjectDisplayForScope ? sidebarObjectGroupPageSize() + 1 : undefined,
        offset: 0,
        sidebarDisplayMode: simpleObjectDisplayForScope ? "simple" : "grouped",
        driverProfile: metadataDriverProfile(configForScope),
        extra: options?.sidebarTableSearchParentId ? { sidebarTableSearchParentId: options.sidebarTableSearchParentId } : undefined,
      },
      async () => {
        const nodeId = schema ? `${connectionId}:${database}:${schema}` : `${connectionId}:${database}`;
        const node = findNode(treeNodes.value, nodeId);
        if (!node) return;
        let load = beginTreeNodeLoad(node);
        try {
          await ensureConnected(connectionId);
          load = reclaimTreeNodeLoad(load, node);
          if (useCachedChildren(node, options, load)) return;
          const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
          const searchFilter = activeTreeLoadSearchFilter(options);
          const config = getConfig(connectionId);
          const cacheVersion = ownerAwareMetadataCacheVersion(config, simpleObjectDisplay ? "objects-simple-v8" : "objects-grouped-v9");
          const cacheKey = schemaCacheKey(connectionId, database, schema || "", cacheVersion);
          const querySchema = connectionObjectTreeQuerySchema(config, database, schema);
          const effectiveSchema = connectionObjectTreeNodeSchema(config, database, schema);
          const tableNameFilter = activeTableNameFilterForScope({
            connectionId,
            database,
            schema,
            nodeKind: simpleObjectDisplay ? "simple-tables" : "group-tables",
          });
          const isSidebarTableSearch = !!options?.sidebarTableSearchParentId;
          if (!options?.force && !searchFilter && !tableNameFilter) {
            const cached = await loadPersistedTreeChildren(node, cacheKey, load);
            if (cached.hit) {
              if (cached.isStale) refreshStaleTreeNode(node);
              return;
            }
          }

          const nonTableObjectTypes = simpleObjectDisplay ? supportedSidebarObjectTypes(config, database).filter((objectType) => objectType !== "TABLE") : [];
          let children: TreeNode[];
          let nextObjectCount: number | undefined;
          if (simpleObjectDisplay) {
            const pageSize = sidebarObjectGroupPageSize();
            const page = await loadPagedSimpleTableChildren({
              nodeId,
              connectionId,
              database,
              querySchema,
              effectiveSchema,
              nonTableObjectTypes,
              offset: 0,
              pageSize,
              searchFilter: searchFilter || undefined,
              force: options?.force,
            });
            children = page.hasMore && !searchFilter ? appendTableTreeLoadMoreNode(page.children, buildLoadMoreNode(node, page.nextOffset, pageSize), page.loadMoreParent) : page.children;
            nextObjectCount = page.objectCount;
          } else {
            children = buildObjectGroupPlaceholderNodes({
              nodeId,
              connectionId,
              database,
              schema: effectiveSchema,
              objectTypes: supportedSidebarObjectTypes(config, database),
            });
            if (!schema && isPostgresLikeForExtensions(config?.db_type)) {
              children.push(buildExtensionManagementNode(connectionId, database));
            }
          }
          if (isTreeLoadSearchChanged(searchFilter, options)) return;
          if (!tableNameFilterRevisionMatches(options)) return;
          const targetNode = treeNodeLoadTarget(load);
          if (!targetNode) return;
          if (nextObjectCount !== undefined) targetNode.objectCount = nextObjectCount;
          setChildren(targetNode, children);
          if (!searchFilter && !isSidebarTableSearch && !tableNameFilter) {
            await savePersistedTreeChildren(cacheKey, children);
          }
          const currentTargetNode = treeNodeLoadTarget(load);
          if (!currentTargetNode) return;
          currentTargetNode.isExpanded = true;
          if (simpleObjectDisplay && !searchFilter && !isSidebarTableSearch && nonTableObjectTypes.length > 0) {
            void loadSimpleSupplementalObjectChildren({
              node: currentTargetNode,
              nodeId,
              connectionId,
              database,
              querySchema,
              effectiveSchema,
              objectTypes: nonTableObjectTypes,
              cacheKey,
              loadOptions: options,
              load,
            });
          }
        } catch (e) {
          recordMetadataLoadError(connectionId, e, load);
          throw e;
        } finally {
          finishTreeNodeLoad(load);
        }
      },
      options,
    );
  }

  async function loadObjectGroupChildren(node: TreeNode, options?: LoadTreeOptions) {
    if (node.type === "group-materialized-views") {
    }
    const configForScope = node.connectionId ? getConfig(node.connectionId) : undefined;
    const objectTypesForScope = objectTypesForGroupNode(node.type);
    const pageSizeForScope = sidebarObjectGroupPageSize();
    const searchFilter = activeTreeLoadSearchFilter(options);
    const querySchemaForScope = connectionObjectTreeQuerySchema(configForScope, node.database || "", node.schema);
    const effectiveSchemaForScope = connectionObjectTreeNodeSchema(configForScope, node.database || "", node.schema);
    const tableNameFilterForScope = activeTableNameFilterForScope({
      connectionId: node.connectionId,
      database: node.database,
      schema: effectiveSchemaForScope ?? querySchemaForScope,
      nodeKind: node.type,
      catalog: node.catalog,
    });
    if (!options?.force && !searchFilter && !options?.sidebarTableSearchParentId && !tableNameFilterForScope) {
      if (await hydrateTreeNodeFromCache(node, objectGroupCacheKey(node))) {
        void loadObjectGroupChildren(node, { ...options, force: true }).catch(() => undefined);
        return;
      }
    }
    return runTreeMetadataLoad(
      {
        kind: "object-group",
        connectionId: node.connectionId,
        database: node.database,
        schema: node.schema,
        nodeKind: node.type,
        objectTypes: objectTypesForScope,
        searchFilter: activeTreeLoadSearchFilter(options),
        limit: pageSizeForScope + 1,
        offset: 0,
        sidebarDisplayMode: useSettingsStore().editorSettings.sidebarObjectDisplay,
        driverProfile: metadataDriverProfile(configForScope),
        extra: options?.sidebarTableSearchParentId ? { sidebarTableSearchParentId: options.sidebarTableSearchParentId } : undefined,
      },
      async () => {
        if (!node.connectionId || !hasTreeNodeDatabaseContext(node)) return;
        let load = beginTreeNodeLoad(node);
        try {
          await ensureConnected(node.connectionId);
          load = reclaimTreeNodeLoad(load, node);
          if (useCachedChildren(node, options, load)) return;
          const objectTypes = objectTypesForGroupNode(node.type);
          const parentNodeId = objectGroupRefreshParentId(node);
          if (!objectTypes || !parentNodeId) return;

          const config = getConfig(node.connectionId);
          const querySchema = connectionObjectTreeQuerySchema(config, node.database, node.schema);
          const effectiveSchema = connectionObjectTreeNodeSchema(config, node.database, node.schema);
          const cacheKey = objectGroupCacheKey(node);
          const searchFilter = activeTreeLoadSearchFilter(options);
          const tableNameFilter = activeTableNameFilterForScope({
            connectionId: node.connectionId,
            database: node.database,
            schema: node.schema,
            nodeKind: node.type,
            catalog: node.catalog,
          });
          const isSidebarTableSearch = !!options?.sidebarTableSearchParentId;
          if (!options?.force && !searchFilter && !tableNameFilter) {
            const cached = await loadPersistedTreeChildren(node, cacheKey, load);
            if (cached.hit) {
              if (cached.isStale) refreshStaleTreeNode(node);
              return;
            }
          }

          const wantsOnlyTablesOrViews = objectTypes.every((objectType) => objectType === "TABLE" || objectType === "VIEW" || objectType === "MATERIALIZED_VIEW");
          let children: TreeNode[];
          let nextObjectCount: number;
          if (wantsOnlyTablesOrViews) {
            const page = await loadPagedTableGroupChildren({
              node,
              parentNodeId,
              querySchema,
              effectiveSchema,
              objectTypes,
              offset: 0,
              pageSize: sidebarObjectGroupPageSize(),
              searchFilter: searchFilter || undefined,
              force: options?.force,
            });
            children = page.hasMore && !searchFilter ? appendTableTreeLoadMoreNode(page.children, buildLoadMoreNode(node, page.nextOffset, sidebarObjectGroupPageSize()), page.loadMoreParent) : page.children;
            nextObjectCount = page.objectCount;
          } else {
            const pageSize = sidebarObjectGroupPageSize();
            const page = await loadPagedObjectGroupChildren({
              node,
              parentNodeId,
              querySchema,
              effectiveSchema,
              objectTypes,
              offset: 0,
              pageSize,
              searchFilter: searchFilter || undefined,
              force: options?.force,
            });
            children = page.hasMore && !searchFilter ? [...page.children, buildLoadMoreNode(node, page.nextOffset, pageSize)] : page.children;
            nextObjectCount = page.objectCount;
          }
          if (isTreeLoadSearchChanged(searchFilter, options)) return;
          if (!tableNameFilterRevisionMatches(options)) return;
          const targetNode = treeNodeLoadTarget(load);
          if (!targetNode) return;
          targetNode.objectCount = nextObjectCount;
          setChildren(targetNode, children);
          if (!searchFilter && !isSidebarTableSearch && !tableNameFilter) {
            await savePersistedTreeChildren(cacheKey, children);
          }
          const currentTargetNode = treeNodeLoadTarget(load);
          if (currentTargetNode) currentTargetNode.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(node.connectionId, e, load);
          throw e;
        } finally {
          finishTreeNodeLoad(load);
        }
      },
      options,
    );
  }

  async function loadMoreObjectGroupChildren(node: TreeNode) {
    if (node.type !== "load-more" || !node.loadMore) return;
    const loadMore = node.loadMore;
    const parent = findNode(treeNodes.value, node.loadMore.parentId);
    if (!parent?.connectionId || !hasTreeNodeDatabaseContext(parent)) return;
    const parentConnectionId = parent.connectionId;
    const configForScope = getConfig(parentConnectionId);
    const objectTypesForScope = objectTypesForGroupNode(parent.type);
    return runTreeMetadataLoad(
      {
        kind: "object-group-page",
        connectionId: parentConnectionId,
        database: parent.database,
        schema: parent.schema,
        nodeKind: parent.type,
        objectTypes: objectTypesForScope,
        limit: loadMore.pageSize + 1,
        offset: loadMore.offset,
        sidebarDisplayMode: useSettingsStore().editorSettings.sidebarObjectDisplay,
        driverProfile: metadataDriverProfile(configForScope),
      },
      async () => {
        let load = beginTreeNodeLoad(node);
        // Parent writes must honor the parent's generation too — load-more begins on the
        // placeholder node, so a replaced/invalidated parent must reject the merge.
        const parentEpoch = treeNodeLoads.observe(parent.id);
        try {
          await ensureConnected(parentConnectionId);
          load = reclaimTreeNodeLoad(load, node);
          if (parent.type === "database" || parent.type === "schema") {
            const parentDatabase = parent.database;
            if (!parentDatabase) return;
            const config = getConfig(parentConnectionId);
            const querySchema = connectionObjectTreeQuerySchema(config, parentDatabase, parent.schema);
            const effectiveSchema = connectionObjectTreeNodeSchema(config, parentDatabase, parent.schema);
            const page = await loadPagedSimpleTableChildren({
              nodeId: parent.schema ? `${parentConnectionId}:${parentDatabase}:${parent.schema}` : `${parentConnectionId}:${parentDatabase}`,
              connectionId: parentConnectionId,
              database: parentDatabase,
              querySchema,
              effectiveSchema,
              nonTableObjectTypes: [],
              offset: loadMore.offset,
              pageSize: loadMore.pageSize,
              force: false,
            });
            const targetParent = treeNodeLoadRelatedTarget(load, parent);
            if (!targetParent || !parentEpoch.isCurrent()) return;
            const currentChildren = withoutTableTreeLoadMoreNodes(targetParent.children);
            const mergedChildren = mergeTableTreePageChildren(currentChildren, page.children, parentConnectionId, parentDatabase);
            const nextChildren = page.hasMore ? appendTableTreeLoadMoreNode(mergedChildren, buildLoadMoreNode(targetParent, page.nextOffset, loadMore.pageSize), page.loadMoreParent) : mergedChildren;
            targetParent.objectCount = mergedChildren.length;
            setChildren(targetParent, nextChildren);
            await savePersistedTreeChildren(schemaCacheKey(parentConnectionId, parentDatabase, parent.schema || "", ownerAwareMetadataCacheVersion(config, "objects-simple-v8")), nextChildren);
            const currentTargetParent = treeNodeLoadRelatedTarget(load, parent);
            if (currentTargetParent && parentEpoch.isCurrent()) currentTargetParent.isExpanded = true;
            return;
          }
          const objectTypes = objectTypesForGroupNode(parent.type);
          const parentNodeId = objectGroupRefreshParentId(parent);
          if (!objectTypes || !parentNodeId) return;

          const config = getConfig(parentConnectionId);
          const parentDatabase = parent.database;
          if (!parentDatabase) return;
          const querySchema = connectionObjectTreeQuerySchema(config, parentDatabase, parent.schema);
          const effectiveSchema = connectionObjectTreeNodeSchema(config, parentDatabase, parent.schema);
          const wantsOnlyTablesOrViews = objectTypes.every((objectType) => objectType === "TABLE" || objectType === "VIEW" || objectType === "MATERIALIZED_VIEW");
          let mergedChildren: TreeNode[];
          let nextChildren: TreeNode[];
          if (wantsOnlyTablesOrViews) {
            const page = await loadPagedTableGroupChildren({
              node: parent,
              parentNodeId,
              querySchema,
              effectiveSchema,
              objectTypes,
              offset: loadMore.offset,
              pageSize: loadMore.pageSize,
              force: false,
            });
            const targetParent = treeNodeLoadRelatedTarget(load, parent);
            if (!targetParent || !parentEpoch.isCurrent()) return;
            const currentChildren = withoutTableTreeLoadMoreNodes(targetParent.children);
            mergedChildren = mergeTableTreePageChildren(currentChildren, page.children, parentConnectionId, parentDatabase);
            nextChildren = page.hasMore ? appendTableTreeLoadMoreNode(mergedChildren, buildLoadMoreNode(targetParent, page.nextOffset, loadMore.pageSize), page.loadMoreParent) : mergedChildren;
          } else {
            const page = await loadPagedObjectGroupChildren({
              node: parent,
              parentNodeId,
              querySchema,
              effectiveSchema,
              objectTypes,
              offset: loadMore.offset,
              pageSize: loadMore.pageSize,
              force: false,
            });
            const targetParent = treeNodeLoadRelatedTarget(load, parent);
            if (!targetParent || !parentEpoch.isCurrent()) return;
            const currentChildren = withoutLoadMoreNodes(targetParent.children);
            mergedChildren = mergeLocatedTreeChildren(targetParent, currentChildren, page.children, parentConnectionId, parentDatabase);
            nextChildren = page.hasMore ? [...mergedChildren, buildLoadMoreNode(targetParent, page.nextOffset, loadMore.pageSize)] : mergedChildren;
            targetParent.objectCount = mergedChildren.length;
            setChildren(targetParent, nextChildren);
            await savePersistedTreeChildren(objectGroupCacheKey(targetParent), nextChildren);
            const currentTargetParent = treeNodeLoadRelatedTarget(load, parent);
            if (currentTargetParent && parentEpoch.isCurrent()) currentTargetParent.isExpanded = true;
            return;
          }
          const targetParent = treeNodeLoadRelatedTarget(load, parent);
          if (!targetParent || !parentEpoch.isCurrent()) return;
          targetParent.objectCount = mergedChildren.length;
          setChildren(targetParent, nextChildren);
          await savePersistedTreeChildren(objectGroupCacheKey(targetParent), nextChildren);
          const currentTargetParent = treeNodeLoadRelatedTarget(load, parent);
          if (currentTargetParent && parentEpoch.isCurrent()) currentTargetParent.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(parentConnectionId, e, load);
          throw e;
        } finally {
          finishTreeNodeLoad(load);
        }
      },
    );
  }

  async function loadExtensions(connectionId: string, database: string) {
    const node = findNode(treeNodes.value, `${connectionId}:${database}:__extensions`);
    if (!node) return;
    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      if (useCachedChildren(node, undefined, load)) return;
      const extensions = await withMetadataLoadTimeout(connectionId, api.listExtensions(connectionId, database), "extensions");
      const children: TreeNode[] = extensions.map((ext) => ({
        id: `${node.id}:${ext.schema || ""}:${ext.name}`,
        label: ext.name,
        type: "extension" as const,
        connectionId,
        database,
        schema: ext.schema ?? undefined,
        comment: ext.comment ?? null,
        meta: ext,
        isExpanded: false,
      }));
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(targetNode, children);
      targetNode.objectCount = children.length;
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadTableForLocate(target: LocateTableTarget): Promise<boolean> {
    const config = getConfig(target.connectionId);
    if (!config) return false;
    return runTreeMetadataLoad(
      {
        kind: "locate-target",
        connectionId: target.connectionId,
        database: target.database,
        schema: target.schema,
        tableName: target.tableName,
        searchFilter: target.tableName,
        limit: sidebarObjectGroupPageSize() + 1,
        offset: 0,
        sidebarDisplayMode: useSettingsStore().editorSettings.sidebarObjectDisplay,
        driverProfile: metadataDriverProfile(config),
      },
      async () => {
        await ensureConnected(target.connectionId);

        const querySchema = connectionObjectTreeQuerySchema(config, target.database, target.schema);
        const effectiveSchema = connectionObjectTreeNodeSchema(config, target.database, target.schema);
        const pageSize = sidebarObjectGroupPageSize();
        const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
        let loaded = false;

        if (simpleObjectDisplay) {
          const parentId = target.schema ? `${target.connectionId}:${target.database}:${target.schema}` : `${target.connectionId}:${target.database}`;
          const parent = findNode(treeNodes.value, parentId);
          if (!parent) return false;
          let load = beginTreeNodeLoad(parent);
          try {
            load = reclaimTreeNodeLoad(load, parent);
            const page = await loadPagedSimpleTableChildren({
              nodeId: parentId,
              connectionId: target.connectionId,
              database: target.database,
              querySchema,
              effectiveSchema,
              nonTableObjectTypes: [],
              offset: 0,
              pageSize,
              searchFilter: target.tableName,
              force: false,
            });
            if (!page.children.length) return false;
            const targetParent = treeNodeLoadTarget(load);
            if (!targetParent) return false;
            const currentChildren = withoutLoadMoreNodes(targetParent.children);
            const loadMoreNodes = (targetParent.children || []).filter((child) => child.type === "load-more");
            const mergedChildren = mergeLocatedTreeChildren(targetParent, currentChildren, page.children, target.connectionId, target.database);
            setChildren(targetParent, [...mergedChildren, ...loadMoreNodes]);
            targetParent.objectCount = Math.max(targetParent.objectCount ?? currentChildren.length, mergedChildren.length);
            targetParent.isExpanded = true;
            return true;
          } finally {
            finishTreeNodeLoad(load);
          }
        }

        const matchingGroups = findTreeNodes(treeNodes.value, (node) => {
          return (node.type === "group-tables" || node.type === "group-views" || node.type === "group-materialized-views") && node.connectionId === target.connectionId && sameSidebarObjectName(node.database, target.database) && (!target.schema || sameSidebarObjectName(node.schema, target.schema));
        });

        for (const group of matchingGroups) {
          const objectTypes = objectTypesForGroupNode(group.type);
          const parentNodeId = objectGroupRefreshParentId(group);
          if (!objectTypes || !parentNodeId) continue;

          let load = beginTreeNodeLoad(group);
          try {
            load = reclaimTreeNodeLoad(load, group);
            const page = await loadPagedTableGroupChildren({
              node: group,
              parentNodeId,
              querySchema,
              effectiveSchema,
              objectTypes,
              offset: 0,
              pageSize,
              searchFilter: target.tableName,
              force: false,
            });
            if (!page.children.length) continue;

            const targetGroup = treeNodeLoadTarget(load);
            if (!targetGroup) continue;
            const currentChildren = withoutLoadMoreNodes(targetGroup.children);
            const loadMoreNodes = (targetGroup.children || []).filter((child) => child.type === "load-more");
            const mergedChildren = mergeLocatedTreeChildren(targetGroup, currentChildren, page.children, target.connectionId, target.database);
            setChildren(targetGroup, [...mergedChildren, ...loadMoreNodes]);
            targetGroup.objectCount = Math.max(targetGroup.objectCount ?? currentChildren.length, mergedChildren.length);
            targetGroup.isExpanded = true;
            loaded = true;
          } finally {
            finishTreeNodeLoad(load);
          }
        }

        return loaded;
      },
    );
  }

  async function loadAllObjectGroupChildren(parent: TreeNode) {
    if (!parent.connectionId || !hasTreeNodeDatabaseContext(parent)) return;
    if (!objectTypesForGroupNode(parent.type)) return;
    let load = beginTreeNodeLoad(parent);
    try {
      await ensureConnected(parent.connectionId);
      load = reclaimTreeNodeLoad(load, parent);
      const liveParent = treeNodeLoadTarget(load);
      if (!liveParent) return;
      if (!isTreeNodeChildrenLoaded(liveParent.id)) {
        await loadObjectGroupChildren(liveParent);
      }
      if (!load.isCurrent()) return;

      let loadMoreNode = findTreeNodes(liveParent.children ?? [], (child) => child.type === "load-more")[0];
      while (loadMoreNode?.loadMore) {
        await loadMoreObjectGroupChildren(loadMoreNode);
        if (!load.isCurrent()) return;
        const currentParent = treeNodeLoadTarget(load);
        if (!currentParent) return;
        loadMoreNode = findTreeNodes(currentParent.children ?? [], (child) => child.type === "load-more")[0];
      }
      const finishedParent = treeNodeLoadTarget(load);
      if (finishedParent) finishedParent.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(parent.connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  function setSidebarTableSearchQuery(parentNodeId: string, query: string) {
    const normalized = query.trim();
    const next = { ...sidebarTableSearchQueries.value };
    if (normalized) {
      next[parentNodeId] = query;
    } else {
      delete next[parentNodeId];
    }
    sidebarTableSearchQueries.value = next;
  }

  async function refreshSidebarTableSearch(parentNodeId: string) {
    const parent = findNode(treeNodes.value, parentNodeId);
    if (!parent?.connectionId || !hasTreeNodeDatabaseContext(parent)) return;

    const searchFilter = sidebarTableSearchQueries.value[parentNodeId]?.trim() || "";
    const options: LoadTreeOptions = {
      force: true,
      searchFilter: searchFilter || undefined,
      sidebarTableSearchParentId: parentNodeId,
      expectedSidebarTableSearchQuery: searchFilter,
    };

    if (parent.type === "group-tables") {
      await loadObjectGroupChildren(parent, options);
      return;
    }

    if (parent.type === "database" || parent.type === "schema") {
      await loadTables(parent.connectionId, parent.database, parent.schema, options);
    }
  }

  function normalizedObjectTreeKind(type: string): DatabaseObjectTreeKind {
    return normalizeSidebarObjectKind(type);
  }

  async function loadTableGroups(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string, effectiveType?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}` : `${connectionId}:${database}:${table}`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;
    const resolvedType = effectiveType ?? node.type;
    let load = beginTreeNodeLoad(node);

    try {
      const children: TreeNode[] = [
        ...tablePartitionGroups(node),
        {
          id: `${parentId}:__columns`,
          label: "tree.columns",
          type: "group-columns",
          connectionId,
          database,
          schema,
          catalog,
          tableName: table,
          isExpanded: false,
          children: [],
        },
      ];

      const config = getConfig(connectionId);
      const effectiveDbType = effectiveDatabaseTypeForConnection(config);
      const metadataCapabilities = getTableMetadataCapabilities(effectiveDbType);
      load = reclaimTreeNodeLoad(load, node);
      if (resolvedType === "table") {
        if (metadataCapabilities.indexes) {
          children.push({
            id: `${parentId}:__indexes`,
            label: "tree.indexes",
            type: "group-indexes",
            connectionId,
            database,
            schema,
            catalog,
            tableName: table,
            isExpanded: false,
            children: [],
          });
        }
      }
      if (resolvedType === "table") {
        if (metadataCapabilities.foreignKeys) {
          children.push({
            id: `${parentId}:__fkeys`,
            label: "tree.foreignKeys",
            type: "group-fkeys",
            connectionId,
            database,
            schema,
            catalog,
            tableName: table,
            isExpanded: false,
            children: [],
          });
        }
        if (metadataCapabilities.triggers) {
          children.push({
            id: `${parentId}:__triggers`,
            label: "tree.triggers",
            type: "group-triggers",
            connectionId,
            database,
            schema,
            catalog,
            tableName: table,
            isExpanded: false,
            children: [],
          });
        }
      }

      if (isOpengaussFamilyConfig(config)) {
        if (resolvedType === "table" || resolvedType === "view" || resolvedType === "materialized_view") {
          const objectName = node.label === table ? node.label : table;
          const refType = resolvedType === "materialized_view" ? "materialized_view" : resolvedType;
          const canReference = resolvedType !== "table";
          children.push(...buildObjectReferenceGroupNodes(node, refType, objectName, "references", canReference));
          children.push(...buildObjectReferenceGroupNodes(node, refType, objectName, "referencedBy", true));
        }
      }
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(targetNode, children);
      targetNode.isExpanded = true;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  function isOpengaussFamilyConfig(config?: ConnectionConfig): boolean {
    if (!config) return false;
    const t = effectiveDatabaseTypeForConnection(config);
    return t === "opengauss";
  }

  /**
   * Build the "References" / "Referenced by" group nodes for an openGauss
   * object node. Tables, sequences and types expose only "Referenced by";
   * views, routines, packages and synonyms expose both sides.
   */
  function buildObjectReferenceGroupNodes(node: TreeNode, objectType: string, objectName: string, direction: "references" | "referencedBy", enabled: boolean): TreeNode[] {
    if (!enabled || !node.connectionId || !node.database) return [];
    const labelKey = direction === "references" ? "tree.references" : "tree.referencedBy";
    const nodeType = direction === "references" ? ("group-references" as const) : ("group-referenced-by" as const);
    const resolvedName = node.parentName && !objectName.includes(".") ? `${node.parentName}.${objectName}` : objectName;
    return [
      {
        id: `${node.id}:__${direction}`,
        label: labelKey,
        type: nodeType,
        referenceDirection: direction,
        referenceObjectType: objectType,
        objectName: resolvedName,
        connectionId: node.connectionId,
        database: node.database,
        schema: node.schema,
        isExpanded: false,
        children: [],
      },
    ];
  }

  /** Map an openGauss relkind to the backend object_type string. */
  function synonymTargetObjectType(relkind: string): string {
    switch (relkind) {
      case "r":
        return "table";
      case "v":
        return "view";
      case "m":
        return "materialized_view";
      case "S":
        return "sequence";
      case "f":
        return "function";
      case "p":
        return "procedure";
      default:
        return "table";
    }
  }

  /** Expand an openGauss synonym to its target object's table-style children. */
  async function loadSynonymGroups(connectionId: string, database: string, synonym: string, schema: string | undefined, node: TreeNode) {
    const querySchema = metadataQuerySchema(connectionId, database, schema);
    const target = await api.resolveSynonymTarget(connectionId, database, querySchema, synonym).catch(() => null);
    if (target && (target.targetKind === "r" || target.targetKind === "v" || target.targetKind === "m")) {
      // The target is a table/view/materialized view: reuse the table-style
      // child groups (columns/indexes/fks/triggers/partitions) then append the
      // synonym-level reference groups.
      await loadTableGroups(connectionId, database, target.targetName, target.targetSchema, node.id, undefined, synonymTargetObjectType(target.targetKind));
      const live = findNode(treeNodes.value, node.id);
      if (live) {
        live.children = [...(live.children ?? []), ...buildObjectReferenceGroupNodes(node, "synonym", synonym, "references", true)];
      }
      return;
    }
    const load = beginTreeNodeLoad(node);
    try {
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      const children: TreeNode[] = [...buildObjectReferenceGroupNodes(node, "synonym", synonym, "references", true)];
      if (target) {
        children.unshift({
          id: `${node.id}:__target`,
          label: `${target.targetSchema}.${target.targetName}`,
          type: "object-browser" as TreeNode["type"],
          connectionId,
          database,
          schema: target.targetSchema,
          tableName: target.targetName,
          targetSchema: target.targetSchema,
          targetName: target.targetName,
          targetKind: target.targetKind,
          isExpanded: false,
          comment: "synonym target",
        });
      }
      setChildren(targetNode, children);
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(node.connectionId!, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  /** Expand a TYPE node: list its attributes plus reference groups. */
  async function loadTypeGroups(connectionId: string, database: string, typeName: string, schema: string | undefined, node: TreeNode) {
    const load = beginTreeNodeLoad(node);
    try {
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const attributes = await api.listTypeAttributes(connectionId, database, querySchema, typeName).catch(() => [] as ColumnInfo[]);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      const attributeNode: TreeNode[] = attributes.map((attr) => ({
        id: `${node.id}:__attr:${attr.name}`,
        label: `${attr.name}: ${attr.data_type}${attr.is_nullable ? "" : " NOT NULL"}`,
        type: "column" as const,
        connectionId,
        database,
        schema,
        comment: attr.comment ?? null,
        meta: attr,
        isExpanded: false,
      }));
      setChildren(targetNode, [...attributeNode, ...buildObjectReferenceGroupNodes(node, "type", typeName, "referencedBy", true)]);
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(node.connectionId!, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  /** Expand a non-table object (sequence/function/procedure/package) into arguments/parameters and reference groups. */
  async function loadRoutineReferenceGroups(node: TreeNode, objectType: string, objectName: string) {
    const load = beginTreeNodeLoad(node);
    try {
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      const config = node.connectionId ? getConfig(node.connectionId) : undefined;
      const dbType = effectiveDatabaseTypeForConnection(config);

      let paramNodes: TreeNode[] = [];
      if (objectType === "procedure" || objectType === "function") {
        try {
          // 包内成员的参数查询必须带包名前缀（routineParameters 按 `包.成员` 识别）
          const routineName = node.parentName ? `${node.parentName}.${objectName}` : objectName;
          const rawParams = await loadRoutineParameters({
            connectionId: node.connectionId!,
            database: node.database!,
            databaseType: dbType,
            schema: node.schema,
            routineName,
            routineKind: objectType as "procedure" | "function",
            signature: node.signature,
          });
          paramNodes = rawParams.map((p) => ({
            id: `${node.id}:__arg:${p.ordinal}:${p.name}`,
            label: `${p.name || `arg_${p.ordinal}`}: ${p.dataType} (${p.mode})${p.hasDefault ? " = DEFAULT" : ""}`,
            type: "column" as const,
            connectionId: node.connectionId,
            database: node.database,
            schema: node.schema,
            isExpanded: false,
            // column 渲染路径（图标/拖拽/复制名）都会读 meta，必须补全
            meta: {
              name: p.name || `arg_${p.ordinal}`,
              data_type: p.dataType,
              is_nullable: true,
              column_default: null,
              is_primary_key: false,
              extra: p.mode,
              comment: null,
            },
          }));
        } catch (paramError) {
          // 参数加载失败不阻塞引用组展开，仅在日志可见
          console.warn("[sidebar] routine parameter load failed", paramError);
        }
      }

      // 引用组只有 openGauss 家族有后端支持（list_object_references 其他库返回空），
      // 非 openGauss 连接只展开参数，不显示两个永远为空的引用组。
      const isOpengaussFamily = isOpengaussFamilyConfig(config);
      const canReference = isOpengaussFamily && objectType !== "sequence" && objectType !== "type";
      setChildren(targetNode, [...paramNodes, ...buildObjectReferenceGroupNodes(node, objectType, objectName, "references", canReference), ...buildObjectReferenceGroupNodes(node, objectType, objectName, "referencedBy", isOpengaussFamily)]);
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(node.connectionId!, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  /**
   * Map a reference-result object_type (relkind char or the parsed kind) to a
   * tree node type so reference rows render with the right icon and label.
   */
  function referenceResultNodeType(objectType: string | undefined): TreeNode["type"] {
    switch ((objectType ?? "").toLowerCase()) {
      case "r":
      case "table":
      case "foreign_key":
      case "column":
        return "table";
      case "v":
      case "view":
        return "view";
      case "m":
      case "materialized_view":
        return "materialized_view";
      case "s":
      case "sequence":
        return "sequence";
      case "f":
      case "function":
        return "function";
      case "p":
      case "procedure":
        return "procedure";
      case "synonym_target":
      case "synonym":
        return "synonym";
      case "package":
        return "package";
      case "package_body":
        return "package-body";
      case "type":
      case "type_body":
        return "type";
      case "job":
        return "job";
      case "scheduler":
        return "scheduler";
      default:
        return "object-browser";
    }
  }

  /** Load the children of a References / Referenced-by group node. */
  async function loadReferenceGroupChildren(node: TreeNode) {
    if (!node.connectionId || !node.database || !node.objectName || !node.referenceObjectType || !node.referenceDirection) return;
    const load = beginTreeNodeLoad(node);
    try {
      const querySchema = metadataQuerySchema(node.connectionId, node.database, node.schema);
      const refs = await api.listObjectReferences(node.connectionId, node.database, querySchema, node.referenceObjectType, node.objectName, node.referenceDirection);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        refs.map((ref) => ({
          id: `${node.id}:${ref.schema}:${ref.name}:${ref.objectType}`,
          label: `${ref.schema}.${ref.name}${ref.detail ? ` (${ref.detail})` : ""}`,
          type: referenceResultNodeType(ref.objectType),
          connectionId: node.connectionId,
          database: node.database,
          schema: ref.schema,
          objectName: ref.name,
          tableName: ref.name,
          targetSchema: ref.schema,
          targetName: ref.name,
          targetKind: ref.objectType,
          isExpanded: false,
          comment: ref.objectType,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(node.connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  // OG Developer: expands an openGauss package node with its subprograms
  // (pg_proc.propackageid → gs_package). Children reuse function/procedure
  // node types so they render with the familiar icons.
  async function loadOpengaussPackageSubprograms(connectionId: string, database: string, packageName: string, schema: string | undefined, nodeId: string) {
    const node = findNode(treeNodes.value, nodeId);
    if (!node) return;

    const load = beginTreeNodeLoad(node);
    try {
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const subprograms = await api.listOpengaussPackageSubprograms(connectionId, database, querySchema, packageName);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      const subprogramNodes: TreeNode[] = subprograms.map((sub) => {
        const args = sub.arguments?.trim() ?? "";
        const objectType = sub.functionType?.toUpperCase().includes("PROC") ? "PROCEDURE" : "FUNCTION";
        return {
          id: `${nodeId}:${sub.name}:${args}:${objectType}`,
          label: args ? `${sub.name}(${args})` : sub.name,
          type: (objectType === "PROCEDURE" ? "procedure" : "function") as TreeNode["type"],
          objectName: sub.name,
          signature: args || undefined,
          connectionId,
          database,
          schema,
          parentName: packageName,
          isExpanded: false,
        };
      });

      const config = getConfig(connectionId);
      const isOpengaussFamily = isOpengaussFamilyConfig(config);
      const pkgType = node.type === "package-body" ? "package_body" : "package";
      const referenceGroups = [...buildObjectReferenceGroupNodes(node, pkgType, packageName, "references", isOpengaussFamily), ...buildObjectReferenceGroupNodes(node, pkgType, packageName, "referencedBy", isOpengaussFamily)];

      setChildren(targetNode, [...subprogramNodes, ...referenceGroups]);
      targetNode.isExpanded = true;
    } catch {
      // Older servers without the catalogs fail the query; keep the node a leaf.
      node.children = undefined;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadColumns(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__columns` : `${connectionId}:${database}:${table}:__columns`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    const load = beginTreeNodeLoad(node);
    try {
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const columns = await api.getColumns(connectionId, database, querySchema, table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        columns.map((col) => ({
          id: `${parentId}:${col.name}`,
          label: `${col.name} (${col.data_type})`,
          type: "column" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: col,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadIndexes(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__indexes` : `${connectionId}:${database}:${table}:__indexes`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    const load = beginTreeNodeLoad(node);
    try {
      const effectiveDbType = effectiveDatabaseTypeForConnection(getConfig(connectionId));
      const metadataCapabilities = getTableMetadataCapabilities(effectiveDbType);
      if (!metadataCapabilities.indexes) {
        const targetNode = treeNodeLoadTarget(load);
        if (!targetNode) return;
        setChildren(targetNode, []);
        targetNode.isExpanded = true;
        return;
      }
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const indexes = await api.listIndexes(connectionId, database, querySchema, table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        indexes.map((idx) => ({
          id: `${parentId}:${idx.name}`,
          label: `${idx.name} (${idx.columns.join(", ")})`,
          type: "index" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: idx,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadForeignKeys(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__fkeys` : `${connectionId}:${database}:${table}:__fkeys`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    const load = beginTreeNodeLoad(node);
    try {
      const metadataCapabilities = getTableMetadataCapabilities(effectiveDatabaseTypeForConnection(getConfig(connectionId)));
      if (!metadataCapabilities.foreignKeys) {
        const targetNode = treeNodeLoadTarget(load);
        if (!targetNode) return;
        setChildren(targetNode, []);
        targetNode.isExpanded = true;
        return;
      }
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const fkeys = await api.listForeignKeys(connectionId, database, querySchema, table, catalog);
      const cacheKey = `${connectionId}:${database}:${schema || ""}:${table}`;
      completionForeignKeysCache.value[cacheKey] = fkeys;
      evictOldestCacheEntries(completionForeignKeysCache.value, COMPLETION_CACHE_MAX);
      indexCompletionForeignKeys(connectionId, database, table, schema, sqlCompletionForeignKeys(fkeys));
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        fkeys.map((fk) => ({
          id: `${parentId}:${fk.name}`,
          label: `${fk.column} → ${fk.ref_table}.${fk.ref_column}`,
          type: "fkey" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: fk,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadTriggers(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__triggers` : `${connectionId}:${database}:${table}:__triggers`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    const load = beginTreeNodeLoad(node);
    try {
      const metadataCapabilities = getTableMetadataCapabilities(effectiveDatabaseTypeForConnection(getConfig(connectionId)));
      if (!metadataCapabilities.triggers) {
        const targetNode = treeNodeLoadTarget(load);
        if (!targetNode) return;
        setChildren(targetNode, []);
        targetNode.isExpanded = true;
        return;
      }
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const triggers = await api.listTriggers(connectionId, database, querySchema, table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        triggers.map((tr) => ({
          id: `${parentId}:${tr.name}`,
          label: `${tr.name} (${tr.timing} ${tr.event})`,
          objectName: tr.name,
          type: "trigger" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: tr,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadConstraints(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? `${connectionId}:${database}:${schema || ""}:${table}:__constraints`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;
    const load = beginTreeNodeLoad(node);
    try {
      const constraints = await api.listConstraints(connectionId, database, metadataQuerySchema(connectionId, database, schema), table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        constraints.map((constraint) => ({
          id: `${parentId}:${constraint.name}`,
          label: `${constraint.name} (${constraint.constraint_type})${constraint.valid ? "" : " · INVALID"}`,
          type: "constraint" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: constraint,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadPartitions(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? `${connectionId}:${database}:${schema || ""}:${table}:__table-partitions`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;
    const load = beginTreeNodeLoad(node);
    try {
      const partitions = await api.listPartitions(connectionId, database, metadataQuerySchema(connectionId, database, schema), table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        partitions.map((partition) => ({
          id: `${parentId}:${partition.name}`,
          label: `${partition.name} (${partition.partition_type}${partition.value ? `: ${partition.value}` : ""})`,
          type: "partition" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: partition,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadSubpartitions(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? `${connectionId}:${database}:${schema || ""}:${table}:__table-subpartitions`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;
    const load = beginTreeNodeLoad(node);
    try {
      const partitions = await api.listSubpartitions(connectionId, database, metadataQuerySchema(connectionId, database, schema), table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        partitions.map((partition) => ({
          id: `${parentId}:${partition.name}`,
          label: `${partition.name} (${partition.partition_type}${partition.value ? `: ${partition.value}` : ""})`,
          type: "subpartition" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: partition,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  function collectExpandedNodeIds(nodes: TreeNode[], ids = new Set<string>()): Set<string> {
    for (const node of nodes) {
      if (node.isExpanded) ids.add(node.id);
      if (node.children) collectExpandedNodeIds(node.children, ids);
    }
    return ids;
  }

  async function loadTreeNodeChildren(node: TreeNode, options?: LoadTreeOptions) {
    if (node.type === "connection" && node.connectionId) {
      await loadDatabases(node.connectionId, options);
    } else if (node.type === "database" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      const config = getConfig(node.connectionId);
      const effectiveDbType = effectiveDatabaseTypeForConnection(config);
      if ((usesTreeSchemaMode(effectiveDbType) && !connectionUsesDatabaseObjectTreeMode(config)) || connectionShouldDiscoverJdbcSchemas(config)) {
        await loadSchemas(node.connectionId, node.database, options);
      } else {
        await loadTables(node.connectionId, node.database, undefined, options);
      }
    } else if (node.type === "schema" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.schema) {
      await loadTables(node.connectionId, node.database, node.schema, options);
    } else if ((node.type === "table" || node.type === "view" || node.type === "materialized_view") && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await loadTableGroups(node.connectionId, node.database, node.label, node.schema, node.id, node.catalog);
    } else if (node.type === "group-columns" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadColumns(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-indexes" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadIndexes(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-fkeys" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadForeignKeys(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-triggers" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadTriggers(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-constraints" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadConstraints(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-table-partitions" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadPartitions(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-table-subpartitions" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadSubpartitions(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if ((node.type === "package" || node.type === "package-body") && node.connectionId && hasTreeNodeDatabaseContext(node) && node.objectName) {
      await loadOpengaussPackageSubprograms(node.connectionId, node.database, node.objectName, node.schema, node.id);
    } else if (objectTypesForGroupNode(node.type)) {
      await loadObjectGroupChildren(node, options);
    } else if (node.type === "group-partitions") {
      node.isExpanded = true;
    } else if (node.type === "group-extensions" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await loadExtensions(node.connectionId, node.database || "");
    } else if ((node.type === "group-references" || node.type === "group-referenced-by") && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await loadReferenceGroupChildren(node);
    } else if (node.type === "synonym" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await loadSynonymGroups(node.connectionId, node.database, node.label, node.schema, node);
    } else if (node.type === "type" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await loadTypeGroups(node.connectionId, node.database, node.label, node.schema, node);
    } else if ((node.type === "sequence" || node.type === "function" || node.type === "procedure") && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await loadRoutineReferenceGroups(node, node.type, node.objectName || node.label);
    }
  }

  async function restoreExpandedChildren(node: TreeNode, expandedIds: Set<string>, options?: LoadTreeOptions, isCurrent: () => boolean = () => true) {
    if (!isCurrent()) return;
    if (!node.children) return;
    for (const child of node.children) {
      if (!isCurrent()) return;
      if (!expandedIds.has(child.id)) continue;
      await loadTreeNodeChildren(child, options);
      if (!isCurrent()) return;
      await restoreExpandedChildren(child, expandedIds, options, isCurrent);
    }
  }

  async function refreshTreeNode(node: TreeNode) {
    invalidateMetadataCachesForNode(node);
    if (objectTypesForGroupNode(node.type)) {
      clearLoadedChildrenCache(node.id, { deletePersisted: false });
      await loadObjectGroupChildren(node, { force: true });
      return;
    }

    const parentId = objectGroupRefreshParentId(node);
    const parentNode = parentId ? findNode(treeNodes.value, parentId) : null;
    if (parentNode) {
      await refreshTreeNode(parentNode);
      return;
    }

    if (node.connectionId && !connectedIds.value.has(node.connectionId)) return;
    const expandedIds = collectExpandedNodeIds([node]);
    expandedIds.add(node.id);
    const previousChildren = node.children;
    const previousHiddenChildren = node.hiddenChildren;
    const previousObjectCount = node.objectCount;
    const previousExpanded = node.isExpanded;
    const previousLoadedIds = [...loadedTreeNodeChildrenIds.value].filter((id) => id === node.id || id.startsWith(`${node.id}:`));
    const previousConfirmedEmptyIds = [...confirmedEmptyTreeNodeIds.value].filter((id) => id === node.id || id.startsWith(`${node.id}:`));
    const connectionRevision = node.connectionId ? connectionStateRevision(node.connectionId) : undefined;
    const refreshGeneration = ++nextTreeRefreshGeneration;
    activeTreeRefreshGenerations.set(node.id, refreshGeneration);
    const ownsRefreshGeneration = () => activeTreeRefreshGenerations.get(node.id) === refreshGeneration;
    const isCurrentRefresh = () => ownsRefreshGeneration() && (!node.connectionId || connectionStateRevision(node.connectionId) === connectionRevision);
    try {
      await clearPersistedTreeCacheForNode(node);
      if (!isCurrentRefresh()) return;
      clearLoadedChildrenCache(node.id);
      if (node.type !== "connection-group") {
        node.children = [];
      }
      await loadTreeNodeChildren(node, { force: true });
      if (isCurrentRefresh()) {
        await restoreExpandedChildren(node, expandedIds, { force: true }, isCurrentRefresh);
      }
    } catch (error) {
      // A stale failure must never overwrite a newer successful (including empty) result.
      if (isCurrentRefresh()) {
        const target = treeNodeInSidebarTree(node);
        if (target) {
          target.children = previousChildren;
          target.hiddenChildren = previousHiddenChildren;
          target.objectCount = previousObjectCount;
          target.isExpanded = previousExpanded;
          clearLoadedChildrenCache(target.id, { deletePersisted: false });
          for (const id of previousLoadedIds) loadedTreeNodeChildrenIds.value.add(id);
          for (const id of previousConfirmedEmptyIds) confirmedEmptyTreeNodeIds.value.add(id);
        }
      }
      throw error;
    } finally {
      if (ownsRefreshGeneration()) {
        activeTreeRefreshGenerations.delete(node.id);
      }
    }
  }

  async function refreshTreeNodeForTableNameFilter(node: TreeNode, scopeKey: string, revision: number) {
    invalidateMetadataCachesForNode(node);
    if (objectTypesForGroupNode(node.type)) {
      clearLoadedChildrenCache(node.id);
      await loadObjectGroupChildren(node, {
        force: true,
        tableNameFilterScopeKey: scopeKey,
        expectedTableNameFilterRevision: revision,
      });
      return;
    }
    await refreshTreeNode(node);
  }

  async function refreshDatabaseTreeNode(connectionId: string, database: string, catalog?: string) {
    const node = findDatabaseTreeNode(treeNodes.value, connectionId, database, catalog);
    if (node) {
      await refreshTreeNode(node);
      return;
    }
    await loadDatabases(connectionId, { force: true });
  }

  async function refreshObjectListTreeNode(connectionId: string, database: string, schema?: string, catalog?: string) {
    const match = { connectionId, database, schema };
    invalidateMetadataCaches(match);
    void invalidateObjectDdlCache(match);
    const shouldRefreshSchemaNode = !!schema && !catalog;
    const node = shouldRefreshSchemaNode ? findNode(treeNodes.value, `${connectionId}:${database}:${schema}`) : null;
    if (node) {
      await refreshTreeNode(node);
    } else {
      await refreshDatabaseTreeNode(connectionId, database, catalog);
    }
    void loadSidebarTableStorage({ connectionId, database, schema: schema || "" }, { force: true });
  }

  function isSchemaAwareDatabase(connectionId: string): boolean {
    return isSchemaAware(getConfig(connectionId)?.db_type);
  }

  function isPostgresLikeForExtensions(dbType?: string): boolean {
    return dbType === "postgres" || dbType === "opengauss" || dbType === "jdbc";
  }

  function metadataQuerySchema(connectionId: string, database: string, schema?: string): string {
    return connectionObjectTreeQuerySchema(getConfig(connectionId), database, schema);
  }

  const COMPLETION_CACHE_MAX = 50;

  function evictOldestCacheEntries(cache: Record<string, unknown>, max: number) {
    const keys = Object.keys(cache);
    if (keys.length <= max) return;
    const toRemove = keys.slice(0, keys.length - max);
    for (const key of toRemove) {
      delete cache[key];
    }
  }

  function completionScopeKey(connectionId: string, database: string, schema?: string): string {
    return `${connectionId}:${database}:${schema?.toLowerCase() ?? ""}`;
  }

  function completionTableScopeKey(connectionId: string, database: string, schema?: string, catalog?: string): string {
    return `${connectionId}:${database}:${catalog?.toLowerCase() ?? ""}:${schema?.toLowerCase() ?? ""}`;
  }

  function completionColumnsKey(connectionId: string, database: string, table: string, schema?: string, catalog?: string): string {
    return `${completionTableScopeKey(connectionId, database, schema, catalog)}:${table.toLowerCase()}`;
  }

  function completionForeignKeysKey(connectionId: string, database: string, table: string, schema?: string): string {
    return `${completionScopeKey(connectionId, database, schema)}:${table.toLowerCase()}:fkeys`;
  }

  function completionTableCacheKeyMatches(key: string, connectionId: string, database: string, tableName: string, schema?: string, catalog?: string): boolean {
    const normalizedKey = key.toLowerCase();
    const prefix = `${connectionId}:${database}:`.toLowerCase();
    if (!normalizedKey.startsWith(prefix)) return false;
    const tableToken = `:${tableName.toLowerCase()}`;
    const tableOffset = normalizedKey.lastIndexOf(tableToken);
    if (tableOffset < prefix.length) return false;
    const trailing = normalizedKey.slice(tableOffset + tableToken.length);
    if (trailing && !trailing.startsWith(":")) return false;
    const normalizedSchema = schema?.trim().toLowerCase();
    const normalizedCatalog = catalog?.trim().toLowerCase();
    const scope = normalizedKey.slice(prefix.length, tableOffset);
    if (normalizedCatalog) {
      const catalogScope = `${normalizedCatalog}:${normalizedSchema ?? ""}`;
      return scope === catalogScope || (!!normalizedSchema && scope === normalizedSchema);
    }
    if (!normalizedSchema) return true;
    return scope === normalizedSchema || scope.endsWith(`:${normalizedSchema}`);
  }

  function invalidateCompletionTableCache(connectionId: string, database: string, tableName: string, schema?: string, catalog?: string): number {
    const matches = (key: string) => completionTableCacheKeyMatches(key, connectionId, database, tableName, schema, catalog);
    let removed = 0;
    for (const cache of [completionColumnsCache.value, completionForeignKeysCache.value]) {
      for (const key of Object.keys(cache)) {
        if (!matches(key)) continue;
        delete cache[key];
        removed++;
      }
    }
    for (const cache of [completionColumnIndex, completionForeignKeyIndex, completionInFlight]) {
      for (const key of cache.keys()) {
        if (!matches(key)) continue;
        cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  function touchCompletionIndex<T>(index: Map<string, { touched: number } & T>, key: string, value: T, max = COMPLETION_CACHE_MAX) {
    index.set(key, { ...value, touched: Date.now() });
    if (index.size <= max) return;
    const oldest = [...index.entries()].sort(([, a], [, b]) => a.touched - b.touched).slice(0, index.size - max);
    for (const [oldKey] of oldest) index.delete(oldKey);
  }

  function completionLimiterScope(connectionId: string, database = ""): string {
    return `${connectionId}:${database}`;
  }

  function withCompletionInFlight<T>(key: string, load: () => Promise<T>, limit?: { scope: string; kind: string }): Promise<T> {
    const existing = completionInFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = (limit ? completionMetadataLimiter.run(limit.scope, limit.kind, load) : load()).finally(() => {
      if (completionInFlight.get(key) === promise) completionInFlight.delete(key);
    });
    completionInFlight.set(key, promise);
    return promise;
  }

  function completionAssistantRequestKey(request: CompletionAssistantRequest): string {
    return JSON.stringify({
      connection_id: request.connection_id,
      database: request.database,
      schema: request.schema ?? "",
      object_kinds: [...(request.object_kinds ?? [])].sort(),
      mask: request.mask ?? "",
      case_sensitive: !!request.case_sensitive,
      global_search: !!request.global_search,
      max_results: request.max_results ?? null,
      search_in_comments: !!request.search_in_comments,
      search_in_definitions: !!request.search_in_definitions,
      parent_schema: request.parent_schema ?? "",
      parent_name: request.parent_name ?? "",
      match_mode: request.match_mode ?? "prefix",
    });
  }

  async function completionAssistantSearch(request: CompletionAssistantRequest) {
    return withCompletionInFlight(`assistant:${completionAssistantRequestKey(request)}`, async () => {
      await ensureConnected(request.connection_id);
      return api.completionAssistantSearch(request);
    });
  }

  const ORACLE_SYSTEM_COMPLETION_SCHEMAS = new Set(["SYS", "SYSTEM", "SYSMAN", "DBSNMP", "OUTLN", "XDB", "MDSYS", "CTXSYS", "WMSYS"]);
  const FILTERED_ROUTINE_COMPLETION_DATABASES = new Set<DatabaseType>(["opengauss", "postgres", "jdbc"]);

  function completionCandidateSchemaBoost(schema: string | null | undefined, preferredSchema?: string): number {
    if (schema && preferredSchema && schema.toLowerCase() === preferredSchema.toLowerCase()) return 2400;
    if (schema?.toUpperCase() === "PUBLIC") return 1200;
    if (schema && ORACLE_SYSTEM_COMPLETION_SCHEMAS.has(schema.toUpperCase())) return -1200;
    return 0;
  }

  function completionCandidateApplyName(name: string, schema: string | null | undefined, preferredSchema?: string): string {
    if (!schema || schema.toUpperCase() === "PUBLIC" || (preferredSchema && schema.toLowerCase() === preferredSchema.toLowerCase())) return name;
    return `${schema}.${name}`;
  }

  function completionAssistantTables(candidates: CompletionAssistantCandidate[], preferredSchema?: string, withOracleMetadata = false): SqlCompletionTable[] {
    return candidates
      .filter((candidate) => candidate.kind === "table" || candidate.kind === "view")
      .map((candidate) => {
        const table: SqlCompletionTable = {
          name: candidate.name,
          schema: candidate.schema ?? undefined,
          type: sqlObjectNavigationTypeFromTableType(candidate.data_type || candidate.kind),
        };
        if (!withOracleMetadata) return table;
        return {
          ...table,
          detail: candidate.schema ? `${candidate.schema} · ${(candidate.data_type || candidate.kind).toLowerCase()}` : candidate.kind,
          applyName: completionCandidateApplyName(candidate.name, candidate.schema, preferredSchema),
          boost: completionCandidateSchemaBoost(candidate.schema, preferredSchema),
        };
      });
  }

  function completionAssistantObjects(candidates: CompletionAssistantCandidate[], preferredSchema?: string, oracleMetadata = false): SqlCompletionObject[] {
    return candidates
      .map((candidate): SqlCompletionObject | null => {
        const candidateType = candidate.data_type?.toUpperCase();
        const type = candidate.kind === "procedure" ? "procedure" : candidate.kind === "function" ? "function" : candidate.kind === "object" && candidateType === "PACKAGE" ? "package" : null;
        if (!type) return null;
        const dataType = candidate.data_type && !["FUNCTION", "PROCEDURE", "PACKAGE"].includes(candidateType ?? "") ? candidate.data_type : undefined;
        return {
          name: candidate.name,
          schema: candidate.schema ?? undefined,
          type,
          parentSchema: candidate.parent_schema ?? undefined,
          parentName: candidate.parent_name ?? undefined,
          dataType,
          signature: candidate.signature ?? undefined,
          comment: candidate.comment ?? null,
          applyName: completionCandidateApplyName(candidate.name, candidate.schema, preferredSchema),
          boost: oracleMetadata ? completionCandidateSchemaBoost(candidate.schema, preferredSchema) : completionRoutineSchemaBoost(candidate.schema, preferredSchema),
        };
      })
      .filter((object): object is SqlCompletionObject => object != null);
  }

  function completionRoutineSchemaBoost(schema: string | null | undefined, preferredSchema?: string): number {
    if (schema && preferredSchema && schema.toLowerCase() === preferredSchema.toLowerCase()) return 1000;
    if (schema?.toUpperCase() === "PUBLIC") return 600;
    return 0;
  }

  function completionAssistantIdentifierMatches(candidate: string, requested: string, quoted?: boolean): boolean {
    return quoted ? candidate === requested : candidate.toLowerCase() === requested.toLowerCase();
  }

  function completionAssistantColumns(candidates: CompletionAssistantCandidate[], table: string, schema?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }): SqlCompletionColumn[] {
    const requestedSchema = schema?.trim();
    return candidates
      .filter((candidate) => {
        if (candidate.kind !== "column") return false;
        const parentName = candidate.parent_name?.trim();
        if (parentName && !completionAssistantIdentifierMatches(parentName, table, context?.tableQuoted)) return false;
        const parentSchema = candidate.parent_schema?.trim() || candidate.schema?.trim();
        if (requestedSchema && parentSchema && !completionAssistantIdentifierMatches(parentSchema, requestedSchema, context?.schemaQuoted)) return false;
        return true;
      })
      .map((candidate) => ({
        name: candidate.name,
        table: candidate.parent_name ?? table,
        schema: candidate.parent_schema ?? candidate.schema ?? schema,
        dataType: candidate.data_type ?? undefined,
        comment: candidate.comment ?? null,
      }));
  }

  async function listCompletionAssistantTables(connectionId: string, database: string, filter: string, limit?: number, schema?: string, globalSearch = false): Promise<SqlCompletionTable[]> {
    const preferredSchema = schema?.trim() || undefined;
    const objectKinds: CompletionAssistantObjectKind[] = ["table", "view"];
    const response = await completionAssistantSearch({
      connection_id: connectionId,
      database,
      schema: preferredSchema ?? null,
      object_kinds: objectKinds,
      mask: filter.trim(),
      max_results: limit ?? 200,
      global_search: globalSearch,
      parent_schema: globalSearch ? null : (schema ?? null),
      match_mode: "prefix",
    });
    const tables = completionAssistantTables(response.candidates, preferredSchema, false);
    indexCompletionTables(connectionId, database, schema, tables);
    return tables;
  }

  async function listCompletionAssistantObjects(
    connectionId: string,
    database: string,
    filter: string,
    limit: number | undefined,
    schema: string | undefined,
    parentName: string | undefined,
    globalSearch: boolean,
    currentSchema: string | undefined,
    objectKinds: CompletionAssistantObjectKind[],
  ): Promise<SqlCompletionObject[]> {
    const requestedSchema = schema?.trim() || currentSchema?.trim() || undefined;
    const preferredSchema = requestedSchema || "public";
    const response = await completionAssistantSearch({
      connection_id: connectionId,
      database,
      schema: requestedSchema ?? null,
      object_kinds: objectKinds,
      mask: filter.trim(),
      max_results: limit ?? 200,
      global_search: globalSearch,
      parent_schema: globalSearch ? null : (schema ?? null),
      parent_name: parentName ?? null,
      match_mode: "prefix",
    });
    const objects = completionAssistantObjects(response.candidates, preferredSchema, false).map((object) => ({
      ...object,
      applyName: object.applyName,
    }));
    indexCompletionObjects(connectionId, database, schema, objects);
    return objects;
  }

  async function listCompletionAssistantColumns(connectionId: string, database: string, table: string, schema?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }): Promise<SqlCompletionColumn[]> {
    const response = await completionAssistantSearch({
      connection_id: connectionId,
      database,
      schema: schema ?? null,
      object_kinds: ["column"],
      mask: "",
      max_results: 500,
      parent_schema: schema ?? null,
      parent_name: table,
      match_mode: "prefix",
    });
    const columns = completionAssistantColumns(response.candidates, table, schema, context);
    if (columns.length > 0) indexCompletionColumns(connectionId, database, table, schema, columns);
    return columns;
  }

  function completionNameSegments(name: string): string[] {
    return name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[\s_.:-]+/)
      .map((segment) => segment.trim().toLowerCase())
      .filter(Boolean);
  }

  function completionNameAcronym(name: string): string {
    return completionNameSegments(name)
      .map((segment) => segment[0])
      .join("");
  }

  function orderedSubsequenceScore(text: string, filter: string): number {
    let index = 0;
    let gaps = 0;
    for (const ch of filter) {
      const found = text.indexOf(ch, index);
      if (found < 0) return -1;
      gaps += found - index;
      index = found + 1;
    }
    return 1_000 - gaps - text.length;
  }

  function tableMatchScore(table: SqlCompletionTable, filter: string, preferredSchema?: string): number {
    const text = table.name.toLowerCase();
    const schema = table.schema?.toLowerCase();
    const normalized = filter.trim().toLowerCase();
    let score = schema && preferredSchema && schema === preferredSchema.toLowerCase() ? 10_000 : 0;
    if (!normalized) return score;
    if (text === normalized) return score + 9_000 - text.length;
    if (text.startsWith(normalized)) return score + 7_500 - text.length;
    const segments = completionNameSegments(table.name);
    if (segments.some((segment) => segment.startsWith(normalized))) return score + 7_200 - text.length;
    const acronym = completionNameAcronym(table.name);
    if (acronym === normalized) return score + 7_100 - text.length;
    if (acronym.startsWith(normalized)) return score + 6_900 - text.length;
    // DataGrip-style pinyin initials for Han names, e.g. "zzj" → 总租金,
    // including ordered subsequences like "zj" → 总租金.
    if (/^[a-z0-9]+$/.test(normalized) && containsHan(text)) {
      const pinyinInitials = pinyinFirstLetters(text);
      if (pinyinInitials === normalized) return score + 7_050 - text.length;
      if (pinyinInitials.startsWith(normalized)) return score + 6_850 - text.length;
      const subsequence = orderedSubsequenceSpan(pinyinInitials, normalized);
      if (subsequence) return score + 5_000 - subsequence.first * 30 - subsequence.span * 10 - text.length;
    }
    if (normalized.length <= segments.length && segments.every((segment, index) => segment.startsWith(normalized[index] ?? ""))) return score + 6_700 - text.length;
    if (text.includes(normalized)) return score + 4_000 - text.length;
    const subsequenceScore = orderedSubsequenceScore(text, normalized);
    return subsequenceScore < 0 ? -1 : score + subsequenceScore;
  }

  function objectMatchScore(object: SqlCompletionObject, filter: string, preferredSchema?: string): number {
    const tableLike: SqlCompletionTable = { name: object.name, schema: object.schema };
    return tableMatchScore(tableLike, filter, preferredSchema);
  }

  function indexCompletionTables(connectionId: string, database: string, schema: string | undefined, tables: SqlCompletionTable[], catalog?: string) {
    const groups = new Map<string, SqlCompletionTable[]>();
    for (const table of tables) {
      const tableSchema = table.schema ?? schema;
      const tableCatalog = table.catalog ?? catalog;
      const key = completionTableScopeKey(connectionId, database, tableSchema, tableCatalog);
      const list = groups.get(key) ?? [];
      list.push({ ...table, catalog: tableCatalog, schema: tableSchema });
      groups.set(key, list);
    }
    for (const [key, group] of groups) {
      const previous = completionTableIndex.get(key)?.tables ?? [];
      touchCompletionIndex(completionTableIndex, key, {
        tables: dedupeCompletionTables([...previous, ...group]),
      });
    }
  }

  function indexCompletionObjects(connectionId: string, database: string, schema: string | undefined, objects: SqlCompletionObject[]) {
    const groups = new Map<string, SqlCompletionObject[]>();
    for (const object of objects) {
      const objectSchema = object.schema ?? schema;
      const key = completionScopeKey(connectionId, database, objectSchema);
      const list = groups.get(key) ?? [];
      list.push({ ...object, schema: objectSchema });
      groups.set(key, list);
    }
    for (const [key, group] of groups) {
      const previous = completionObjectIndex.get(key)?.objects ?? [];
      touchCompletionIndex(completionObjectIndex, key, {
        objects: dedupeCompletionObjects([...previous, ...group]),
      });
    }
  }

  function indexCompletionColumns(connectionId: string, database: string, table: string, schema: string | undefined, columns: SqlCompletionColumn[], catalog?: string) {
    touchCompletionIndex(completionColumnIndex, completionColumnsKey(connectionId, database, table, schema, catalog), {
      columns,
    });
  }

  function sqlCompletionForeignKeys(foreignKeys: ForeignKeyInfo[]): SqlCompletionForeignKey[] {
    return foreignKeys.map((foreignKey) => ({
      name: foreignKey.name,
      column: foreignKey.column,
      ref_schema: foreignKey.ref_schema,
      ref_table: foreignKey.ref_table,
      ref_column: foreignKey.ref_column,
    }));
  }

  function indexCompletionForeignKeys(connectionId: string, database: string, table: string, schema: string | undefined, foreignKeys: SqlCompletionForeignKey[]) {
    touchCompletionIndex(completionForeignKeyIndex, completionForeignKeysKey(connectionId, database, table, schema), {
      foreignKeys,
    });
  }

  function lookupLocalCompletionTables(connectionId: string, database: string, filter = "", limit?: number, schema?: string, catalog?: string): SqlCompletionTable[] {
    const scopePrefix = `${connectionId}:${database}:${catalog?.toLowerCase() ?? ""}:`;
    const allScopes = [...completionTableIndex.entries()].filter(([key]) => key.startsWith(scopePrefix)).map(([, entry]) => entry);
    const preferred = schema ? completionTableIndex.get(completionTableScopeKey(connectionId, database, schema, catalog)) : undefined;
    const scopes = schema ? (preferred ? [preferred] : []) : allScopes;
    const treeTables = completionTablesFromTree(treeNodes.value, connectionId, database, schema, catalog);
    const ranked = scopes
      .flatMap((entry) => entry?.tables ?? [])
      .concat(treeTables)
      .map((table) => ({ table, score: tableMatchScore(table, filter, schema) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name));
    return dedupeCompletionTables(ranked.map((entry) => entry.table)).slice(0, limit ?? 200);
  }

  function lookupLocalCompletionObjects(connectionId: string, database: string, filter = "", limit?: number, schema?: string): SqlCompletionObject[] {
    const allScopes = [...completionObjectIndex.entries()].filter(([key]) => key.startsWith(`${connectionId}:${database}:`)).map(([, entry]) => entry);
    const preferred = schema ? completionObjectIndex.get(completionScopeKey(connectionId, database, schema)) : undefined;
    const scopes = schema ? (preferred ? [preferred] : []) : allScopes;
    const ranked = scopes
      .flatMap((entry) => entry?.objects ?? [])
      .map((object) => ({ object, score: objectMatchScore(object, filter, schema) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.object.name.localeCompare(b.object.name));
    return dedupeCompletionObjects(ranked.map((entry) => entry.object)).slice(0, limit ?? 200);
  }

  function lookupLocalCompletionSchemas(connectionId: string, database: string, filter = "", limit = 50): string[] {
    const schemas = dedupeCompletionQualifierNames([...(schemaListCache.value[`${connectionId}:${database}`] ?? []), ...completionSchemasFromTree(treeNodes.value, connectionId, database)]);
    const normalized = filter.trim().toLowerCase();
    return schemas
      .filter((schema) => fuzzyTextMatch(schema, normalized))
      .sort((a, b) => tableMatchScore({ name: b }, normalized) - tableMatchScore({ name: a }, normalized))
      .slice(0, limit);
  }

  function lookupLocalCompletionDatabases(connectionId: string, filter = "", limit = 50): string[] {
    const databases = completionDatabasesCache.value[connectionId] ?? databaseNamesFromTree(connectionId);
    const normalized = filter.trim().toLowerCase();
    return databases
      .filter((database) => fuzzyTextMatch(database, normalized))
      .sort((a, b) => tableMatchScore({ name: b }, normalized) - tableMatchScore({ name: a }, normalized))
      .slice(0, limit);
  }

  function dedupeCompletionQualifierNames(names: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of names) {
      const normalized = name.trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
    return result;
  }

  function lookupLocalCompletionColumns(connectionId: string, database: string, table: string, schema?: string, catalog?: string): SqlCompletionColumn[] {
    return completionColumnIndex.get(completionColumnsKey(connectionId, database, table, schema, catalog))?.columns ?? [];
  }

  function lookupLocalCompletionForeignKeys(connectionId: string, database: string, table: string, schema?: string): SqlCompletionForeignKey[] {
    return completionForeignKeyIndex.get(completionForeignKeysKey(connectionId, database, table, schema))?.foreignKeys ?? [];
  }

  function databaseNamesFromTree(connectionId: string): string[] {
    const node = findConnectionNode(connectionId);
    if (!node?.children) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const child of node.children) {
      if (child.type !== "database" || !child.database) continue;
      const key = child.database.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(child.database);
    }
    return names;
  }

  async function listCompletionDatabases(connectionId: string): Promise<string[]> {
    if (completionDatabasesCache.value[connectionId]) {
      return completionDatabasesCache.value[connectionId];
    }
    return withCompletionInFlight(
      `${connectionId}:completion-databases`,
      async () => {
        await ensureConnected(connectionId);
        const config = getConfig(connectionId);
        const databases = await api.listDatabases(connectionId);
        completionDatabasesCache.value[connectionId] = filterDatabaseNamesForConnection(
          databases.map((database) => database.name),
          config,
        );
        evictOldestCacheEntries(completionDatabasesCache.value, COMPLETION_CACHE_MAX);
        return completionDatabasesCache.value[connectionId];
      },
      { scope: completionLimiterScope(connectionId), kind: "databases" },
    );
  }

  async function listCompletionSchemas(connectionId: string, database: string): Promise<string[]> {
    const cacheKey = `${connectionId}:${database}`;
    if (schemaListCache.value[cacheKey]) {
      return schemaListCache.value[cacheKey];
    }
    return withCompletionInFlight(`${cacheKey}:schemas`, async () => {
      const schemas = await api.listSchemas(connectionId, database);
      schemaListCache.value[cacheKey] = schemas;
      evictOldestCacheEntries(schemaListCache.value, COMPLETION_CACHE_MAX);
      return schemas;
    });
  }

  function listCompletionTableMetadata(connectionId: string, database: string, schema: string, filter?: string, limit?: number, catalog?: string): Promise<TableInfo[]> {
    if (catalog) return api.listTables(connectionId, database, schema, filter, limit, undefined, undefined, catalog);
    return api.listTables(connectionId, database, schema, filter, limit);
  }

  async function listCompletionTables(connectionId: string, database: string, filter = "", limit?: number, schema?: string, globalSearch = false, currentSchema?: string, catalog?: string, options: { activateConnection?: boolean } = {}): Promise<SqlCompletionTable[]> {
    const trimmedFilter = filter.trim();
    const normalizedFilter = trimmedFilter.toLowerCase();
    // Remote queries (Dameng/Oracle) are case-sensitive, so the cache key must
    // preserve original casing — otherwise "TEST" and "test" collide and the
    // second lookup returns the first's stale results. Local lookups below stay
    // case-insensitive because tableMatchScore normalizes internally.
    const relaxedFilter = relaxedCompletionTableFilter(trimmedFilter);
    const cacheKey = `${connectionId}:${database}:${catalog ?? ""}:${trimmedFilter}:${limit ?? ""}:${schema ?? ""}:${globalSearch ? "global" : "scoped"}:${currentSchema ?? ""}`;
    if (completionTablesCache.value[cacheKey]) {
      return completionTablesCache.value[cacheKey];
    }

    return withCompletionInFlight(
      `${cacheKey}:tables`,
      async () => {
        await ensureConnected(connectionId, { activate: options.activateConnection !== false });

        if (isSchemaAwareDatabase(connectionId)) {
          if (normalizedFilter || limit) {
            let results: SqlCompletionTable[] = [];
            try {
              results = await listCompletionAssistantTables(connectionId, database, trimmedFilter, limit, schema, globalSearch);
            } catch {
              if (schema) {
                const tables = await listCompletionTableMetadata(connectionId, database, schema, trimmedFilter, limit, catalog);
                results = tables.map((table) => ({
                  name: table.name,
                  catalog,
                  schema,
                  type: sqlObjectNavigationTypeFromTableType(table.table_type),
                }));
              } else {
                results = lookupLocalCompletionTables(connectionId, database, normalizedFilter, limit, undefined, catalog);
              }
            }
            if (results.length === 0 && relaxedFilter) {
              if (globalSearch) {
                try {
                  results = await listCompletionAssistantTables(connectionId, database, relaxedFilter, expandedCompletionLimit(limit), schema, true);
                } catch {
                  results = [];
                }
              } else if (schema) {
                try {
                  const tables = await listCompletionTableMetadata(connectionId, database, schema, relaxedFilter, expandedCompletionLimit(limit), catalog);
                  results = tables.map((table) => ({
                    name: table.name,
                    catalog,
                    schema,
                    type: sqlObjectNavigationTypeFromTableType(table.table_type),
                  }));
                } catch {
                  results = [];
                }
              } else {
                results = lookupLocalCompletionTables(connectionId, database, relaxedFilter, expandedCompletionLimit(limit), undefined, catalog);
              }
            }
            const limitedTables = limit ? dedupeCompletionTables(results).slice(0, limit) : results;
            completionTablesCache.value[cacheKey] = limitedTables;
            indexCompletionTables(connectionId, database, undefined, limitedTables, catalog);
            evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
            return completionTablesCache.value[cacheKey];
          }

          if (schema) {
            const tables = await listCompletionTableMetadata(connectionId, database, schema, undefined, undefined, catalog);
            completionTablesCache.value[cacheKey] = tables.map((table) => ({
              name: table.name,
              catalog,
              schema,
              type: sqlObjectNavigationTypeFromTableType(table.table_type),
            }));
          } else {
            completionTablesCache.value[cacheKey] = lookupLocalCompletionTables(connectionId, database, normalizedFilter, limit, undefined, catalog);
          }
          indexCompletionTables(connectionId, database, undefined, completionTablesCache.value[cacheKey], catalog);
          evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
          return completionTablesCache.value[cacheKey];
        }

        const querySchema = catalog ? "" : database;
        let tables = await listCompletionTableMetadata(connectionId, database, querySchema, trimmedFilter, limit, catalog);
        if (tables.length === 0 && relaxedFilter) {
          tables = await listCompletionTableMetadata(connectionId, database, querySchema, relaxedFilter, expandedCompletionLimit(limit), catalog);
        }
        completionTablesCache.value[cacheKey] = tables.map((table) => ({
          name: table.name,
          catalog,
          type: sqlObjectNavigationTypeFromTableType(table.table_type),
        }));
        completionTablesCache.value[cacheKey] = limit ? completionTablesCache.value[cacheKey].slice(0, limit) : completionTablesCache.value[cacheKey];
        indexCompletionTables(connectionId, database, schema, completionTablesCache.value[cacheKey], catalog);
        evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
        return completionTablesCache.value[cacheKey];
      },
      { scope: completionLimiterScope(connectionId, database), kind: "tables" },
    );
  }

  function relaxedCompletionTableFilter(filter: string): string | undefined {
    if (filter.length < 3) return undefined;
    return filter.slice(0, 2);
  }

  function expandedCompletionLimit(limit?: number): number | undefined {
    if (!limit) return limit;
    return Math.min(Math.max(limit * 3, limit), 1000);
  }

  function dedupeCompletionTables(tables: SqlCompletionTable[]): SqlCompletionTable[] {
    const indexByKey = new Map<string, number>();
    const deduped: SqlCompletionTable[] = [];
    for (const table of tables) {
      const key = `${table.catalog ?? ""}.${table.schema ?? ""}.${table.name}`.toLowerCase();
      const existingIndex = indexByKey.get(key);
      if (existingIndex != null) {
        const existing = deduped[existingIndex];
        // Loaded tree metadata can distinguish materialized views even when an older completion endpoint only reports VIEW.
        deduped[existingIndex] = { ...table, ...existing, type: mergeSqlObjectNavigationType(existing.type, table.type) };
        continue;
      }
      indexByKey.set(key, deduped.length);
      deduped.push(table);
    }
    return deduped;
  }

  async function listCompletionObjects(connectionId: string, database: string, filter = "", limit?: number, schema?: string, parentName?: string, globalSearch = false, currentSchema?: string, objectKinds: CompletionAssistantObjectKind[] = ["routine"]): Promise<SqlCompletionObject[]> {
    const normalizedFilter = filter.trim().toLowerCase();
    const databaseType = getConfig(connectionId)?.db_type;
    const filteredRoutineAssistant = !!databaseType && FILTERED_ROUTINE_COMPLETION_DATABASES.has(databaseType) && (!!normalizedFilter || typeof limit === "number" || !!parentName || globalSearch);
    const cacheKey = filteredRoutineAssistant ? `${connectionId}:${database}:${schema ?? ""}:${parentName ?? ""}:${normalizedFilter}:${limit ?? ""}:${globalSearch ? "global" : "scoped"}:${currentSchema ?? ""}:${[...objectKinds].sort().join(",")}` : `${connectionId}:${database}:${schema ?? ""}`;
    if (!completionObjectsCache.value[cacheKey]) {
      await withCompletionInFlight(
        `${cacheKey}:objects`,
        async () => {
          await ensureConnected(connectionId);
          if (filteredRoutineAssistant) {
            try {
              completionObjectsCache.value[cacheKey] = dedupeCompletionObjects(await listCompletionAssistantObjects(connectionId, database, filter, limit, schema, parentName, globalSearch, currentSchema, objectKinds));
            } catch {
              const objects = isSchemaAwareDatabase(connectionId) ? await listSchemaAwareCompletionObjects(connectionId, database, schema) : await api.listCompletionObjects(connectionId, database, schema || database);
              completionObjectsCache.value[cacheKey] = dedupeCompletionObjects(objects.map(toSqlCompletionObject).filter((object): object is SqlCompletionObject => object != null));
            }
          } else {
            const objects = isSchemaAwareDatabase(connectionId) ? await listSchemaAwareCompletionObjects(connectionId, database, schema) : await api.listCompletionObjects(connectionId, database, schema || database);
            completionObjectsCache.value[cacheKey] = dedupeCompletionObjects(objects.map(toSqlCompletionObject).filter((object): object is SqlCompletionObject => object != null));
          }
          indexCompletionObjects(connectionId, database, schema, completionObjectsCache.value[cacheKey]);
          evictOldestCacheEntries(completionObjectsCache.value, COMPLETION_CACHE_MAX);
        },
        { scope: completionLimiterScope(connectionId, database), kind: "objects" },
      );
    }

    const objects = completionObjectsCache.value[cacheKey];
    const filtered = normalizedFilter ? objects.filter((object) => fuzzyCompletionObjectMatch(object, normalizedFilter)) : objects;
    return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
  }

  async function listSchemaAwareCompletionObjects(connectionId: string, database: string, schema?: string): Promise<ObjectInfo[]> {
    const schemas = schema ? [schema] : await listCompletionSchemas(connectionId, database);
    const batchSize = COMPLETION_METADATA_CONCURRENCY;
    const results: ObjectInfo[] = [];
    for (let i = 0; i < schemas.length; i += batchSize) {
      const batch = schemas.slice(i, i + batchSize);
      const groups = await Promise.all(
        batch.map(async (s) => {
          try {
            return await api.listCompletionObjects(connectionId, database, s);
          } catch {
            return [] as ObjectInfo[];
          }
        }),
      );
      for (const group of groups) results.push(...group);
    }
    return results;
  }

  function toSqlCompletionObject(object: ObjectInfo): SqlCompletionObject | null {
    const objectType = object.object_type.toUpperCase();
    const type = objectType.includes("PROCEDURE") ? "procedure" : objectType.includes("FUNCTION") ? "function" : objectType.includes("TRIGGER") ? "trigger" : objectType.includes("PACKAGE") ? "package" : null;
    if (!type) return null;
    return {
      name: object.name,
      schema: object.schema ?? undefined,
      type,
      parentSchema: object.parent_schema ?? undefined,
      parentName: object.parent_name ?? undefined,
      signature: object.signature ?? undefined,
      comment: object.comment ?? null,
    };
  }

  function fuzzyCompletionObjectMatch(object: SqlCompletionObject, filter: string): boolean {
    return fuzzyTextMatch(object.name, filter) || (!!object.schema && fuzzyTextMatch(object.schema, filter)) || (!!object.parentName && fuzzyTextMatch(object.parentName, filter)) || (!!object.parentSchema && fuzzyTextMatch(`${object.parentSchema}.${object.parentName ?? ""}`, filter));
  }

  function fuzzyTextMatch(value: string, filter: string): boolean {
    if (!filter) return true;
    const text = value.toLowerCase();
    if (text.includes(filter)) return true;
    // Pinyin initials, e.g. "zzj" or "zj" matches 总租金.
    if (/^[a-z0-9]+$/.test(filter) && containsHan(text)) {
      const pinyinInitials = pinyinFirstLetters(text);
      if (pinyinInitials.startsWith(filter) || orderedSubsequenceSpan(pinyinInitials, filter)) return true;
    }
    let index = 0;
    for (const ch of filter) {
      index = text.indexOf(ch, index);
      if (index < 0) return false;
      index++;
    }
    return true;
  }

  function dedupeCompletionObjects(objects: SqlCompletionObject[]): SqlCompletionObject[] {
    const seen = new Set<string>();
    const deduped: SqlCompletionObject[] = [];
    for (const object of objects) {
      const key = `${object.type}:${object.schema ?? ""}:${object.name}:${object.parentName ?? ""}:${object.signature?.trim() ?? ""}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(object);
    }
    return deduped;
  }

  async function listCompletionColumns(connectionId: string, database: string, table: string, schema?: string, context?: { clientSessionId?: string; version?: number; tableQuoted?: boolean; schemaQuoted?: boolean }, catalog?: string): Promise<SqlCompletionColumn[]> {
    const config = getConfig(connectionId);
    const completionTable = table;
    const completionSchema = schema?.trim() || undefined;
    if (isSchemaAwareDatabase(connectionId) && !connectionUsesDatabaseObjectTreeMode(config) && !completionSchema) {
      return [];
    }
    const cacheKey = `${connectionId}:${database}:${catalog ?? ""}:${completionSchema || ""}:${completionTable}`;
    if (!completionColumnsCache.value[cacheKey]) {
      await withCompletionInFlight(
        `${cacheKey}:columns`,
        async () => {
          await ensureConnected(connectionId);
          if (!catalog) {
            try {
              const assistantColumns = await listCompletionAssistantColumns(connectionId, database, completionTable, completionSchema, context);
              if (assistantColumns.length > 0) {
                completionColumnsCache.value[cacheKey] = assistantColumns.map((column) => ({
                  name: column.name,
                  data_type: column.dataType ?? "",
                  is_nullable: column.isNullable ?? true,
                  column_default: null,
                  is_primary_key: false,
                  extra: null,
                  comment: column.comment ?? null,
                  numeric_precision: null,
                  numeric_scale: null,
                  character_maximum_length: null,
                }));
                evictOldestCacheEntries(completionColumnsCache.value, COMPLETION_CACHE_MAX);
                return;
              }
            } catch {
              // Fall back to the existing metadata path below.
            }
          }
          const querySchema = metadataQuerySchema(connectionId, database, completionSchema);
          completionColumnsCache.value[cacheKey] = await api.getColumns(connectionId, database, querySchema, completionTable, catalog);
          evictOldestCacheEntries(completionColumnsCache.value, COMPLETION_CACHE_MAX);
        },
        { scope: completionLimiterScope(connectionId, database), kind: "columns" },
      );
    }

    const columns = completionColumnsCache.value[cacheKey].map((column) => ({
      name: column.name,
      table: completionTable,
      schema: completionSchema,
      dataType: column.data_type,
      isNullable: column.is_nullable,
      comment: column.comment,
    }));
    indexCompletionColumns(connectionId, database, completionTable, completionSchema, columns, catalog);
    return columns;
  }

  async function listCompletionForeignKeys(connectionId: string, database: string, table: string, schema?: string): Promise<SqlCompletionForeignKey[]> {
    if (isSchemaAwareDatabase(connectionId) && !connectionUsesDatabaseObjectTreeMode(getConfig(connectionId)) && !schema) {
      return [];
    }
    const metadataCapabilities = getTableMetadataCapabilities(effectiveDatabaseTypeForConnection(getConfig(connectionId)));
    if (!metadataCapabilities.foreignKeys) return [];

    const cacheKey = `${connectionId}:${database}:${schema || ""}:${table}`;
    if (!completionForeignKeysCache.value[cacheKey]) {
      await withCompletionInFlight(
        `${cacheKey}:fkeys`,
        async () => {
          await ensureConnected(connectionId);
          const querySchema = metadataQuerySchema(connectionId, database, schema);
          completionForeignKeysCache.value[cacheKey] = await api.listForeignKeys(connectionId, database, querySchema, table);
          evictOldestCacheEntries(completionForeignKeysCache.value, COMPLETION_CACHE_MAX);
        },
        { scope: completionLimiterScope(connectionId, database), kind: "foreignKeys" },
      );
    }

    const foreignKeys = sqlCompletionForeignKeys(completionForeignKeysCache.value[cacheKey]);
    indexCompletionForeignKeys(connectionId, database, table, schema, foreignKeys);
    return foreignKeys;
  }

  function refreshCompletionTables(connectionId: string, database: string, filter = "", limit?: number, schema?: string, globalSearch = false, currentSchema?: string, catalog?: string): Promise<SqlCompletionTable[]> {
    return listCompletionTables(connectionId, database, filter, limit, schema, globalSearch, currentSchema, catalog);
  }

  function refreshCompletionObjects(connectionId: string, database: string, filter = "", limit?: number, schema?: string, parentName?: string, globalSearch = false, currentSchema?: string): Promise<SqlCompletionObject[]> {
    return listCompletionObjects(connectionId, database, filter, limit, schema, parentName, globalSearch, currentSchema);
  }

  function refreshCompletionSchemas(connectionId: string, database: string): Promise<string[]> {
    return listCompletionSchemas(connectionId, database);
  }

  function refreshCompletionDatabases(connectionId: string): Promise<string[]> {
    return listCompletionDatabases(connectionId);
  }

  function refreshCompletionColumns(connectionId: string, database: string, table: string, schema?: string, context?: { clientSessionId?: string; version?: number; tableQuoted?: boolean; schemaQuoted?: boolean }, catalog?: string): Promise<SqlCompletionColumn[]> {
    return listCompletionColumns(connectionId, database, table, schema, context, catalog);
  }

  function refreshCompletionForeignKeys(connectionId: string, database: string, table: string, schema?: string): Promise<SqlCompletionForeignKey[]> {
    return listCompletionForeignKeys(connectionId, database, table, schema);
  }

  function findNode(nodes: TreeNode[], id: string): TreeNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children) {
        const found = findNode(node.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  /** 查连接根节点：沿 connection-group 层级下钻但不穿透连接的整棵子树
   * （原通用 DFS 找第 N 个连接前要完整遍历前 N-1 个连接的数千个表/列节点）。
   * 不能用"同层优先"版 findNode 代替通用 DFS——节点 id 并非全树唯一
   * （如数据库 "a:b" 与数据库 "a" 下 schema "b" 同为 connectionId:a:b，
   * 见 pinnedItems 对 colliding node IDs 的处理），改变遍历顺序会让深层
   * 调用选中错误节点；连接根节点的 id 就是 connectionId，且只出现在
   * 顶层或连接组内，无歧义。 */
  function findConnectionNode(connectionId: string, nodes: TreeNode[] = treeNodes.value): TreeNode | null {
    for (const node of nodes) {
      if (node.id === connectionId && node.type !== "connection-group") return node;
      if (node.type === "connection-group" && node.children) {
        const found = findConnectionNode(connectionId, node.children);
        if (found) return found;
      }
    }
    return null;
  }

  async function persistConnections(nextConnections: ConnectionConfig[] = connections.value) {
    await api.saveConnections(nextConnections.filter((connection) => connection.one_time !== true));
  }

  function persistSidebarLayoutDebounced() {
    if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
    layoutPersistTimer = setTimeout(() => {
      api.saveSidebarLayout(sidebarLayout.value).catch(() => {});
      layoutPersistTimer = null;
    }, 300);
  }

  function rebuildTreeNodes() {
    const existingNodesMap = new Map<string, TreeNode>();
    const collectExisting = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        existingNodesMap.set(node.id, node);
        if (node.children) collectExisting(node.children);
      }
    };
    collectExisting(treeNodes.value);

    const freshNodes = buildTreeNodesFromLayout(sidebarLayout.value, connections.value, pinnedTreeNodeIds.value);
    const mergeState = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((node) => {
        const existing = existingNodesMap.get(node.id);
        if (node.type === "connection-group") {
          return inheritNaturalTreeNodeOrder(node, { ...node, children: mergeState(node.children || []) });
        }
        if (existing && node.type === "connection") {
          return inheritNaturalTreeNodeOrder(node, {
            ...existing,
            label: node.label,
            pinned: node.pinned,
            children: withSavedSqlRoot(node.connectionId!, existing.children || [], existing),
          });
        }
        if (node.type === "connection" && node.connectionId) {
          return inheritNaturalTreeNodeOrder(node, { ...node, children: withSavedSqlRoot(node.connectionId, node.children || []) });
        }
        return node;
      });
    const mergedNodes = mergeState(freshNodes);
    const migratedPins = migrateLegacyPinnedTreeNodeOrder(mergedNodes, pinnedTreeNodeOrder.value);
    if (migratedPins.changed) {
      setPinnedTreeNodeOrder(migratedPins.order);
      persistPinnedTreeNodeIds();
    }
    syncPinnedTreeState(mergedNodes);
    treeNodes.value = mergedNodes;
  }

  function updateLayoutAndRebuild(nextLayout: SidebarLayout) {
    sidebarLayout.value = nextLayout;
    rebuildTreeNodes();
    persistSidebarLayoutDebounced();
  }

  function collapseAllTreeNodes() {
    updateLayoutAndRebuild(collapseAllGroupsOp(sidebarLayout.value));
    collapseExpandedTreeNodes(treeNodes.value);
  }

  async function refreshAllTree() {
    const expandedIds = collectExpandedNodeIds(treeNodes.value);
    const refreshExpandedNodes = async (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === "connection-group") {
          if (node.children) await refreshExpandedNodes(node.children);
          continue;
        }
        if (!expandedIds.has(node.id)) continue;
        if (node.connectionId && !connectedIds.value.has(node.connectionId)) continue;
        clearLoadedChildrenCache(node.id);
        node.children = [];
        await loadTreeNodeChildren(node, { force: true });
        await restoreExpandedChildren(node, expandedIds, { force: true });
      }
    };
    await refreshExpandedNodes(treeNodes.value);
  }

  async function refreshSidebarObjectPagination() {
    const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
    const isDirectObjectParent = (node: TreeNode) => {
      if (!node.children || node.children.length === 0) return false;
      return node.children.some(
        (child) => child.type === "table" || child.type === "view" || child.type === "materialized_view" || child.type === "procedure" || child.type === "function" || child.type === "sequence" || child.type === "package" || child.type === "package-body" || child.type === "load-more",
      );
    };
    const refreshNodes = async (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === "connection-group") {
          if (node.children) await refreshNodes(node.children);
          continue;
        }
        if (objectTypesForGroupNode(node.type)) {
          if (node.connectionId && connectedIds.value.has(node.connectionId)) {
            clearLoadedChildrenCache(node.id);
            if (node.isExpanded) {
              await loadObjectGroupChildren(node, { force: true });
            } else if (node.children) {
              node.children = [];
            }
          }
          continue;
        }
        if (simpleObjectDisplay && (node.type === "database" || node.type === "schema")) {
          if (isDirectObjectParent(node)) {
            if (node.connectionId && connectedIds.value.has(node.connectionId)) {
              clearLoadedChildrenCache(node.id);
              if (node.isExpanded) {
                await refreshTreeNode(node);
              } else {
                node.children = [];
              }
            }
            continue;
          }
          if (node.children) await refreshNodes(node.children);
          continue;
        }
        if (node.children) await refreshNodes(node.children);
      }
    };
    await refreshNodes(treeNodes.value);
  }

  async function exportConnectionsToFile(passphrase: string) {
    const { encryptConfig } = await import("@/lib/backend/configCrypto");
    const tunnelProfileStore = useTunnelProfileStore();
    await tunnelProfileStore.init();
    const exportData = { connections: connections.value, layout: sidebarLayout.value, tunnelProfiles: tunnelProfileStore.profiles };
    const json = JSON.stringify(exportData);
    const payload = await encryptConfig(json, passphrase);
    const content = JSON.stringify(payload, null, 2);

    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: "ogdeveloper-connections.json",
      });
      if (!path) return;
      await writeTextFile(path, content);
    } else {
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ogdeveloper-connections.json";
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  function bytesToBase64(bytes: Uint8Array) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function siblingCredentialsPath(path: string) {
    const fileName = path.split(/[\\/]/).pop() || "";
    const credentialsFile = fileName.startsWith("data-sources-") ? fileName.replace(/^data-sources/, "credentials-config") : "credentials-config.json";
    return path.replace(/[^\\/]+$/, credentialsFile);
  }

  async function readDbeaverImportFile(): Promise<{ content: string; encrypted: boolean } | null> {
    let dataSources: string;
    let credentialsBase64 = "";

    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile, readFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({
        filters: [{ name: "DBeaver Data Sources", extensions: ["json"] }],
        multiple: false,
      });
      if (!path) return null;
      const dataSourcesPath = path as string;
      dataSources = await readTextFile(dataSourcesPath);
      try {
        credentialsBase64 = bytesToBase64(await readFile(siblingCredentialsPath(dataSourcesPath)));
      } catch {
        credentialsBase64 = "";
      }
    } else {
      const files = await new Promise<FileList>((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.multiple = true;
        input.onchange = () => {
          if (!input.files?.length) {
            reject(new Error("No file selected"));
            return;
          }
          resolve(input.files);
        };
        input.click();
      });
      const fileList = Array.from(files);
      const dataSourcesFile = fileList.find((file) => /^data-sources.*\.json$/i.test(file.name)) || fileList.find((file) => !/^credentials-config.*\.json$/i.test(file.name));
      const credentialsFile = fileList.find((file) => /^credentials-config.*\.json$/i.test(file.name));
      if (!dataSourcesFile) throw new Error("Select DBeaver data-sources.json");
      dataSources = await dataSourcesFile.text();
      if (credentialsFile) {
        credentialsBase64 = bytesToBase64(new Uint8Array(await credentialsFile.arrayBuffer()));
      }
    }

    return {
      content: JSON.stringify({ format: "dbeaver-import", dataSources, credentialsBase64 }),
      encrypted: false,
    };
  }

  async function readDataGripImportFile(): Promise<{ content: string; encrypted: boolean } | null> {
    let dataSources: string;
    let dataSourcesLocal = "";
    let dbForestConfig = "";

    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const { matchDataGripImportFiles } = await import("@/lib/imports/datagripImport");
      const paths = await open({
        multiple: true,
        filters: [{ name: "DataGrip configuration files", extensions: ["xml"] }],
        title: i18n.global.t("configExport.importDatagripDialogTitle"),
      });
      if (!paths || paths.length === 0) return null;
      // Tauri's fs scope authorizes only the exact paths picked in the dialog,
      // so every file read below must be explicitly selected — sibling files in
      // the same directory (e.g. dataSources.local.xml) are NOT readable.
      let picked: { dataSources: string; local?: string; forest?: string };
      try {
        picked = matchDataGripImportFiles(Array.isArray(paths) ? paths : [paths]);
      } catch (error) {
        if ((error as Error & { code?: string })?.code === "DATAGRIP_IMPORT_MISSING_DATASOURCES") {
          throw new Error(i18n.global.t("configExport.importDatagripSelectFiles"));
        }
        throw error;
      }
      dataSources = await readTextFile(picked.dataSources);
      if (picked.local) {
        dataSourcesLocal = await readTextFile(picked.local);
      } else {
        console.warn("[DataGrip Import] dataSources.local.xml not selected; usernames will fall back to defaults");
      }
      if (picked.forest) {
        dbForestConfig = await readTextFile(picked.forest);
      } else {
        console.warn("[DataGrip Import] db-forest-config.xml not selected; legacy group tree skipped");
      }
    } else {
      const files = await new Promise<FileList>((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".xml";
        input.multiple = true;
        input.onchange = () => {
          if (!input.files?.length) {
            reject(new Error("No file selected"));
            return;
          }
          resolve(input.files);
        };
        input.click();
      });
      const fileList = Array.from(files);
      const dsFile = fileList.find((f) => /^dataSources\.xml$/i.test(f.name));
      const localFile = fileList.find((f) => /^dataSources\.local\.xml$/i.test(f.name));
      const forestFile = fileList.find((f) => /^db-forest-config\.xml$/i.test(f.name));
      if (!dsFile) throw new Error("Select dataSources.xml");
      dataSources = await dsFile.text();
      if (localFile) {
        dataSourcesLocal = await localFile.text();
      }
      if (forestFile) {
        dbForestConfig = await forestFile.text();
      }
    }

    return {
      content: JSON.stringify({ format: "datagrip-import", dataSources, dataSourcesLocal, dbForestConfig }),
      encrypted: false,
    };
  }

  async function readImportFile(source: ImportSource = "dbx"): Promise<{ content: string; encrypted: boolean } | null> {
    if (source === "dbeaver") return readDbeaverImportFile();
    if (source === "datagrip") return readDataGripImportFile();

    let content: string;

    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({
        filters: source === "navicat" ? [{ name: "Navicat Connection Export", extensions: ["ncx", "xml"] }] : [{ name: "ogdeveloper JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (!path) return null;
      content = await readTextFile(path as string);
    } else {
      content = await new Promise<string>((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = source === "navicat" ? ".ncx,.xml" : ".json";
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) {
            reject(new Error("No file selected"));
            return;
          }
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsText(file);
        };
        input.click();
      });
    }

    if (content.trimStart().startsWith("<")) {
      return { content, encrypted: false };
    }

    const { isEncryptedConfig } = await import("@/lib/backend/configCrypto");
    const parsed = JSON.parse(content);
    return { content, encrypted: isEncryptedConfig(parsed) };
  }

  async function importConnectionsFromFile(content: string, passphrase: string | null): Promise<{ count: number; layout?: SidebarLayout }> {
    let imported: ConnectionConfig[] = [];
    let importedLayout: SidebarLayout | undefined;
    let importedTunnelProfiles: TunnelProfile[] = [];

    if (!passphrase && content.trimStart().startsWith("<")) {
      const { parseNavicatConnections } = await import("@/lib/imports/navicatImport");
      imported = await parseNavicatConnections(content);
    } else if (!passphrase) {
      const { isDbeaverImportPayload, parseDbeaverImport } = await import("@/lib/imports/dbeaverImport");
      const { isDataGripImportPayload, parseDataGripImport } = await import("@/lib/imports/datagripImport");
      if (isDataGripImportPayload(content)) {
        const payload = JSON.parse(content) as {
          format: "datagrip-import";
          dataSources: string;
          dataSourcesLocal?: string;
          dbForestConfig?: string;
        };
        pendingDataGripPayload = payload;
        const result = parseDataGripImport(payload);
        imported = result.connections;
        importedLayout = result.layout;
      } else if (isDbeaverImportPayload(content)) {
        const result = await parseDbeaverImport(content);
        imported = result.connections;
        importedLayout = result.layout;
      } else {
        const parsed = JSON.parse(content);

        if (Array.isArray(parsed)) {
          imported = parsed;
        } else if ((parsed.format === "ogdeveloper-config" || parsed.format === "dbx-config") && Array.isArray(parsed.connections)) {
          imported = parsed.connections;
        } else if (parsed.connections && Array.isArray(parsed.connections)) {
          imported = parsed.connections;
          if (parsed.layout?.groups && parsed.layout?.order) {
            importedLayout = parsed.layout;
          }
          if (Array.isArray(parsed.tunnelProfiles)) {
            importedTunnelProfiles = parsed.tunnelProfiles;
          }
        } else {
          imported = [];
        }
      }
    } else {
      const parsed = JSON.parse(content);

      if (passphrase) {
        const { decryptConfig } = await import("@/lib/backend/configCrypto");
        const json = await decryptConfig(parsed, passphrase);
        const decrypted = JSON.parse(json);
        if (Array.isArray(decrypted)) {
          imported = decrypted;
        } else if (decrypted.connections) {
          imported = decrypted.connections;
          if (decrypted.layout?.groups && decrypted.layout?.order) {
            importedLayout = decrypted.layout;
          }
          if (Array.isArray(decrypted.tunnelProfiles)) {
            importedTunnelProfiles = decrypted.tunnelProfiles;
          }
        } else {
          imported = [];
        }
      }
    }

    // Profiles keep their original ids: imported connections reference them
    // via transport_layers[].profile_id, so regenerating ids would break the
    // links. Same-id profiles are overwritten with the imported copy.
    if (importedTunnelProfiles.length) {
      const tunnelProfileStore = useTunnelProfileStore();
      await tunnelProfileStore.init();
      const merged = [...tunnelProfileStore.profiles];
      for (const profile of importedTunnelProfiles) {
        if (!profile || typeof profile.id !== "string" || !profile.id) continue;
        const index = merged.findIndex((existing) => existing.id === profile.id);
        if (index >= 0) merged[index] = profile;
        else merged.push(profile);
      }
      await tunnelProfileStore.saveProfiles(merged);
    }

    let count = 0;
    const importedConnectionIdMap = new Map<string, string>();
    for (const config of imported) {
      const duplicate = connections.value.find((c) => c.name === config.name && c.host === config.host && c.port === config.port);
      if (!duplicate) {
        const importedId = config.id;
        config.id = uuid();
        if (typeof importedId === "string") importedConnectionIdMap.set(importedId, config.id);
        const normalized = normalizeConnection(config);
        await addConnection(normalized);
        count++;
      } else if (typeof config.id === "string") {
        importedConnectionIdMap.set(config.id, duplicate.id);
      }
    }
    if (importedLayout) {
      importedLayout = remapSidebarLayoutConnectionIds(importedLayout, importedConnectionIdMap);
    }
    return { count, layout: importedLayout };
  }

  /** Read macOS Keychain passwords for DataGrip connections and update them. */
  async function applyDataGripKeychainPasswords(): Promise<number> {
    const payload = pendingDataGripPayload;
    pendingDataGripPayload = null;
    if (!payload) return 0;

    try {
      const { getDataGripUuidMap, datagripKeychainService } = await import("@/lib/imports/datagripImport");
      // dedupKey → DataGrip UUID
      const uuidMap = getDataGripUuidMap(payload);
      if (uuidMap.size === 0) return 0;

      // Build service names for batch Keychain read
      const dedupKeyToService = new Map<string, string>();
      const services: string[] = [];
      for (const [dedupKey, dgUuid] of uuidMap) {
        const service = datagripKeychainService(dgUuid);
        dedupKeyToService.set(dedupKey, service);
        services.push(service);
      }

      // Call Tauri command to read Keychain
      const results: [string, string][] = await api.readKeychainPasswords(services);

      // Build service → password map
      const passwordByService = new Map<string, string>();
      for (const [service, password] of results) {
        if (password) passwordByService.set(service, password);
      }

      // Update connections that have passwords (match by name/host/port)
      let filled = 0;
      const updated = connections.value.map((conn) => {
        const dedupKey = [conn.name, conn.host, conn.port, conn.database || ""].join("\u0000");
        const service = dedupKeyToService.get(dedupKey);
        if (!service) return conn;
        const password = passwordByService.get(service);
        if (password) {
          filled++;
          return { ...conn, password };
        }
        return conn;
      });

      if (filled > 0) {
        connections.value = updated;
        await persistConnections();
      }
      return filled;
    } catch (e) {
      console.warn("[DataGrip Import] Keychain read failed:", e);
      return 0;
    }
  }

  function applySidebarLayout(layout: SidebarLayout) {
    const reconciledLayout = reconcileLayout(
      connections.value.map((c) => c.id),
      layout,
    );
    updateLayoutAndRebuild(reconciledLayout);
  }

  async function initFromDisk() {
    if (!initFromDiskPromise) {
      initFromDiskPromise = (async () => {
        const [pinnedOrder, saved] = await Promise.all([loadPinnedTreeNodeOrder(), api.loadConnections(), tunnelProfileStore.init()]);
        setPinnedTreeNodeOrder(pinnedOrder);
        connections.value = saved.map(normalizeConnection);
        const savedLayout = await api.loadSidebarLayout();
        const currentLayout = sidebarLayout.value.groups.length || sidebarLayout.value.order.length ? sidebarLayout.value : null;
        sidebarLayout.value = reconcileLayout(
          connections.value.map((c) => c.id),
          savedLayout ?? currentLayout,
        );
        rebuildTreeNodes();
      })().finally(() => {
        initFromDiskPromise = null;
      });
    }
    await initFromDiskPromise;
  }

  function addEphemeralConnection(config: ConnectionConfig) {
    const normalized = normalizeConnection(config);
    if (!connections.value.find((c) => c.id === normalized.id)) {
      connections.value.push(normalized);
    }
    connectedIds.value.add(normalized.id);
    markConnectionHealthChecked(normalized.id);
    clearConnectionError(normalized.id);
  }

  function cancelTreeNodeLoad(nodeId: string): void {
    // Supersede any in-flight loader for this node so a collapse issued while
    // the load is still running (or a loader that never resolves) cannot
    // reclaim ownership after connection recovery or re-expand the node.
    treeNodeLoads.cancelPrefix(nodeId);
    const node = findNode(treeNodes.value, nodeId);
    if (node) node.isLoading = false;
  }

  return {
    connections,
    activeConnectionId,
    selectedTreeNodeId,
    selectedTreeNodeIds,
    selectedTreeNodeIdsSet,
    treeSelectionAnchorId,
    connectionMultiSelectActive,
    treeClipboard,
    treeNodes,
    removePinnedTreeNodes,
    replacePinnedTreeNode,
    removeTreeNode,
    refreshAllTree,
    collapseAllTreeNodes,
    refreshSidebarObjectPagination,
    refreshTreeNode,
    refreshDatabaseTreeNode,
    refreshObjectListTreeNode,
    connectedIds,
    connectingIds,
    connectionErrors,
    setConnectionError,
    clearConnectionError,
    recordConnectionError,
    markConnectionLost,
    recordConnectionLostError,
    sidebarLayout,
    connectionGroupPaths,
    getConfig,
    connectionIdentifierQuote,
    isTreeNodePinned,
    orderByPinnedTreeNodes,
    toggleTreeNodePin,
    beginPinnedTreeNodeReorder,
    endPinnedTreeNodeReorder,
    isPinnedTreeNodeReorderTarget,
    canReorderPinnedTreeNodes,
    reorderPinnedTreeNodes,
    addConnection,
    copyConnectionsToTreeClipboard,
    pasteConnectionClipboard,
    addEphemeralConnection,
    updateConnection,
    updateConnectionDatabaseInfo,
    setDefaultDatabase,
    clearDefaultDatabase,
    isDefaultDatabase,
    setVisibleDatabases,
    clearVisibleDatabases,
    ensureVisibleDatabase,
    setVisibleSchemas,
    clearVisibleSchemas,
    removeConnection,
    removeConnections,
    editingConnectionId,
    newConnectionGroupId,
    startEditing,
    stopEditing,
    startCreatingConnectionInGroup,
    stopCreatingConnectionInGroup,
    connect,
    cancelConnecting,
    disconnect,
    closeDatabaseConnection,
    ensureConnected,
    loadConnectedConnectionRootForSidebarSearch,
    isTreeNodeChildrenLoaded,
    canUseLoadedTreeNodeToggle,
    releaseCollapsedTreeNodeChildren,
    cancelTreeNodeLoad,
    setBeforeConnectHandler,
    initFromDisk,
    loadDatabases,
    loadSidebarDatabaseStorage,
    loadSidebarTableStorage,
    loadSchemas,
    loadTables,
    loadTableForLocate,
    loadObjectGroupChildren,
    loadMoreObjectGroupChildren,
    loadSynonymGroups,
    loadTypeGroups,
    loadReferenceGroupChildren,
    loadAllObjectGroupChildren,
    loadTableGroups,
    loadTreeNodeChildren,
    loadOpengaussPackageSubprograms,
    loadColumns,
    loadIndexes,
    loadForeignKeys,
    loadTriggers,
    loadConstraints,
    loadPartitions,
    loadSubpartitions,
    listCompletionTables,
    listCompletionObjects,
    listCompletionColumns,
    listCompletionForeignKeys,
    listCompletionSchemas,
    listCompletionDatabases,
    lookupLocalCompletionTables,
    lookupLocalCompletionObjects,
    lookupLocalCompletionColumns,
    lookupLocalCompletionForeignKeys,
    lookupLocalCompletionSchemas,
    lookupLocalCompletionDatabases,
    refreshCompletionTables,
    refreshCompletionObjects,
    refreshCompletionColumns,
    refreshCompletionForeignKeys,
    refreshCompletionSchemas,
    refreshCompletionDatabases,
    invalidateCompletionCache,
    invalidateCompletionTableCache,
    invalidateMetadataCache,
    exportConnectionsToFile,
    readImportFile,
    importConnectionsFromFile,
    applyDataGripKeychainPasswords,
    applySidebarLayout,
    transferSource,
    schemaDiffSource,
    dataCompareSource,
    sqlFileSource,
    diagramSource,
    tableImportSource,
    tableDataGenerateSource,
    fieldLineageSource,
    databaseSearchSource,
    databaseExportSource,
    sidebarSearchQuery,
    sidebarTableSearchQueries,
    sidebarTableNameFilters,
    tableNameFilterScopeKey,
    tableNameFilterForScope,
    setSidebarTableNameFilter,
    refreshTreeNodeForTableNameFilter,
    setSidebarTableSearchQuery,
    refreshSidebarTableSearch,
    loadSidebarTableSearchIndex,
    refreshSidebarTableSearchIndex,
    createConnectionGroup(name: string, parentGroupId?: string | null) {
      const result = createGroupOp(sidebarLayout.value, name, parentGroupId);
      updateLayoutAndRebuild(result.layout);
      return result.groupId;
    },
    renameConnectionGroup(groupId: string, name: string) {
      updateLayoutAndRebuild(renameGroupOp(sidebarLayout.value, groupId, name));
    },
    deleteConnectionGroup(groupId: string) {
      updateLayoutAndRebuild(deleteGroupOp(sidebarLayout.value, groupId));
    },
    toggleConnectionGroupCollapsed(groupId: string) {
      updateLayoutAndRebuild(toggleGroupCollapsedOp(sidebarLayout.value, groupId));
    },
    moveConnectionToGroup(connectionId: string, groupId: string | null) {
      updateLayoutAndRebuild(moveConnectionToGroupOp(sidebarLayout.value, connectionId, groupId));
    },
    groupIdForConnection(connectionId: string): string | null {
      return findConnectionLocation(sidebarLayout.value, connectionId)?.groupId ?? null;
    },
    reorderSidebarEntry(draggedId: string, targetId: string, position: DropPosition) {
      updateLayoutAndRebuild(reorderEntryOp(sidebarLayout.value, draggedId, targetId, position));
    },
    reorderSidebarEntries(draggedIds: string[], targetId: string, position: DropPosition) {
      // Apply each dragged entry in turn so a multi-selection moves together,
      // not just the single grabbed row (issue #681).
      let layout = sidebarLayout.value;
      let changed = false;
      for (const id of draggedIds) {
        if (id === targetId) continue;
        layout = reorderEntryOp(layout, id, targetId, position);
        changed = true;
      }
      if (changed) updateLayoutAndRebuild(layout);
    },
  };
});
