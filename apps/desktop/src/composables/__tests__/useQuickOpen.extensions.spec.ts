import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useQuickOpen } from "../useQuickOpen";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useQueryStore } from "@/stores/queryStore";
import { getSqlFileFolderPaths } from "@/lib/sqlFile/sqlFileFolders";

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: vi.fn(),
}));

vi.mock("@/stores/savedSqlStore", () => ({
  useSavedSqlStore: vi.fn(),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listSqlFilesInFolder: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/sqlFile/sqlFileFolders", () => ({
  getSqlFileFolderPaths: vi.fn(() => []),
  sqlFileFoldersVersion: ref(0),
}));

describe("useQuickOpen extensions (objects, open tabs, command palette)", () => {
  const baseConn = { id: "og1", name: "OG Prod", db_type: "opengauss", database: "appdb" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setActivePinia(undefined);
    vi.mocked(getSqlFileFolderPaths).mockReturnValue([]);
    vi.mocked(useSavedSqlStore).mockReturnValue({ recentFiles: [], allFiles: [] } as any);
  });

  afterEach(() => {
    setActivePinia(undefined);
    vi.useRealTimers();
  });

  it("indexes synonyms, triggers (preserving relationName), jobs, schedulers, and routine signatures", () => {
    vi.mocked(useConnectionStore).mockReturnValue({
      connections: [baseConn],
      activeConnectionId: "og1",
      connectedIds: new Set(["og1"]),
      getConfig: (id: string) => (id === "og1" ? baseConn : undefined),
      treeNodes: [
        {
          id: "og1",
          connectionId: "og1",
          type: "connection",
          label: "OG Prod",
          children: [
            {
              id: "og1:appdb",
              connectionId: "og1",
              type: "database",
              database: "appdb",
              label: "appdb",
              children: [
                {
                  id: "og1:appdb:public",
                  connectionId: "og1",
                  type: "schema",
                  database: "appdb",
                  schema: "public",
                  label: "public",
                  children: [
                    {
                      id: "syn1",
                      connectionId: "og1",
                      type: "synonym",
                      database: "appdb",
                      schema: "public",
                      label: "syn_orders",
                    },
                    {
                      id: "trg1",
                      connectionId: "og1",
                      type: "trigger",
                      database: "appdb",
                      schema: "public",
                      tableName: "orders",
                      label: "trg_orders_audit",
                    },
                    {
                      id: "job1",
                      connectionId: "og1",
                      type: "job",
                      database: "appdb",
                      schema: "public",
                      label: "nightly_cleanup_job",
                    },
                    {
                      id: "sch1",
                      connectionId: "og1",
                      type: "scheduler",
                      database: "appdb",
                      schema: "public",
                      label: "hourly_stats_scheduler",
                    },
                    {
                      id: "fn1",
                      connectionId: "og1",
                      type: "function",
                      database: "appdb",
                      schema: "public",
                      signature: "calc_total(integer)",
                      label: "calc_total",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as any);

    const { filteredItems } = useQuickOpen();
    const byType = new Map(filteredItems.value.map((item) => [`${item.type}:${item.label}`, item]));

    expect(byType.get("synonym:syn_orders")).toBeDefined();
    expect(byType.get("trigger:trg_orders_audit")?.relationName).toBe("orders");
    expect(byType.get("job:nightly_cleanup_job")).toBeDefined();
    expect(byType.get("scheduler:hourly_stats_scheduler")).toBeDefined();
    expect(byType.get("function:calc_total")?.signature).toBe("calc_total(integer)");
  });

  it("maps remote synonymTarget completions to synonym quick-open items", async () => {
    const listCompletionTables = vi.fn().mockResolvedValue([
      {
        name: "emp_syn",
        type: "synonym",
        synonymTarget: { schema: "hr", name: "employees" },
      },
    ]);
    vi.mocked(useConnectionStore).mockReturnValue({
      connections: [baseConn],
      activeConnectionId: "og1",
      connectedIds: new Set(["og1"]),
      getConfig: (id: string) => (id === "og1" ? baseConn : undefined),
      treeNodes: [],
      listCompletionTables,
    } as any);

    const { filteredItems, setQuery } = useQuickOpen();
    setQuery("emp_syn");
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();

    const item = filteredItems.value.find((entry) => entry.label === "emp_syn");
    expect(item?.type).toBe("synonym");
    expect(item?.targetSchema).toBe("hr");
    expect(item?.targetName).toBe("employees");
  });

  it("includes open tabs when Pinia is active", () => {
    setActivePinia(createPinia());
    vi.mocked(useConnectionStore).mockReturnValue({
      connections: [baseConn],
      activeConnectionId: "og1",
      connectedIds: new Set(["og1"]),
      getConfig: (id: string) => (id === "og1" ? baseConn : undefined),
      treeNodes: [],
    } as any);
    vi.mocked(useQueryStore).mockReturnValue({
      activeTabId: "tab-2",
      tabs: [
        { id: "tab-1", connectionId: "og1", database: "appdb", schema: "public", title: "Orders Audit Query", customTitle: true, mode: "query", sql: "" },
        { id: "tab-2", connectionId: "og1", database: "appdb", schema: "public", title: "Storage Bloat", mode: "storage-bloat", sql: "" },
      ],
    } as any);

    const { filteredItems, setQuery } = useQuickOpen();
    expect(filteredItems.value.some((item) => item.type === "open_tab" && item.tabId === "tab-1")).toBe(true);

    setQuery("Orders Audit");
    expect(filteredItems.value[0]?.type).toBe("open_tab");
    expect(filteredItems.value[0]?.tabId).toBe("tab-1");
  });

  it("switches to command palette with `>` prefix and suppresses remote metadata searches", async () => {
    const listCompletionTables = vi.fn().mockResolvedValue([]);
    vi.mocked(useConnectionStore).mockReturnValue({
      connections: [baseConn],
      activeConnectionId: "og1",
      connectedIds: new Set(["og1"]),
      getConfig: (id: string) => (id === "og1" ? baseConn : undefined),
      treeNodes: [],
      listCompletionTables,
    } as any);

    const { filteredItems, isCommandMode, setQuery } = useQuickOpen();

    setQuery("guc");
    expect(isCommandMode.value).toBe(false);
    expect(filteredItems.value.some((item) => item.type === "command")).toBe(false);

    listCompletionTables.mockClear();
    setQuery(">");
    expect(isCommandMode.value).toBe(true);
    expect(filteredItems.value).toHaveLength(13);
    expect(filteredItems.value.every((item) => item.type === "command")).toBe(true);

    setQuery("> guc");
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();
    expect(listCompletionTables).not.toHaveBeenCalled();
    expect(filteredItems.value.some((item) => item.commandId === "open-guc-parameters")).toBe(true);
    expect(filteredItems.value.every((item) => item.type === "command")).toBe(true);
  });
});
