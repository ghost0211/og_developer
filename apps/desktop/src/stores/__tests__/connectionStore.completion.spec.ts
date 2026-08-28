import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function postgresConnection(): ConnectionConfig {
  return {
    id: "pg-1",
    name: "Postgres",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
    read_only: false,
  } as ConnectionConfig;
}

function mysqlConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "mysql-1",
    name: "MySQL",
    db_type: "mysql",
    port: 3306,
    username: "root",
  } as ConnectionConfig;
}

function oracleConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "oracle-1",
    name: "Oracle 11g",
    db_type: "oracle",
    port: 1521,
    username: "APP",
    database: "ORCL",
  } as ConnectionConfig;
}

function sapHanaConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "hana-1",
    name: "SAP HANA",
    db_type: "saphana",
    port: 30015,
    username: "SYSTEM",
    database: "",
  } as ConnectionConfig;
}

function sqlServerConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "sqlserver-1",
    name: "SQL Server",
    db_type: "sqlserver",
    port: 1433,
    username: "sa",
    database: "app",
  } as ConnectionConfig;
}

function damengConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "dameng-1",
    name: "Dameng",
    db_type: "dameng",
    port: 5236,
    username: "dbx_test",
    database: "",
  } as ConnectionConfig;
}

function dorisConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "doris-1",
    name: "Doris",
    db_type: "doris",
    port: 9030,
    username: "root",
    database: "sales",
  } as ConnectionConfig;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("connectionStore completion assistant", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("does not replace the active connection during a cold metadata search", async () => {
    const connectDb = vi.fn().mockResolvedValue("pg-1");
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "users", kind: "table", schema: "public" }],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      connectionDatabaseInfo: vi.fn().mockResolvedValue(null),
      connectionIdentifierQuote: vi.fn().mockResolvedValue('"'),
      completionAssistantSearch,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.activeConnectionId = "already-active";

    const tables = await store.listCompletionTables("pg-1", "app", "users", 20, undefined, true, undefined, undefined, { activateConnection: false });

    expect(connectDb).toHaveBeenCalledOnce();
    expect(store.connectedIds.has("pg-1")).toBe(true);
    expect(store.activeConnectionId).toBe("already-active");
    expect(tables).toEqual([{ name: "users", schema: "public", type: "table" }]);
  }, 15_000);

  it("deduplicates in-flight assistant table requests", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "accounts", kind: "table", schema: "public" }],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listSchemas: vi.fn().mockResolvedValue(["public"]),
      listTables: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const [first, second] = await Promise.all([store.listCompletionTables("pg-1", "app", "acc", 20, "public"), store.listCompletionTables("pg-1", "app", "acc", 20, "public")]);

    expect(completionAssistantSearch).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ name: "accounts", schema: "public", type: "table" });
  });

  it("returns fallback metadata when assistant table search fails", async () => {
    const completionAssistantSearch = vi.fn().mockRejectedValue(new Error("assistant unavailable"));
    const listTables = vi.fn().mockResolvedValue([{ name: "accounts", table_type: "BASE TABLE", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listSchemas: vi.fn().mockResolvedValue(["public"]),
      listTables,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const tables = await store.listCompletionTables("pg-1", "app", "acc", 20, "public");

    expect(completionAssistantSearch).toHaveBeenCalledTimes(1);
    expect(listTables).toHaveBeenCalledWith("pg-1", "app", "public", "acc", 20);
    expect(tables).toEqual([{ name: "accounts", schema: "public", type: "table" }]);
  });

  it("keeps schema-qualified local table completion scoped to the selected schema", async () => {
    const completionAssistantSearch = vi.fn().mockRejectedValue(new Error("assistant unavailable"));
    const listTables = vi.fn(async (_connectionId: string, _database: string, schema: string, filter: string) => {
      if (schema === "dim_game_base" && filter === "dim") {
        return [{ name: "dim_game", table_type: "BASE TABLE", comment: null }];
      }
      return [];
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listSchemas: vi.fn().mockResolvedValue(["dim_game_base", "dws_game_sdk_base"]),
      listTables,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const dimTables = await store.listCompletionTables("pg-1", "app", "dim", 20, "dim_game_base");
    const dwsTables = store.lookupLocalCompletionTables("pg-1", "app", "d", 20, "dws_game_sdk_base");

    expect(dimTables).toEqual([{ name: "dim_game", schema: "dim_game_base", type: "table" }]);
    expect(dwsTables).toEqual([]);
  });

  it("preserves table filter casing for assistant searches", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "TEST_USERS", kind: "table", schema: "SYSDBA" }],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listSchemas: vi.fn().mockResolvedValue(["SYSDBA"]),
      listTables: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const tables = await store.listCompletionTables("pg-1", "app", "TEST_", 20, "SYSDBA");

    expect(completionAssistantSearch).toHaveBeenCalledWith(expect.objectContaining({ mask: "TEST_", schema: "SYSDBA", parent_schema: "SYSDBA" }));
    expect(tables).toEqual([{ name: "TEST_USERS", schema: "SYSDBA", type: "table" }]);
  });

  it("rejects assistant columns returned for a different MySQL parent table", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [
        { name: "status", kind: "column", schema: "app", parent_schema: "app", parent_name: "TB_KPI_SET_SCORE_DETAIL", data_type: "tinyint" },
        { name: "priority", kind: "column", schema: "app", parent_schema: "app", parent_name: "tb_kpi_set_score_relationship", data_type: "smallint" },
        { name: "archived_status", kind: "column", schema: "archive", parent_schema: "archive", parent_name: "tb_kpi_set_score_detail", data_type: "tinyint" },
        { name: "legacy_flag", kind: "column", schema: "app", data_type: "tinyint" },
      ],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      getColumns: vi.fn(),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [mysqlConnection()];
    store.connectedIds.add("mysql-1");

    const columns = await store.listCompletionColumns("mysql-1", "app", "tb_kpi_set_score_detail", "app");

    expect(completionAssistantSearch).toHaveBeenCalledWith(expect.objectContaining({ parent_name: "tb_kpi_set_score_detail", parent_schema: "app" }));
    expect(columns.map((column) => [column.name, column.table])).toEqual([
      ["status", "tb_kpi_set_score_detail"],
      ["legacy_flag", "tb_kpi_set_score_detail"],
    ]);
  });

  it("invalidates only the changed table completion metadata", async () => {
    const getColumns = vi.fn(async (_connectionId: string, _database: string, _schema: string, table: string) => [
      {
        name: `${table}_column_${getColumns.mock.calls.length}`,
        data_type: "integer",
        is_nullable: false,
        column_default: null,
        is_primary_key: false,
        extra: null,
      },
    ]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch: vi.fn().mockRejectedValue(new Error("assistant unavailable")),
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [sqlServerConnection()];
    store.connectedIds.add("sqlserver-1");

    await store.listCompletionColumns("sqlserver-1", "app", "users", "dbo");
    await store.listCompletionColumns("sqlserver-1", "app", "orders", "dbo");
    await store.listCompletionColumns("sqlserver-1", "app", "users", "dbo");
    await store.listCompletionColumns("sqlserver-1", "app", "orders", "dbo");
    expect(getColumns.mock.calls.map((call) => call[3])).toEqual(["users", "orders"]);

    expect(store.invalidateCompletionTableCache("sqlserver-1", "app", "users", "dbo")).toBeGreaterThan(0);

    await store.listCompletionColumns("sqlserver-1", "app", "users", "dbo");
    await store.listCompletionColumns("sqlserver-1", "app", "orders", "dbo");
    expect(getColumns.mock.calls.map((call) => call[3])).toEqual(["users", "orders", "users"]);
  });

  it("keeps the same table cached in other catalogs", async () => {
    const getColumns = vi.fn(async (_connectionId: string, _database: string, _schema: string, table: string, catalog?: string) => [
      {
        name: `${catalog}_${table}`,
        data_type: "integer",
        is_nullable: false,
        column_default: null,
        is_primary_key: false,
        extra: null,
      },
    ]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch: vi.fn(),
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [dorisConnection()];
    store.connectedIds.add("doris-1");

    await store.listCompletionColumns("doris-1", "sales", "users", undefined, undefined, "internal");
    await store.listCompletionColumns("doris-1", "sales", "users", undefined, undefined, "hive");
    expect(getColumns.mock.calls.map((call) => call[4])).toEqual(["internal", "hive"]);

    expect(store.invalidateCompletionTableCache("doris-1", "sales", "users", undefined, "internal")).toBeGreaterThan(0);

    await store.listCompletionColumns("doris-1", "sales", "users", undefined, undefined, "internal");
    await store.listCompletionColumns("doris-1", "sales", "users", undefined, undefined, "hive");
    expect(getColumns.mock.calls.map((call) => call[4])).toEqual(["internal", "hive", "internal"]);
  });

  it("loads PostgreSQL routines by prefix and preserves return metadata", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "st_area", kind: "function", schema: "public", data_type: "double precision", comment: "Returns an area" }],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listCompletionObjects: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const objects = await store.listCompletionObjects("pg-1", "app", "st_", 20, "public", undefined, false, "public", ["function"]);

    expect(completionAssistantSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        object_kinds: ["function"],
        mask: "st_",
        schema: "public",
        parent_schema: "public",
        match_mode: "prefix",
      }),
    );
    expect(objects).toEqual([
      expect.objectContaining({
        name: "st_area",
        schema: "public",
        type: "function",
        dataType: "double precision",
        comment: "Returns an area",
        applyName: "st_area",
        boost: 1000,
      }),
    ]);
  });

  it("limits concurrent completion column metadata requests per connection database", async () => {
    const gates = [deferred<any[]>(), deferred<any[]>(), deferred<any[]>(), deferred<any[]>()];
    let activeColumns = 0;
    let maxActiveColumns = 0;
    const getColumns = vi.fn((_connectionId: string, _database: string, _schema: string, table: string) => {
      const index = Number(table.replace("table_", ""));
      activeColumns++;
      maxActiveColumns = Math.max(maxActiveColumns, activeColumns);
      return gates[index].promise.finally(() => {
        activeColumns--;
      });
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch: vi.fn().mockResolvedValue({ candidates: [], incomplete: false, fallback_used: false }),
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const requests = [0, 1, 2, 3].map((index) => store.listCompletionColumns("pg-1", "app", `table_${index}`, "public"));

    await vi.waitFor(() => expect(getColumns).toHaveBeenCalledTimes(2));
    expect(maxActiveColumns).toBe(2);
    gates[0].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);
    await vi.waitFor(() => expect(getColumns).toHaveBeenCalledTimes(3));
    gates[1].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);
    gates[2].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);
    gates[3].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);

    await Promise.all(requests);
    expect(maxActiveColumns).toBe(2);
  });

  it("evicts old completion database entries", async () => {
    const listDatabases = vi.fn(async (connectionId: string) => [{ name: `db_${connectionId}` }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listDatabases,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();

    for (let index = 0; index < 51; index++) {
      const id = `pg-${index}`;
      store.addEphemeralConnection({ ...postgresConnection(), id, name: `Postgres ${index}` });
      await store.listCompletionDatabases(id);
    }

    await store.listCompletionDatabases("pg-0");

    expect(listDatabases).toHaveBeenCalledTimes(52);
  });

  it("invalidates cached completion databases for a connection", async () => {
    const listDatabases = vi
      .fn()
      .mockResolvedValueOnce([{ name: "Archive" }])
      .mockResolvedValueOnce([{ name: "Reporting" }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listDatabases,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [sqlServerConnection()];
    store.connectedIds.add("sqlserver-1");

    expect(await store.listCompletionDatabases("sqlserver-1")).toEqual(["Archive"]);
    expect(await store.listCompletionDatabases("sqlserver-1")).toEqual(["Archive"]);

    store.invalidateCompletionCache("sqlserver-1");

    expect(await store.listCompletionDatabases("sqlserver-1")).toEqual(["Reporting"]);
    expect(listDatabases).toHaveBeenCalledTimes(2);
  });

  it("evicts old completion schema entries", async () => {
    const listSchemas = vi.fn(async (_connectionId: string, database: string) => [`schema_${database}`]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listSchemas,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.addEphemeralConnection(postgresConnection());

    for (let index = 0; index < 51; index++) {
      await store.listCompletionSchemas("pg-1", `db_${index}`);
    }

    await store.listCompletionSchemas("pg-1", "db_0");

    expect(listSchemas).toHaveBeenCalledTimes(52);
  });
});
