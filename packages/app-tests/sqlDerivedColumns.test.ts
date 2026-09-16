import { describe, expect, it } from "vitest";
import { buildSqlCompletionItemsFromContext, getSqlCompletionContext, type SqlCompletionColumn } from "../../apps/desktop/src/lib/sql/sqlCompletion";
import { buildSqlSemanticModel } from "../../apps/desktop/src/lib/sql/semantic/model";
import { sqlCompletionContextFromSemantic } from "../../apps/desktop/src/lib/sql/semantic/completion";
import { getSqlCompletionColumnMetadataTables } from "../../apps/desktop/src/lib/sql/sqlDerivedColumns";

function contextFor(marked: string) {
  const cursor = marked.indexOf("|");
  const sql = marked.replace("|", "");
  const options = { databaseType: "opengauss" as const, dialect: "postgres" as const };
  return sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, cursor, options), getSqlCompletionContext(sql, cursor, options));
}
const columns: SqlCompletionColumn[] = ["system_id", "system_name"].map((name) => ({ name, table: "app_system", schema: "app", dataType: "text" }));
function complete(marked: string, metadata = new Map([["app.app_system", columns]])) {
  const context = contextFor(marked);
  const items = buildSqlCompletionItemsFromContext(context, { tables: [], columnsByTable: metadata, databaseType: "opengauss", dialect: "postgres", currentSchema: "app" });
  return {
    context,
    items,
    names: items
      .filter((item) => item.type === "column")
      .map((item) => item.label)
      .sort(),
  };
}

describe("derived SELECT star columns", () => {
  it("loads the inner table on a cold cache and exposes its columns through the outer alias", () => {
    const sql = "select x.| from (select * from app.app_system) x;";
    const cold = complete(sql, new Map());
    expect(cold.names).toEqual([]);
    const dependencies = getSqlCompletionColumnMetadataTables(cold.context);
    expect(dependencies.map((ref) => [ref.schema, ref.name])).toEqual([["app", "app_system"]]);
    const fetched = new Map(dependencies.map((ref) => [`${ref.schema}.${ref.name}`, columns]));
    const warm = complete(sql, fetched);
    expect(warm.names).toEqual(["system_id", "system_name"]);
    expect(warm.items.find((item) => item.label === "x.*")?.apply).toBe("system_id, x.system_name");
    expect(warm.context.referencedTables.map((ref) => ref.name)).toEqual(["x"]);
  });
  it.each([
    ["select x.| from (select s.*, 1 as extra from app.app_system s) x", ["extra", "system_id", "system_name"]],
    ["select x.| from (select * from (select * from app.app_system) y) x", ["system_id", "system_name"]],
    ["with c as (select * from app.app_system) select x.| from c x", ["system_id", "system_name"]],
    ["with c as (select * from app.app_system), d as (select * from c) select x.| from d x", ["system_id", "system_name"]],
    ["select x.| from (select system_id as id from app.app_system) x", ["id"]],
    ["select x.| from (select * from app.app_system) x(id, name)", ["id", "name"]],
    ["with x(id, name) as (select * from app.app_system) select x.| from x", ["id", "name"]],
    ["select x.| from (select * from app_system) x", ["system_id", "system_name"]],
  ])("resolves %s without leaking other columns", (sql, expected) => {
    expect(complete(sql).names).toEqual(expected);
  });
  it("respects a qualified wildcard in a join and database-qualified metadata", () => {
    const metadata = new Map([
      ["db.app.app_system", columns],
      ["other.app_system", [{ name: "wrong_column", table: "app_system", schema: "other" }]],
    ]);
    expect(complete("select x.| from (select a.* from db.app.app_system a join other.app_system b on a.system_id=b.id) x", metadata).names).toEqual(["system_id", "system_name"]);
  });
  it("does not request physical metadata for explicit CTE columns or recursive aliases", () => {
    const context = contextFor("with recursive x(id) as (select 1 union all select id+1 from x where id<5) select x.| from x");
    expect(getSqlCompletionColumnMetadataTables(context)).toEqual([]);
    expect(complete("with recursive x(id) as (select 1 union all select id+1 from x where id<5) select x.| from x").names).toEqual(["id"]);
  });
});
