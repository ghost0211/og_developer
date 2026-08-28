import { describe, expect, it } from "vitest";
import { decodeSelectableDatabaseValue, EMPTY_DATABASE_SELECT_VALUE, encodeSelectableDatabaseValue, isDefaultDatabase, resolveDefaultDatabase, TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE } from "@/lib/database/defaultDatabase";

describe("defaultDatabase selectable values", () => {
  it("encodes empty tree-schema databases with the default database sentinel", () => {
    expect(encodeSelectableDatabaseValue("postgres", "")).toBe(TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE);
    expect(decodeSelectableDatabaseValue("postgres", TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE)).toBe("");
    expect(encodeSelectableDatabaseValue("opengauss", "")).toBe(TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE);
    expect(decodeSelectableDatabaseValue("opengauss", TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE)).toBe("");
  });

  it("preserves non-empty database names", () => {
    expect(encodeSelectableDatabaseValue("opengauss", "testdb")).toBe("testdb");
    expect(decodeSelectableDatabaseValue("opengauss", "testdb")).toBe("testdb");
  });

  it("matches PostgreSQL backend defaults when the configured database is empty", () => {
    expect(resolveDefaultDatabase({ db_type: "postgres", database: "" }, [])).toBe("postgres");
    expect(resolveDefaultDatabase({ db_type: "opengauss", database: "" }, [])).toBe("postgres");
    expect(resolveDefaultDatabase({ db_type: "opengauss", database: "app" }, ["app"])).toBe("app");
  });
});
