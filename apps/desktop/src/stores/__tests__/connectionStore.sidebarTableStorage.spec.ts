import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("connectionStore sidebar table storage", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("reloads table sizes after refreshing an object list with a newly created table", async () => {
    const listTables = vi.fn().mockResolvedValue([
      { name: "EXISTING_TABLE", table_type: "BASE TABLE", comment: null },
      { name: "NEW_TABLE", table_type: "BASE TABLE", comment: null },
    ]);
    const initialStatistics = deferred<Array<{ name: string; schema: string; total_bytes: number }>>();
    const refreshedStatistics = deferred<Array<{ name: string; schema: string; total_bytes: number }>>();
    const listObjectStatistics = vi.fn().mockReturnValueOnce(initialStatistics.promise).mockReturnValueOnce(refreshedStatistics.promise);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      connectionDatabaseInfo: vi.fn().mockResolvedValue(null),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listObjects: vi.fn().mockResolvedValue([]),
      listObjectStatistics,
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.sidebarObjectDisplay = "simple";
    settingsStore.editorSettings.sidebarObjectInfoMode = "size";

    const connection = {
      id: "opengauss-1",
      name: "openGauss",
      db_type: "opengauss",
      host: "127.0.0.1",
      port: 5432,
      username: "gaussdb",
      password: "",
      database: "postgres",
    } as ConnectionConfig;
    const existingTable: TreeNode = {
      id: "opengauss-1:postgres:public:EXISTING_TABLE",
      label: "EXISTING_TABLE",
      type: "table",
      connectionId: connection.id,
      database: connection.database,
      schema: "public",
    };
    const schemaNode: TreeNode = {
      id: "opengauss-1:postgres:public",
      label: "public",
      type: "schema",
      connectionId: connection.id,
      database: connection.database,
      schema: "public",
      isExpanded: true,
      children: [existingTable],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, children: [schemaNode] }];

    const initialLoad = store.loadSidebarTableStorage({ connectionId: connection.id, database: connection.database, schema: "public" });
    expect(listObjectStatistics).toHaveBeenCalledTimes(1);

    await store.refreshObjectListTreeNode(connection.id, connection.database, "public");
    expect(listObjectStatistics).toHaveBeenCalledTimes(2);

    const currentExistingTable = schemaNode.children?.find((node) => node.label === "EXISTING_TABLE");
    const newTable = schemaNode.children?.find((node) => node.label === "NEW_TABLE");
    refreshedStatistics.resolve([
      { name: "EXISTING_TABLE", schema: "public", total_bytes: 8192 },
      { name: "NEW_TABLE", schema: "public", total_bytes: 16384 },
    ]);
    await vi.waitFor(() => expect(newTable?.sizeBytes).toBe(16384));

    initialStatistics.resolve([{ name: "EXISTING_TABLE", schema: "public", total_bytes: 4096 }]);
    await initialLoad;
    expect(currentExistingTable?.sizeBytes).toBe(8192);
    expect(newTable?.sizeBytes).toBe(16384);
  }, 15000);
});
