import { describe, expect, it } from "vitest";
import { buildSqlCompletionItemsFromContext, getSqlCompletionContext, type SqlCompletionObject, type SqlCompletionTable } from "@/lib/sql/sqlCompletion";

// 回归：SELECT 列表等列语境里输入 `schema.` 之前什么都不提示——
// 1. 首查把 qualifier 当成当前 schema 下的“名字过滤器”，查不到任何行；
// 2. QueryEditor 的 schema 兜底重写过去会清掉 qualifier，导致带 applyName
//    的例程（connectionStore 对非当前 schema 的候选生成 `schema.name`）
//    插入后变成 `schema.schema.name` 双重限定；
// 3. 重写清掉 exclusiveColumnSuggestions 后，内置函数片段在空前缀下
//    （matchesPrefix 恒真）会全部涌进 `schema.` 弹窗。
//
// 这里用与 QueryEditor 重写后完全相同的语境形状直接测展示层。

const schemaTables: SqlCompletionTable[] = [
  { name: "menu", schema: "app", type: "table" },
  { name: "menu_tree_v", schema: "app", type: "view" },
];

const schemaObjects: SqlCompletionObject[] = [
  // connectionStore.completionAssistantObjects 对非当前 schema 的候选总是带限定 applyName
  { name: "get_menu_tree", schema: "app", type: "function", applyName: "app.get_menu_tree", signature: "p_id integer" },
  { name: "rebuild_menu", schema: "app", type: "procedure", applyName: "app.rebuild_menu" },
];

function buildItems(context: ReturnType<typeof getSqlCompletionContext>, objects: SqlCompletionObject[] = schemaObjects) {
  return buildSqlCompletionItemsFromContext(context, {
    tables: schemaTables,
    objects,
    columnsByTable: new Map(),
    schemas: [],
    databaseType: "opengauss",
    dialect: "postgres",
  });
}

describe("schema-qualified completion outside FROM", () => {
  it("SELECT-list `schema.` starts as an exclusive-column context (precondition for the QueryEditor fallback)", () => {
    const sql = "SELECT app.";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "opengauss", dialect: "postgres" });
    expect(context.qualifier).toBe("app");
    expect(context.prefix).toBe("");
    expect(context.suggestTables).toBe(false);
    expect(context.exclusiveColumnSuggestions).toBe(true);
    expect(context.suggestRoutines).toBe(true);
  });

  it("offers the schema's tables and routines with bare applies after the fallback rewrite", () => {
    const sql = "SELECT app.";
    const base = getSqlCompletionContext(sql, sql.length, { databaseType: "opengauss", dialect: "postgres" });
    // 与 QueryEditor performAsyncCompletionWithResult 的 qualifierIsSchema 重写一致（保留 qualifier）
    const rewritten = { ...base, suggestTables: true, suggestColumns: false, exclusiveColumnSuggestions: false };
    const items = buildItems(rewritten);

    const tableItem = items.find((item) => item.type === "table" && item.label === "menu");
    expect(tableItem).toBeDefined();
    expect(tableItem!.apply).not.toContain(".");

    const viewItem = items.find((item) => item.type === "table" && item.label === "menu_tree_v");
    expect(viewItem).toBeDefined();

    const functionItem = items.find((item) => item.type === "function" && item.label === "get_menu_tree");
    expect(functionItem).toBeDefined();
    // 关键回归断言：不能出现 `app.app.get_menu_tree` 双重限定
    expect(functionItem!.apply).not.toContain("app.");
    expect(functionItem!.apply.startsWith("get_menu_tree(")).toBe(true);

    // 重写打开了 exclusive 闸门后，内置函数片段不得涌入 `schema.` 弹窗
    const builtinFunctionLabels = ["count", "sum", "avg", "now", "coalesce"];
    expect(items.filter((item) => builtinFunctionLabels.includes(item.label.toLowerCase()))).toEqual([]);
  });

  it("CALL `schema.` stays procedure-only (no table items leak into exec context)", () => {
    const sql = "CALL app.";
    const base = getSqlCompletionContext(sql, sql.length, { databaseType: "opengauss", dialect: "postgres" });
    expect(base.exclusiveRoutineSuggestions).toBe(true);
    // 与 QueryEditor 重写一致：exclusiveRoutine 语境下不启用表条目
    const rewritten = { ...base, suggestTables: false, suggestColumns: false, exclusiveColumnSuggestions: false };
    const items = buildItems(rewritten);

    expect(items.some((item) => item.type === "table")).toBe(false);
    const procedureItem = items.find((item) => item.label === "rebuild_menu");
    expect(procedureItem).toBeDefined();
    expect(procedureItem!.apply).not.toContain("app.");
    expect(items.some((item) => item.label === "get_menu_tree")).toBe(false);
  });

  it("a non-empty prefix after the dot still filters schema objects", () => {
    const sql = "SELECT app.get";
    const base = getSqlCompletionContext(sql, sql.length, { databaseType: "opengauss", dialect: "postgres" });
    expect(base.qualifier).toBe("app");
    expect(base.prefix).toBe("get");
    const rewritten = { ...base, suggestTables: true, suggestColumns: false, exclusiveColumnSuggestions: false };
    const items = buildItems(rewritten);

    expect(items.some((item) => item.label === "get_menu_tree")).toBe(true);
    expect(items.some((item) => item.label === "menu")).toBe(false);
  });
});
