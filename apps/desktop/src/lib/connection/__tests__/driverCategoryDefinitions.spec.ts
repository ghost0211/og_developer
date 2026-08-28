import { describe, expect, it } from "vitest";
import { AGENT_DRIVER_CATEGORY_MAP, DRIVER_CATEGORIES, assertAgentDriverCategoriesComplete, getCategoryForAgentDriver } from "@/lib/connection/driver-category-definitions";

describe("getCategoryForAgentDriver", () => {
  it("returns correct category for supported drivers", () => {
    expect(getCategoryForAgentDriver("postgres")).toBe("sql");
    expect(getCategoryForAgentDriver("opengauss")).toBe("domestic");
  });

  it('returns "all" for unknown keys', () => {
    expect(getCategoryForAgentDriver("")).toBe("all");
    expect(getCategoryForAgentDriver("unknown_driver_xyz")).toBe("all");
    expect(getCategoryForAgentDriver("nosuchdriver")).toBe("all");
    expect(getCategoryForAgentDriver("random-string-123")).toBe("all");
  });
});

describe("assertAgentDriverCategoriesComplete", () => {
  it("does not throw when all keys mapped", () => {
    const mappedKeys = Object.keys(AGENT_DRIVER_CATEGORY_MAP);

    expect(() => assertAgentDriverCategoriesComplete(mappedKeys)).not.toThrow();
  });

  it("throws when a key is missing", () => {
    const mappedKeys = Object.keys(AGENT_DRIVER_CATEGORY_MAP);

    expect(() => assertAgentDriverCategoriesComplete([...mappedKeys, "no_such_driver"])).toThrow("unmapped=no_such_driver");
  });
});

describe("AGENT_DRIVER_CATEGORY_MAP integrity", () => {
  it("has no agent driver key mapped to more than one category", () => {
    const entries = Object.entries(AGENT_DRIVER_CATEGORY_MAP);
    const keys = entries.map(([key]) => key);

    const seen = new Set<string>();
    for (const k of keys) {
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it("has all category values listed in DRIVER_CATEGORIES", () => {
    const validCategoryKeys = new Set(DRIVER_CATEGORIES.map((c) => c.key));

    for (const [driverKey, category] of Object.entries(AGENT_DRIVER_CATEGORY_MAP)) {
      expect(validCategoryKeys.has(category), `Driver "${driverKey}" maps to unknown category "${category}"`).toBe(true);
    }
  });

  it("covers all known agent driver keys with no stale entries", () => {
    const expectedKeys = new Set(["opengauss", "postgres"]);
    const actualKeys = Object.keys(AGENT_DRIVER_CATEGORY_MAP);

    expect(actualKeys).toHaveLength(expectedKeys.size);

    const actualSet = new Set(actualKeys);
    const missing = [...expectedKeys].filter((k) => !actualSet.has(k));
    const extra = actualKeys.filter((k) => !expectedKeys.has(k));

    expect(missing, `Missing from AGENT_DRIVER_CATEGORY_MAP: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `Extra keys in AGENT_DRIVER_CATEGORY_MAP not in expected set: ${extra.join(", ")}`).toEqual([]);
  });
});
