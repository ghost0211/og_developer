import { afterEach, expect, it, vi } from "vitest";

// A registry of physical databases exercises the real module's open/load/save
// path: accidentally opening a renamed database produces an empty store.
it("reads and updates pre-upgrade app state in the existing IndexedDB database", async () => {
  vi.resetModules();
  const legacyState = { tabs: [{ id: "existing-tab", sql: "select 1" }] };
  const legacyStore = new Map<string, unknown>([["tabs", legacyState]]);
  const databases = new Map([["dbx-app-state", legacyStore]]);
  const opened: string[] = [];
  const request = <T>(result: T) => {
    const value = { result, onsuccess: null as (() => void) | null };
    queueMicrotask(() => value.onsuccess?.());
    return value;
  };
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("Should persist to IndexedDB");
    },
    removeItem: () => {},
  });
  vi.stubGlobal("indexedDB", {
    open(name: string) {
      opened.push(name);
      const values = databases.get(name) ?? new Map<string, unknown>();
      databases.set(name, values);
      return request({
        transaction: () => ({
          objectStore: () => ({
            get: (key: string) => request(values.get(key)),
            put: (value: unknown, key: string) => {
              values.set(key, value);
              return request(key);
            },
          }),
        }),
      });
    },
  });
  const { loadBrowserAppState, saveBrowserAppState } = await import("../browserAppStateStorage");
  expect(await loadBrowserAppState("tabs")).toEqual(legacyState);
  const updatedState = { tabs: [{ id: "existing-tab", sql: "select 2" }] };
  await saveBrowserAppState("tabs", updatedState);
  expect(await loadBrowserAppState("tabs")).toEqual(updatedState);
  expect(legacyStore.get("tabs")).toEqual(updatedState);
  expect(opened).toEqual(["dbx-app-state"]);
  expect(databases.has("ogdeveloper-app-state")).toBe(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
