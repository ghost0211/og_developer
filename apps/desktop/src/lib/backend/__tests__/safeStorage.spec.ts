import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeLocalStorageGet, safeLocalStorageSet, safeLocalStorageRemove } from "../safeStorage";

describe("product storage migration", () => {
  let values: Map<string, string>;
  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("consumes legacy data only after copying it", () => {
    values.set("dbx-theme", "dark");
    expect(safeLocalStorageGet("ogdeveloper-theme")).toBe("dark");
    expect(values.get("ogdeveloper-theme")).toBe("dark");
    expect(values.has("dbx-theme")).toBe(false);
  });
  it("prefers the new value even when empty and clears the stale fallback", () => {
    values.set("dbx-theme", "dark");
    values.set("ogdeveloper-theme", "");
    expect(safeLocalStorageGet("ogdeveloper-theme")).toBe("");
    safeLocalStorageRemove("ogdeveloper-theme");
    expect(safeLocalStorageGet("ogdeveloper-theme")).toBeNull();
  });
  it("clears both names without first reading them", () => {
    values.set("dbx:diagram:test", "legacy");
    safeLocalStorageRemove("ogdeveloper:diagram:test");
    expect(safeLocalStorageGet("ogdeveloper:diagram:test")).toBeNull();
  });
  it("canonicalizes legacy callers and prevents older values reappearing", () => {
    values.set("dbx-theme", "dark");
    safeLocalStorageSet("dbx-theme", "light");
    expect(values.get("ogdeveloper-theme")).toBe("light");
    safeLocalStorageRemove("dbx-theme");
    expect(safeLocalStorageGet("ogdeveloper-theme")).toBeNull();
  });
  it("retains readable legacy data if persisting the migration fails", () => {
    values.set("dbx-theme", "dark");
    globalThis.localStorage.setItem = () => {
      throw new Error("quota");
    };
    expect(safeLocalStorageGet("ogdeveloper-theme")).toBe("dark");
    expect(values.get("dbx-theme")).toBe("dark");
  });
});
