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

describe("queryStore manual transaction closed events", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    vi.doMock("@/lib/backend/api", () => ({}));
  });

  it("drops the stale session id and flags auto-rollback only on the matching tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabA = store.createTab("pg-1", "app", "query_1");
    const tabB = store.createTab("pg-1", "app", "query_2");
    store.tabs.find((t) => t.id === tabA)!.txnSessionId = "txn-reaped";
    store.tabs.find((t) => t.id === tabB)!.txnSessionId = "txn-alive";

    store.handleManualTxnClosed({ txn_session_id: "txn-reaped" });

    expect(store.tabs.find((t) => t.id === tabA)).toMatchObject({
      txnSessionId: undefined,
      txnAutoRolledBack: true,
    });
    // Unrelated transactions stay untouched.
    expect(store.tabs.find((t) => t.id === tabB)).toMatchObject({
      txnSessionId: "txn-alive",
    });
    expect(store.tabs.find((t) => t.id === tabB)?.txnAutoRolledBack).toBeFalsy();
  });

  it("ignores events for sessions no tab is tracking", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "query_1");

    expect(() => store.handleManualTxnClosed({ txn_session_id: "txn-unknown" })).not.toThrow();
    expect(store.tabs.find((t) => t.id === tabId)?.txnAutoRolledBack).toBeFalsy();
  });
});
