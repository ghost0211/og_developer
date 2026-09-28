import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("queryStore.openTopSqlPanel", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    vi.doMock("@/lib/backend/api", () => ({}));
  });

  it("creates a top-sql tab and activates it", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.openTopSqlPanel({ connectionId: "og-1", database: "tygl_pg", schema: "public" });
    const tab = store.tabs.find((t) => t.id === id);
    expect(tab).toBeTruthy();
    expect(tab!.mode).toBe("top-sql");
    expect(tab!.database).toBe("tygl_pg");
    expect(store.activeTabId).toBe(id);
  });

  it("falls back to the connection's default database", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.openTopSqlPanel({ connectionId: "og-1" });
    const tab = store.tabs.find((t) => t.id === id)!;
    expect(tab.mode).toBe("top-sql");
  });

  it("reuses the existing top-sql tab for the same connection+database+schema", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const first = store.openTopSqlPanel({ connectionId: "og-1", database: "tygl_pg" });
    const second = store.openTopSqlPanel({ connectionId: "og-1", database: "tygl_pg" });
    expect(second).toBe(first);
    expect(store.tabs.filter((t) => t.mode === "top-sql")).toHaveLength(1);
  });
});
