import { describe, expect, it } from "vitest";
import { buildSelectAllSql, resolveNewQueryInitialSql, resolveNewQueryTable, resolveNewQueryTarget } from "@/lib/sql/newQueryContext";
import type { ResolveNewQueryTableInput } from "@/lib/sql/newQueryContext";
import type { QueryTab, TreeNode } from "@/types/database";

function dataTab(overrides: Partial<Pick<QueryTab, "mode" | "connectionId" | "database" | "schema" | "tableMeta" | "structureTableName" | "title">> = {}): ResolveNewQueryTableInput["activeTab"] {
  return {
    mode: "data",
    connectionId: "conn-1",
    database: "app_db",
    schema: "public",
    title: "users",
    tableMeta: { schema: "public", tableName: "users", columns: [], primaryKeys: [] },
    ...overrides,
  };
}

function tableNode(overrides: Partial<Pick<TreeNode, "type" | "connectionId" | "database" | "schema" | "tableName" | "label">> = {}): ResolveNewQueryTableInput["selectedTreeNode"] {
  return { type: "table", connectionId: "conn-1", database: "app_db", schema: "public", tableName: "orders", label: "orders", ...overrides };
}

describe("resolveNewQueryTarget", () => {
  it("resolves the target from the active tab", () => {
    expect(
      resolveNewQueryTarget({
        activeTab: {
          connectionId: "conn-1",
          database: "app_db",
          schema: "public",
        },
        connections: [{ id: "conn-1", host: "localhost", database: "app_db", db_type: "postgres" }],
        preferredSource: "tab",
      }),
    ).toEqual({
      connectionId: "conn-1",
      database: "app_db",
      schema: "public",
      catalog: undefined,
      shouldRefreshDefaultDatabase: false,
    });
  });

  it("inherits the schema from active table metadata", () => {
    expect(
      resolveNewQueryTarget({
        activeTab: {
          connectionId: "conn-1",
          database: "app_db",
          tableMeta: {
            schema: "analytics",
            tableName: "events",
            columns: [],
            primaryKeys: [],
          },
        },
        connections: [{ id: "conn-1", host: "localhost", database: "app_db", db_type: "opengauss" }],
      })?.schema,
    ).toBe("analytics");
  });

  it("falls back to the first connection with its default database", () => {
    expect(
      resolveNewQueryTarget({
        connections: [{ id: "conn-1", host: "localhost", database: "", db_type: "postgres" }],
      }),
    ).toEqual({
      connectionId: "conn-1",
      database: "postgres",
      shouldRefreshDefaultDatabase: true,
    });
  });
});

describe("resolveNewQueryTable", () => {
  it("resolves the table from an active data tab", () => {
    const table = resolveNewQueryTable({ activeTab: dataTab(), preferredSource: "tab" });
    expect(table).toEqual({ connectionId: "conn-1", database: "app_db", schema: "public", catalog: undefined, tableName: "users" });
  });

  it("returns null when a data tab has no loaded tableMeta (still loading or errored)", () => {
    // A data tab's title is schema-qualified (e.g. "public.events"), so it must
    // not be used as a bare table name - require the loaded tableMeta instead.
    const table = resolveNewQueryTable({
      activeTab: { mode: "data", connectionId: "conn-1", database: "app_db", schema: "public", title: "public.events" },
      preferredSource: "tab",
    });
    expect(table).toBeNull();
  });

  it("resolves the table from an active structure tab", () => {
    const table = resolveNewQueryTable({
      activeTab: { mode: "structure", connectionId: "conn-1", database: "app_db", schema: "public", structureTableName: "users" },
      preferredSource: "tab",
    });
    expect(table).toEqual({ connectionId: "conn-1", database: "app_db", schema: "public", catalog: undefined, tableName: "users" });
  });

  it("returns null for a query tab with no table context", () => {
    const table = resolveNewQueryTable({
      activeTab: { mode: "query", connectionId: "conn-1", database: "app_db", schema: "public", title: "query_1" },
      preferredSource: "tab",
    });
    expect(table).toBeNull();
  });

  it("resolves the table from a selected sidebar table/view/materialized_view node", () => {
    expect(resolveNewQueryTable({ selectedTreeNode: tableNode(), preferredSource: "sidebar" })?.tableName).toBe("orders");
    expect(resolveNewQueryTable({ selectedTreeNode: tableNode({ type: "view" }), preferredSource: "sidebar" })?.tableName).toBe("orders");
    expect(resolveNewQueryTable({ selectedTreeNode: tableNode({ type: "materialized_view" }), preferredSource: "sidebar" })?.tableName).toBe("orders");
  });

  it("uses the node label when tableName is absent", () => {
    const table = resolveNewQueryTable({
      selectedTreeNode: { type: "table", connectionId: "conn-1", database: "app_db", schema: "public", label: "by_label" },
      preferredSource: "sidebar",
    });
    expect(table?.tableName).toBe("by_label");
  });

  it("ignores sidebar nodes that are not tables", () => {
    const table = resolveNewQueryTable({
      selectedTreeNode: { type: "schema", connectionId: "conn-1", label: "public" },
      preferredSource: "sidebar",
    });
    expect(table).toBeNull();
  });

  it("prefers the active tab when preferredSource is 'tab'", () => {
    const table = resolveNewQueryTable({ activeTab: dataTab(), selectedTreeNode: tableNode(), preferredSource: "tab" });
    expect(table?.tableName).toBe("users");
  });

  it("prefers the sidebar node when preferredSource is 'sidebar'", () => {
    const table = resolveNewQueryTable({ activeTab: dataTab(), selectedTreeNode: tableNode(), preferredSource: "sidebar" });
    expect(table?.tableName).toBe("orders");
  });

  it("falls back to the secondary context when the primary has no table", () => {
    const table = resolveNewQueryTable({
      activeTab: { mode: "query", connectionId: "conn-1", database: "app_db", title: "query_1" },
      selectedTreeNode: tableNode(),
      preferredSource: "tab",
    });
    expect(table?.tableName).toBe("orders");
  });

  it("returns null when no context is available", () => {
    expect(resolveNewQueryTable({})).toBeNull();
    expect(resolveNewQueryTable({ activeTab: null, selectedTreeNode: null })).toBeNull();
  });
});

describe("buildSelectAllSql", () => {
  it("qualifies and quotes a PostgreSQL table with its schema", () => {
    expect(buildSelectAllSql("postgres", { schema: "public", tableName: "users" })).toBe('SELECT * FROM "public"."users"');
  });

  it("qualifies and quotes an openGauss table with its schema", () => {
    expect(buildSelectAllSql("opengauss", { schema: "public", tableName: "users" })).toBe('SELECT * FROM "public"."users"');
  });

  it("passes a JDBC table name through unquoted", () => {
    expect(buildSelectAllSql("jdbc", { tableName: "users" })).toBe("SELECT * FROM users");
  });

  it("escapes embedded quote characters", () => {
    expect(buildSelectAllSql("postgres", { tableName: 'a"b' })).toBe('SELECT * FROM "a""b"');
  });
});

describe("resolveNewQueryInitialSql", () => {
  it("prefills SQL from the active table when enabled", () => {
    expect(
      resolveNewQueryInitialSql({
        activeTab: dataTab(),
        prefillEnabled: true,
        targetConnectionId: "conn-1",
        targetDatabase: "app_db",
        databaseType: "postgres",
      }),
    ).toBe('SELECT * FROM "public"."users"');
  });

  it("leaves new queries empty when the setting is disabled", () => {
    expect(
      resolveNewQueryInitialSql({
        activeTab: dataTab(),
        prefillEnabled: false,
        targetConnectionId: "conn-1",
        targetDatabase: "app_db",
        databaseType: "postgres",
      }),
    ).toBeUndefined();
  });

  it("does not prefill a table from another connection", () => {
    expect(
      resolveNewQueryInitialSql({
        activeTab: dataTab({ connectionId: "conn-2" }),
        prefillEnabled: true,
        targetConnectionId: "conn-1",
        targetDatabase: "app_db",
        databaseType: "postgres",
      }),
    ).toBeUndefined();
  });

  it("does not prefill a table from another database on the same connection", () => {
    expect(
      resolveNewQueryInitialSql({
        activeTab: { mode: "query", connectionId: "conn-1", database: "db_a", title: "query_1" },
        selectedTreeNode: tableNode({ database: "db_b" }),
        preferredSource: "tab",
        prefillEnabled: true,
        targetConnectionId: "conn-1",
        targetDatabase: "db_a",
        databaseType: "postgres",
      }),
    ).toBeUndefined();
  });

  it("leaves new queries empty without a table context", () => {
    expect(
      resolveNewQueryInitialSql({
        prefillEnabled: true,
        targetConnectionId: "conn-1",
        targetDatabase: "app_db",
        databaseType: "postgres",
      }),
    ).toBeUndefined();
  });
});
