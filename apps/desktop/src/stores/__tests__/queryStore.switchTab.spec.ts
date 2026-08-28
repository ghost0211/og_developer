import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryStore } from "@/stores/queryStore";

describe("queryStore switchTab", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    setActivePinia(createPinia());
  });

  it("switches to the same tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    // Create a data tab
    const tabId = queryStore.createTab("pg-1", "app", "users", "data", "public");
    queryStore.activeTabId = tabId;

    // Switch to the same tab (simulating reuseDataTab scenario)
    queryStore.switchTab(tabId);

    // Active tab should still be the same
    expect(queryStore.activeTabId).toBe(tabId);
  });

  it("switches to a different tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    // Create two data tabs
    const tab1Id = queryStore.createTab("pg-1", "app", "users", "data", "public");
    const tab2Id = queryStore.createTab("pg-1", "app", "orders", "data", "public");
    queryStore.activeTabId = tab1Id;

    // Switch to a different tab
    queryStore.switchTab(tab2Id);

    // Active tab should be the new tab
    expect(queryStore.activeTabId).toBe(tab2Id);
  });

  it("reuses an existing special tab when reopening it", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const tabId = queryStore.openObjectBrowser("pg-1", "app", "public");

    const reopenedTabId = queryStore.openObjectBrowser("pg-1", "app", "public");

    expect(reopenedTabId).toBe(tabId);
    expect(queryStore.activeTabId).toBe(tabId);
  });

  it("keeps same-named tabs from different catalogs distinct", async () => {
    const queryStore = useQueryStore();

    const paimonTabId = queryStore.createTab("sr-1", "bi", "events", "query", undefined, undefined, "paimon_catalog");
    const internalTabId = queryStore.createTab("sr-1", "bi", "events", "query", undefined, undefined, "internal");

    expect(internalTabId).not.toBe(paimonTabId);
    expect(queryStore.tabs).toHaveLength(2);
  });

  it("preserves catalog context when duplicating a query tab", async () => {
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("sr-1", "bi", undefined, "query", undefined, "SELECT 1", "paimon_catalog");

    queryStore.duplicateTab(tabId);

    expect(queryStore.tabs).toHaveLength(2);
    expect(queryStore.tabs[1].catalog).toBe("paimon_catalog");
  });

  it("switches catalog and database as one query context", () => {
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("sr-1", "internal_db", undefined, "query");
    const tab = queryStore.tabs.find((candidate) => candidate.id === tabId)!;
    tab.result = {
      columns: ["id"],
      rows: [[1]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    queryStore.updateCatalog(tabId, "paimon_catalog", "bi");

    expect(tab.catalog).toBe("paimon_catalog");
    expect(tab.database).toBe("bi");
    expect(tab.result).toBeUndefined();
  });

  it("stores local data-grid column filters on the tab result", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("pg-1", "app", "users", "data", "public");
    const tab = queryStore.tabs.find((item) => item.id === tabId)!;
    tab.result = {
      columns: ["id", "status"],
      rows: [[1, "active"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    queryStore.updateDataGridLocalColumnFilters(tabId, { "1": ["str:active"] });
    expect(tab.result.local_column_filters).toEqual({ "1": ["str:active"] });

    queryStore.updateDataGridLocalColumnFilters(tabId, {});
    expect(tab.result.local_column_filters).toBeUndefined();
  });

  it("stores hidden data-grid column keys on the tab result", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("pg-1", "app", "users", "data", "public");
    const tab = queryStore.tabs.find((item) => item.id === tabId)!;
    tab.result = {
      columns: ["id", "status"],
      rows: [[1, "active"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    queryStore.updateDataGridHiddenColumnKeys(tabId, ["status\0\0"]);
    expect(tab.result.local_hidden_column_keys).toEqual(["status\0\0"]);

    queryStore.updateDataGridHiddenColumnKeys(tabId, []);
    expect(tab.result.local_hidden_column_keys).toBeUndefined();
  });
});
