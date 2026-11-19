import { computed, ref, watch } from "vue";
import { getActivePinia } from "pinia";
import type { ConnectionConfig, QueryTab } from "@/types/database";
import type { SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useQueryStore } from "@/stores/queryStore";
import { tabDisplayTitle } from "@/lib/tabs/tabPresentation";
import * as api from "@/lib/backend/api";
import type { SqlFileEntry } from "@/lib/backend/api";
import { getSqlFileFolderPaths, sqlFileFoldersVersion } from "@/lib/sqlFile/sqlFileFolders";
import i18n from "@/i18n";

const REMOTE_SEARCH_DEBOUNCE_MS = 180;
const REMOTE_SEARCH_MIN_QUERY_LENGTH = 2;
const REMOTE_SEARCH_MAX_REQUESTS = 8;
const REMOTE_SEARCH_CONCURRENCY = 2;
const REMOTE_SEARCH_RESULTS_PER_REQUEST = 25;
const REMOTE_SEARCH_MAX_RESULTS = 100;
const QUICK_OPEN_MAX_RESULTS = 200;
const INITIAL_SQL_LIBRARY_LIMIT = 20;
const INITIAL_SQL_FILE_LIMIT = 20;

const REMOTE_SEARCH_UNSUPPORTED_TYPES = new Set<ConnectionConfig["db_type"]>();

export type QuickOpenCommandId =
  | "new-query"
  | "new-command-window"
  | "open-process-list"
  | "open-server-dashboard"
  | "open-top-sql"
  | "open-storage-bloat"
  | "open-guc-parameters"
  | "open-recycle-bin"
  | "open-invalid-objects"
  | "open-schema-diff"
  | "open-data-compare"
  | "open-settings"
  | "new-connection";

export interface QuickOpenItem {
  id: string;
  type: "connection" | "database" | "schema" | "table" | "view" | "materialized_view" | "procedure" | "function" | "sequence" | "package" | "package-body" | "synonym" | "trigger" | "job" | "scheduler" | "open_tab" | "command" | "sql_file" | "sql_library_file";
  label: string;
  description?: string;
  connectionId: string;
  database?: string;
  schema?: string;
  objectName?: string; // For non-table objects (views, procedures, functions, sequences, packages, synonyms, triggers, jobs)
  tableName?: string; // Kept for backward compatibility
  relationName?: string; // Owning table name for triggers
  signature?: string; // Overload signature for PostgreSQL/openGauss routines
  targetSchema?: string; // Resolved synonym target schema
  targetName?: string; // Resolved synonym target name
  tabId?: string;
  commandId?: QuickOpenCommandId;
  connectionName?: string;
  searchText: string; // Searchable text
  filePath?: string; // For external SQL files
  sqlFileId?: string; // For saved SQL library files
}

/**
 * Fuzzy match function that checks if query matches text
 * Returns the matched indices for highlighting
 */
function fuzzyMatch(query: string, text: string): { score: number; indices: number[] } | null {
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();

  if (!lowerQuery) return { score: Infinity, indices: [] };
  if (lowerText.includes(lowerQuery)) {
    // Exact substring match gets highest score
    const startIdx = lowerText.indexOf(lowerQuery);
    return {
      score: 1,
      indices: Array.from({ length: lowerQuery.length }, (_, i) => startIdx + i),
    };
  }

  // Fuzzy match: find all characters in order
  let queryIdx = 0;
  const indices: number[] = [];
  let score = 0;
  let lastMatchIdx = -1;

  for (let i = 0; i < lowerText.length && queryIdx < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIdx]) {
      indices.push(i);
      // Score based on proximity (consecutive chars score better)
      score += lastMatchIdx === i - 1 ? 2 : 1;
      lastMatchIdx = i;
      queryIdx++;
    }
  }

  if (queryIdx === lowerQuery.length) {
    return { score: score / lowerQuery.length, indices };
  }

  return null;
}

interface MatchedItem extends QuickOpenItem {
  matchScore: number;
  matchIndices: number[];
}

function loadSavedSqlFileFolderPaths(): string[] {
  return getSqlFileFolderPaths();
}

function folderNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.pop() || path;
}

function collectSqlFileEntries(entries: SqlFileEntry[], results: SqlFileEntry[]): void {
  for (const entry of entries) {
    if (entry.is_dir) {
      collectSqlFileEntries(entry.children, results);
    } else {
      results.push(entry);
    }
  }
}

export function useQuickOpen() {
  const connectionStore = useConnectionStore();
  const savedSqlStore = useSavedSqlStore();
  const queryStore = (() => {
    try {
      return getActivePinia() ? useQueryStore() : null;
    } catch {
      return null;
    }
  })();
  const searchQuery = ref("");
  const isCommandMode = computed(() => searchQuery.value.trim().startsWith(">"));
  const selectedIndex = ref(0);
  const remoteItems = ref<QuickOpenItem[]>([]);
  const sqlFileItems = ref<QuickOpenItem[]>([]);
  let remoteSearchGeneration = 0;
  let remoteSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let activeRemoteRequests = 0;
  const remoteRequestWaiters: Array<{ generation: number; resolve: (acquired: boolean) => void }> = [];
  let sqlFilesLoaded = false;
  let sqlFilesLoadingPromise: Promise<void> | null = null;
  let sqlFilesLoadGeneration = 0;

  function getConnectionLabel(connectionId: string): string {
    if (!connectionId) return i18n.global.t("sqlLibrary.unassociated");
    const conn = connectionStore.connections.find((c) => c.id === connectionId);
    return conn?.name || i18n.global.t("sqlLibrary.deletedConnection");
  }

  const sqlLibraryAllItems = computed<QuickOpenItem[]>(() => {
    return savedSqlStore.allFiles.map((file) => ({
      id: `sqllib-${file.id}`,
      type: "sql_library_file" as const,
      label: file.name,
      description: getConnectionLabel(file.connectionId),
      connectionId: file.connectionId,
      connectionName: getConnectionLabel(file.connectionId),
      sqlFileId: file.id,
      searchText: `${file.name} ${getConnectionLabel(file.connectionId)}`,
    }));
  });

  const sqlLibraryRecentItems = computed<QuickOpenItem[]>(() => {
    return [...sqlLibraryAllItems.value]
      .sort((a, b) => {
        const fileA = savedSqlStore.getFile(a.sqlFileId!);
        const fileB = savedSqlStore.getFile(b.sqlFileId!);
        const timeA = fileA?.openedAt || fileA?.updatedAt || "";
        const timeB = fileB?.openedAt || fileB?.updatedAt || "";
        return timeB.localeCompare(timeA);
      })
      .slice(0, INITIAL_SQL_LIBRARY_LIMIT);
  });

  async function loadExternalSqlFiles(): Promise<void> {
    if (sqlFilesLoaded || sqlFilesLoadingPromise) return sqlFilesLoadingPromise ?? undefined;
    const generation = sqlFilesLoadGeneration;
    const loadingPromise = (async () => {
      try {
        const folderPaths = loadSavedSqlFileFolderPaths();
        if (folderPaths.length === 0) {
          if (generation === sqlFilesLoadGeneration) sqlFilesLoaded = true;
          return;
        }
        const allEntries: Array<{ entry: SqlFileEntry; rootFolder: string }> = [];
        for (const folderPath of folderPaths) {
          try {
            const entries = await api.listSqlFilesInFolder(folderPath);
            const collected: SqlFileEntry[] = [];
            collectSqlFileEntries(entries, collected);
            const rootName = folderNameFromPath(folderPath);
            for (const entry of collected) {
              allEntries.push({ entry, rootFolder: rootName });
            }
          } catch {
            // Skip folders that fail to load
          }
        }
        // Folder changes invalidate this snapshot; an updated scan runs after cleanup below.
        if (generation !== sqlFilesLoadGeneration) return;
        sqlFileItems.value = allEntries.map(({ entry, rootFolder }) => {
          const parentDir = entry.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
          const parentName = folderNameFromPath(parentDir || entry.path);
          // Show the top-level folder name so users can distinguish files from different directories
          const description = parentName === rootFolder ? rootFolder : `${rootFolder} / ${parentName}`;
          return {
            id: `sqlfile-${entry.path}`,
            type: "sql_file" as const,
            label: entry.name,
            description,
            connectionId: "",
            filePath: entry.path,
            searchText: `${entry.name} ${rootFolder} ${parentName}`,
          };
        });
        sqlFilesLoaded = true;
      } catch {
        // ignore errors
      }
    })();
    sqlFilesLoadingPromise = loadingPromise;
    try {
      await loadingPromise;
    } finally {
      if (sqlFilesLoadingPromise === loadingPromise) sqlFilesLoadingPromise = null;
    }
    if (generation !== sqlFilesLoadGeneration) await loadExternalSqlFiles();
  }

  /**
   * Limited set of external SQL files for the initial (no-query) view.
   * Shows files from all configured folders, capped to INITIAL_SQL_FILE_LIMIT.
   */
  const sqlFileRecentItems = computed<QuickOpenItem[]>(() => {
    return sqlFileItems.value.slice(0, INITIAL_SQL_FILE_LIMIT);
  });

  const allItems = computed((): QuickOpenItem[] => {
    const items: QuickOpenItem[] = [];
    const connections = connectionStore.connections;
    const treeNodes = connectionStore.treeNodes;

    // Add connections
    for (const conn of connections) {
      items.push({
        id: `conn-${conn.id}`,
        type: "connection",
        label: conn.name,
        connectionId: conn.id,
        connectionName: conn.name,
        searchText: `${conn.name}`,
      });
    }

    // Add databases and tables from tree nodes
    // Filter tree nodes by connection
    for (const conn of connections) {
      // Connections may live under sidebar groups, so locate their tree recursively.
      const connectionTreeNode = findConnectionTreeNode(treeNodes, conn.id);
      const connectionTreeNodes = connectionTreeNode?.children || treeNodes.filter((node) => node.connectionId === conn.id);
      if (connectionTreeNodes.length === 0) continue;

      // Process tree nodes to extract databases and tables
      processDatabaseTreeNodes(connectionTreeNodes, conn, items);
    }

    return items;
  });

  function processDatabaseTreeNodes(nodes: any[], conn: ConnectionConfig, items: QuickOpenItem[]): void {
    for (const node of nodes) {
      // Skip certain node types
      if (node.type === "group" || node.type === "linked-server-root") {
        if (node.children) {
          processDatabaseTreeNodes(node.children, conn, items);
        }
        continue;
      }

      // Database nodes
      if (node.type === "database" && node.database) {
        items.push({
          id: `db-${conn.id}-${node.database}`,
          type: "database",
          label: node.label || node.database,
          description: conn.name,
          connectionId: conn.id,
          database: node.database,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database}`,
        });
      }

      // Schema nodes are navigable results and also contain database objects.
      if (node.type === "schema" && node.database && node.schema) {
        items.push({
          id: `schema-${conn.id}-${node.database}-${node.schema}`,
          type: "schema",
          label: node.label || node.schema,
          description: `${conn.name} / ${node.database}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema}`,
        });
        if (node.children) processDatabaseTreeNodes(node.children, conn, items);
        continue;
      }

      const treeObjectEntry = treeObjectQuickOpenItem(node, conn);
      if (treeObjectEntry) {
        items.push(treeObjectEntry);
      }

      // Process children recursively
      if (node.children) {
        processDatabaseTreeNodes(node.children, conn, items);
      }
    }
  }

  const TREE_OBJECT_ID_PREFIX: Partial<Record<QuickOpenItem["type"], string>> = {
    table: "table",
    view: "view",
    materialized_view: "mview",
    procedure: "proc",
    function: "func",
    sequence: "seq",
    package: "pkg",
    "package-body": "pkgbody",
    synonym: "syn",
    trigger: "trg",
    job: "job",
    scheduler: "sched",
  };

  function treeObjectQuickOpenItem(node: any, conn: ConnectionConfig): QuickOpenItem | null {
    const objectType = node?.type as QuickOpenItem["type"] | undefined;
    const prefix = objectType ? TREE_OBJECT_ID_PREFIX[objectType] : undefined;
    if (!prefix || !objectType || !node.database || !node.label) return null;

    const objectName = node.objectName || node.label;
    const baseLocation = `${conn.name} / ${node.database}${node.schema ? ` / ${node.schema}` : ""}`;
    let description = baseLocation;
    if (objectType === "synonym" && node.targetName) {
      const target = node.targetSchema ? `${node.targetSchema}.${node.targetName}` : node.targetName;
      description = `${baseLocation} \u2192 ${target}`;
    } else if (objectType === "trigger" && node.tableName) {
      description = `${baseLocation} / ${node.tableName}`;
    }

    const extraSearchTerms = [objectType === "synonym" ? `${node.targetSchema || ""} ${node.targetName || ""}` : "", objectType === "trigger" ? node.tableName || "" : ""].filter(Boolean).join(" ");

    return {
      id: `${prefix}-${conn.id}-${node.database}-${node.schema || ""}-${node.tableName || ""}-${objectName}-${node.signature || ""}`,
      type: objectType,
      label: node.label,
      description,
      connectionId: conn.id,
      database: node.database,
      schema: node.schema,
      ...(objectType === "table" ? { tableName: node.label } : { objectName }),
      ...(objectType === "trigger" && node.tableName ? { relationName: node.tableName } : {}),
      ...(node.signature ? { signature: node.signature } : {}),
      ...(objectType === "synonym" && (node.targetSchema || node.targetName) ? { targetSchema: node.targetSchema, targetName: node.targetName } : {}),
      connectionName: conn.name,
      searchText: `${conn.name} ${node.database} ${node.schema || ""} ${objectName} ${extraSearchTerms}`.trim(),
    };
  }

  function findConnectionTreeNode(nodes: any[], connectionId: string): any | undefined {
    for (const node of nodes) {
      if (node.type === "connection" && node.connectionId === connectionId) return node;
      if (node.children) {
        const match = findConnectionTreeNode(node.children, connectionId);
        if (match) return match;
      }
    }
    return undefined;
  }

  function quickOpenItemKey(item: QuickOpenItem): string {
    if (item.type === "table" || item.type === "view" || item.type === "materialized_view" || item.type === "synonym") {
      return `${item.type}:${item.connectionId}:${item.database ?? ""}:${item.schema ?? ""}:${item.tableName ?? item.objectName ?? item.label}`.toLowerCase();
    }
    return item.id.toLowerCase();
  }

  function remoteTableItem(table: SqlCompletionTable, conn: ConnectionConfig, database: string): QuickOpenItem {
    if (table.synonymTarget) {
      const target = table.synonymTarget.name ? (table.synonymTarget.schema ? `${table.synonymTarget.schema}.${table.synonymTarget.name}` : table.synonymTarget.name) : "";
      const baseDesc = `${conn.name} / ${database}${table.schema ? ` / ${table.schema}` : ""}`;
      return {
        id: `syn-${conn.id}-${database}-${table.schema || ""}-${table.name}`,
        type: "synonym",
        label: table.name,
        description: target ? `${baseDesc} \u2192 ${target}` : baseDesc,
        connectionId: conn.id,
        database,
        schema: table.schema,
        objectName: table.name,
        targetSchema: table.synonymTarget.schema,
        targetName: table.synonymTarget.name,
        connectionName: conn.name,
        searchText: `${conn.name} ${database} ${table.schema || ""} ${table.name} ${target}`.trim(),
      };
    }
    // Completion "tables" may carry routine navigation types; quick-open relation entries only accept relation kinds.
    const type = table.type === "view" || table.type === "materialized_view" ? table.type : "table";
    const prefix = type === "materialized_view" ? "mview" : type;
    return {
      id: `${prefix}-${conn.id}-${database}-${table.schema || ""}-${table.name}`,
      type,
      label: table.name,
      description: `${conn.name} / ${database}${table.schema ? " / " + table.schema : ""}`,
      connectionId: conn.id,
      database,
      schema: table.schema,
      ...(type === "table" ? { tableName: table.name } : { objectName: table.name }),
      connectionName: conn.name,
      searchText: `${conn.name} ${database} ${table.schema || ""} ${table.name}`,
    };
  }

  const openTabItems = computed<QuickOpenItem[]>(() => {
    const tabs: QueryTab[] = Array.isArray(queryStore?.tabs) ? queryStore.tabs : [];
    const translator = (key: string, params?: Record<string, unknown>) => i18n.global.t(key, params ?? {});
    return tabs.map((tab) => {
      const label = tabDisplayTitle(tab, translator);
      const connName = getConnectionLabel(tab.connectionId);
      const description = [connName, tab.database, tab.schema].filter(Boolean).join(" / ");
      return {
        id: `open-tab-${tab.id}`,
        type: "open_tab" as const,
        label,
        description: description || undefined,
        connectionId: tab.connectionId,
        database: tab.database,
        schema: tab.schema,
        tabId: tab.id,
        connectionName: connName,
        searchText: `${label} ${description}`.trim(),
      };
    });
  });

  interface QuickOpenCommandSpec {
    commandId: QuickOpenCommandId;
    labelKey: string;
    descKey: string;
    keywords: string;
  }

  const QUICK_OPEN_COMMANDS: QuickOpenCommandSpec[] = [
    { commandId: "new-query", labelKey: "quickOpen.commands.newQuery", descKey: "quickOpen.commands.newQueryDesc", keywords: "new query sql editor 新建查询" },
    { commandId: "new-command-window", labelKey: "quickOpen.commands.commandWindow", descKey: "quickOpen.commands.commandWindowDesc", keywords: "command window console shell gsql 命令行窗口" },
    { commandId: "open-process-list", labelKey: "quickOpen.commands.processList", descKey: "quickOpen.commands.processListDesc", keywords: "process list sessions locks blocking 进程 锁 等待" },
    { commandId: "open-server-dashboard", labelKey: "quickOpen.commands.serverDashboard", descKey: "quickOpen.commands.serverDashboardDesc", keywords: "server dashboard monitor tps qps 服务器 仪表盘 监控" },
    { commandId: "open-top-sql", labelKey: "quickOpen.commands.topSql", descKey: "quickOpen.commands.topSqlDesc", keywords: "top sql dbe_perf pg_stat_statements 慢sql 性能" },
    { commandId: "open-storage-bloat", labelKey: "quickOpen.commands.storageBloat", descKey: "quickOpen.commands.storageBloatDesc", keywords: "storage bloat vacuum dead tuples unused index tablespace 空间 膨胀 死元组 索引" },
    { commandId: "open-guc-parameters", labelKey: "quickOpen.commands.gucParameters", descKey: "quickOpen.commands.gucParametersDesc", keywords: "guc pg_settings config parameters runtime 运行参数 配置" },
    { commandId: "open-recycle-bin", labelKey: "quickOpen.commands.recycleBin", descKey: "quickOpen.commands.recycleBinDesc", keywords: "recyclebin flashback timecapsule 回收站 闪回" },
    { commandId: "open-invalid-objects", labelKey: "quickOpen.commands.invalidObjects", descKey: "quickOpen.commands.invalidObjectsDesc", keywords: "invalid objects routine health 失效对象 健康检查" },
    { commandId: "open-schema-diff", labelKey: "quickOpen.commands.schemaDiff", descKey: "quickOpen.commands.schemaDiffDesc", keywords: "schema diff compare 结构对比 同步" },
    { commandId: "open-data-compare", labelKey: "quickOpen.commands.dataCompare", descKey: "quickOpen.commands.dataCompareDesc", keywords: "data compare diff 数据对比" },
    { commandId: "open-settings", labelKey: "quickOpen.commands.settings", descKey: "quickOpen.commands.settingsDesc", keywords: "settings preferences 偏好 设置" },
    { commandId: "new-connection", labelKey: "quickOpen.commands.newConnection", descKey: "quickOpen.commands.newConnectionDesc", keywords: "new connection 新建连接" },
  ];

  const commandItems = computed<QuickOpenItem[]>(() =>
    QUICK_OPEN_COMMANDS.map((cmd) => {
      const label = String(i18n.global.t(cmd.labelKey));
      const description = String(i18n.global.t(cmd.descKey));
      return {
        id: `cmd-${cmd.commandId}`,
        type: "command" as const,
        label,
        description,
        connectionId: "",
        commandId: cmd.commandId,
        searchText: `${label} ${cmd.keywords}`,
      };
    }),
  );

  function collectConnectionDatabases(nodes: any[], connectionId: string, databases: Set<string>): void {
    for (const node of nodes) {
      if (node.connectionId === connectionId && node.type === "database" && node.database) {
        databases.add(node.database);
      }
      if (node.children) collectConnectionDatabases(node.children, connectionId, databases);
    }
  }

  function remoteSearchContexts(): Array<{ conn: ConnectionConfig; database: string }> {
    if (typeof connectionStore.listCompletionTables !== "function") return [];

    const databasesByConnection: Array<{ conn: ConnectionConfig; databases: string[] }> = [];
    const orderedConnections = [...connectionStore.connections].sort((left, right) => {
      const priority = (conn: ConnectionConfig) => {
        if (conn.id === connectionStore.activeConnectionId) return 0;
        if (connectionStore.connectedIds.has(conn.id)) return 1;
        return 2;
      };
      return priority(left) - priority(right);
    });
    for (const conn of orderedConnections) {
      // listCompletionTables connects on demand. Keeping disconnected connections
      // out here makes quick-open blind to unloaded tables after a cold start.
      if (REMOTE_SEARCH_UNSUPPORTED_TYPES.has(conn.db_type)) continue;
      const databases = new Set<string>();
      collectConnectionDatabases(connectionStore.treeNodes, conn.id, databases);
      if (conn.database?.trim()) databases.add(conn.database.trim());
      for (const database of conn.visible_databases ?? []) {
        if (database.trim()) databases.add(database.trim());
      }
      const defaultDatabase = resolveDefaultDatabase(conn, [...databases]);
      if (defaultDatabase) databases.add(defaultDatabase);
      if (databases.size > 0) databasesByConnection.push({ conn, databases: [...databases] });
    }

    const contexts: Array<{ conn: ConnectionConfig; database: string }> = [];
    for (let databaseIndex = 0; contexts.length < REMOTE_SEARCH_MAX_REQUESTS; databaseIndex++) {
      let added = false;
      for (const { conn, databases } of databasesByConnection) {
        const database = databases[databaseIndex];
        if (!database) continue;
        contexts.push({ conn, database });
        added = true;
        if (contexts.length >= REMOTE_SEARCH_MAX_REQUESTS) break;
      }
      if (!added) break;
    }
    return contexts;
  }

  async function acquireRemoteRequestSlot(generation: number): Promise<boolean> {
    if (generation !== remoteSearchGeneration) return false;
    if (activeRemoteRequests < REMOTE_SEARCH_CONCURRENCY) {
      activeRemoteRequests++;
      return true;
    }
    return new Promise<boolean>((resolve) => remoteRequestWaiters.push({ generation, resolve }));
  }

  function cancelStaleRemoteRequestWaiters(generation: number): void {
    for (let index = remoteRequestWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = remoteRequestWaiters[index]!;
      if (waiter.generation === generation) continue;
      remoteRequestWaiters.splice(index, 1);
      waiter.resolve(false);
    }
  }

  function releaseRemoteRequestSlot(): void {
    let next = remoteRequestWaiters.shift();
    while (next && next.generation !== remoteSearchGeneration) {
      next.resolve(false);
      next = remoteRequestWaiters.shift();
    }
    if (next) next.resolve(true);
    else activeRemoteRequests--;
  }

  async function runRemoteSearch(query: string, generation: number, contexts: Array<{ conn: ConnectionConfig; database: string }>): Promise<void> {
    const groups = contexts.map(() => [] as QuickOpenItem[]);
    await Promise.all(
      contexts.map(async ({ conn, database }, index) => {
        const acquired = await acquireRemoteRequestSlot(generation);
        if (!acquired) return;
        try {
          // A newer query may supersede queued work before it reaches the metadata API.
          if (generation !== remoteSearchGeneration) return;
          const tables = await connectionStore.listCompletionTables(conn.id, database, query, REMOTE_SEARCH_RESULTS_PER_REQUEST, undefined, true, undefined, undefined, { activateConnection: false });
          if (generation !== remoteSearchGeneration) return;
          groups[index] = tables.slice(0, REMOTE_SEARCH_RESULTS_PER_REQUEST).map((table) => remoteTableItem(table, conn, database));
          remoteItems.value = groups.flat().slice(0, REMOTE_SEARCH_MAX_RESULTS);
        } catch {
          return;
        } finally {
          releaseRemoteRequestSlot();
        }
      }),
    );
  }

  /**
   * Reload external SQL files when folder paths or folder contents change.
   * `sqlFileFoldersVersion` is bumped by SqlFilePanel on add/remove/refresh.
   */
  watch(sqlFileFoldersVersion, () => {
    sqlFilesLoadGeneration++;
    sqlFilesLoaded = false;
    sqlFileItems.value = [];
    void loadExternalSqlFiles();
  });

  watch(
    searchQuery,
    (query) => {
      const generation = ++remoteSearchGeneration;
      cancelStaleRemoteRequestWaiters(generation);
      if (remoteSearchTimer) clearTimeout(remoteSearchTimer);
      remoteItems.value = [];

      const normalizedQuery = query.trim();
      if (normalizedQuery.startsWith(">")) return;

      // Ensure external SQL files are loaded when the user starts searching
      if (normalizedQuery.length > 0 && !sqlFilesLoaded && !sqlFilesLoadingPromise) {
        void loadExternalSqlFiles();
      }

      if (normalizedQuery.length < REMOTE_SEARCH_MIN_QUERY_LENGTH) return;
      const contexts = remoteSearchContexts();
      if (contexts.length === 0) return;

      remoteSearchTimer = setTimeout(() => {
        remoteSearchTimer = undefined;
        void runRemoteSearch(normalizedQuery, generation, contexts);
      }, REMOTE_SEARCH_DEBOUNCE_MS);
    },
    { flush: "sync" },
  );

  const filteredItems = computed((): MatchedItem[] => {
    const trimmed = searchQuery.value.trim();
    if (!trimmed) {
      // Show all tree items plus open tabs and a limited set of recent SQL library/external files
      return [...openTabItems.value, ...allItems.value, ...sqlLibraryRecentItems.value, ...sqlFileRecentItems.value].map((item) => ({
        ...item,
        matchScore: Infinity,
        matchIndices: [],
      }));
    }

    if (trimmed.startsWith(">")) {
      const commandQuery = trimmed.slice(1).trim();
      if (!commandQuery) {
        return commandItems.value.map((item) => ({
          ...item,
          matchScore: Infinity,
          matchIndices: [],
        }));
      }
      const matchedCommands: MatchedItem[] = [];
      for (const item of commandItems.value) {
        const result = fuzzyMatch(commandQuery, item.searchText);
        if (result) {
          const labelMatch = fuzzyMatch(commandQuery, item.label);
          matchedCommands.push({
            ...item,
            matchScore: labelMatch ? Math.min(result.score, labelMatch.score) : result.score,
            matchIndices: labelMatch?.indices ?? [],
          });
        }
      }
      matchedCommands.sort((a, b) => a.matchScore - b.matchScore || a.label.localeCompare(b.label));
      return matchedCommands.slice(0, QUICK_OPEN_MAX_RESULTS);
    }

    const matched: MatchedItem[] = [];

    const seen = new Set<string>();
    // When searching without the `>` command prefix, include open tabs, database objects, SQL library files, and external SQL files
    for (const item of [...openTabItems.value, ...allItems.value, ...sqlLibraryAllItems.value, ...sqlFileItems.value, ...remoteItems.value]) {
      const key = quickOpenItemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      const result = fuzzyMatch(searchQuery.value, item.searchText);
      if (result) {
        const labelMatch = fuzzyMatch(searchQuery.value, item.label);
        matched.push({
          ...item,
          matchScore: result.score,
          matchIndices: labelMatch?.indices ?? [],
        });
      }
    }

    // Sort by score and type
    const typeOrder: Record<QuickOpenItem["type"], number> = {
      open_tab: 0,
      command: 1,
      connection: 2,
      database: 3,
      schema: 4,
      table: 5,
      view: 6,
      materialized_view: 7,
      synonym: 8,
      procedure: 9,
      function: 10,
      trigger: 11,
      sequence: 12,
      package: 13,
      "package-body": 14,
      job: 15,
      scheduler: 16,
      sql_library_file: 17,
      sql_file: 18,
    };
    matched.sort((a, b) => {
      if (a.matchScore !== b.matchScore) {
        return a.matchScore - b.matchScore; // Lower scores (better matches) come first
      }
      return typeOrder[a.type] - typeOrder[b.type];
    });

    return matched.slice(0, QUICK_OPEN_MAX_RESULTS);
  });

  const selectedItem = computed((): MatchedItem | null => {
    if (selectedIndex.value < 0 || selectedIndex.value >= filteredItems.value.length) {
      return null;
    }
    return filteredItems.value[selectedIndex.value];
  });

  function selectNext(): void {
    if (selectedIndex.value < filteredItems.value.length - 1) {
      selectedIndex.value++;
    }
  }

  function selectPrevious(): void {
    if (selectedIndex.value > 0) {
      selectedIndex.value--;
    }
  }

  function resetSelection(): void {
    selectedIndex.value = 0;
  }

  function setQuery(query: string): void {
    searchQuery.value = query;
    resetSelection();
  }

  return {
    searchQuery,
    isCommandMode,
    filteredItems,
    selectedIndex,
    selectedItem,
    selectNext,
    selectPrevious,
    resetSelection,
    setQuery,
    loadExternalSqlFiles,
  };
}
