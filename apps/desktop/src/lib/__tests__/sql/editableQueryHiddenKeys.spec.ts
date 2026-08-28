import { describe, expect, it } from "vitest";
import { buildQueryWithHiddenPrimaryKeys, hiddenResultColumnIndexes } from "@/lib/sql/editableQueryHiddenKeys";

describe("editable query hidden primary keys", () => {
  it("supports PostgreSQL composite primary keys and avoids alias collisions", () => {
    const result = buildQueryWithHiddenPrimaryKeys({
      sql: 'SELECT "value"\nFROM "items"',
      databaseType: "postgres",
      primaryKeys: ["tenant_id", "item_id"],
      existingResultNames: ["value", "__DBX_PK_0"],
    });

    expect(result?.sql).toBe('SELECT "value", "tenant_id" AS "__DBX_PK_1", "item_id" AS "__DBX_PK_2"\nFROM "items"');
    expect(result?.projections.map((projection) => projection.alias)).toEqual(["__DBX_PK_1", "__DBX_PK_2"]);
  });

  it("preserves openGauss optimizer hints", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT /*+ INDEX(t IDX_USERS_NAME) */ t.NAME\nFROM USERS t",
        databaseType: "opengauss",
        primaryKeys: ["ID"],
        existingResultNames: ["NAME"],
      })?.sql,
    ).toBe('SELECT /*+ INDEX(t IDX_USERS_NAME) */ t.NAME, "ID" AS "__DBX_PK_0"\nFROM USERS t');
  });

  it("inserts openGauss hidden keys before a trailing line comment", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT name -- visible user name\nFROM users",
        databaseType: "opengauss",
        primaryKeys: ["id"],
        existingResultNames: ["name"],
      })?.sql,
    ).toBe('SELECT name, "id" AS "__DBX_PK_0" -- visible user name\nFROM users');
  });

  it("resolves appended aliases to result indexes", () => {
    expect(
      hiddenResultColumnIndexes(
        ["name", "__DBX_PK_0", "__DBX_PK_1"],
        [
          { sourceName: "tenant_id", alias: "__DBX_PK_0" },
          { sourceName: "item_id", alias: "__DBX_PK_1" },
        ],
      ),
    ).toEqual([1, 2]);
    expect(hiddenResultColumnIndexes(["name"], [{ sourceName: "id", alias: "__DBX_PK_0" }])).toEqual([]);
    expect(
      hiddenResultColumnIndexes(
        ["name", "__DBX_PK_1"],
        [
          { sourceName: "tenant_id", alias: "__DBX_PK_0" },
          { sourceName: "item_id", alias: "__DBX_PK_1" },
        ],
      ),
    ).toEqual([1]);
  });
});
