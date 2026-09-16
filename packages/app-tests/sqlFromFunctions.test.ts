import { describe, expect, it } from "vitest";
import { buildSqlCompletionItemsFromContext, getSqlCompletionContext, type SqlCompletionObject } from "../../apps/desktop/src/lib/sql/sqlCompletion";
import { buildSqlSemanticModel } from "../../apps/desktop/src/lib/sql/semantic/model";
import { sqlCompletionContextFromSemantic } from "../../apps/desktop/src/lib/sql/semantic/completion";
const objects: SqlCompletionObject[] = [
  { name: "get_user_roles", schema: "app", type: "function", signature: "p_user_id integer, p_menu_id integer", applyName: "app.get_user_roles" },
  { name: "get_user_roles", schema: "other", type: "function", signature: "integer" },
  { name: "get_proc", schema: "app", type: "procedure", signature: "integer" },
];
function complete(sql: string, databaseType: "opengauss" | "postgres" | "mysql" = "opengauss") {
  const options = { databaseType, dialect: databaseType === "mysql" ? ("mysql" as const) : ("postgres" as const) };
  const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, sql.length, options), getSqlCompletionContext(sql, sql.length, options));
  return { context, items: buildSqlCompletionItemsFromContext(context, { ...options, tables: [{ name: "group_roles", schema: "app" }], objects, columnsByTable: new Map(), currentSchema: "app" }) };
}
describe("FROM routine completion", () => {
  it.each(["select * from app.g", "select * from app.", "select * from users u join app.g", "select * from users u, app.g", "select * from users u cross join lateral app.g"])("offers schema functions in %s", (sql) => {
    const { context, items } = complete(sql);
    expect(context.tableFunctionContext).toBe(true);
    expect(context.suggestRoutines).toBe(true);
    const routines = items.filter((item) => item.type === "function");
    expect(routines.map((item) => item.label)).toEqual(["get_user_roles"]);
    expect(routines[0]?.apply).toBe("get_user_roles(${1:p_user_id}, ${2:p_menu_id})${3}");
    expect(items.some((item) => item.detail?.startsWith("alias for"))).toBe(false);
  });
  it.each(["update app.g", "insert into app.g", "delete from app.g"])("excludes functions from mutation targets: %s", (sql) => {
    const { context, items } = complete(sql);
    expect(context.tableFunctionContext).toBe(false);
    expect(items.some((item) => item.type === "function")).toBe(false);
  });
  it("retains table candidates and limits the new rule to PostgreSQL-compatible dialects", () => {
    expect(complete("select * from app.g").items.some((item) => item.label === "group_roles")).toBe(true);
    expect(complete("select * from app.g", "mysql").items.some((item) => item.type === "function")).toBe(false);
  });
});
