import { describe, expect, it } from "vitest";
import { filterLocallySearchedTables } from "@/lib/sidebar/localTableSearch";
import { buildTableTreeNodes } from "@/lib/table/tableTree";
import type { TableInfo, TreeNode } from "@/types/database";

const scope = { nodeId: "c:biz:app:tables", connectionId: "c", database: "biz", schema: "app" };
const entries: TableInfo[] = [
  { name: "tbl_accounts", table_type: "TABLE", comment: "用户账号档案" },
  { name: "tbl_orders", table_type: "TABLE", comment: "销售订单" },
  { name: "v_users", table_type: "VIEW", comment: "用户汇总" },
  { name: "mv_users", table_type: "MATERIALIZED_VIEW", comment: "用户统计" },
];
function fixture(): TreeNode[] {
  return [{ id: scope.nodeId, label: "Tables", type: "group-tables", connectionId: "c", database: "biz", schema: "app", children: buildTableTreeNodes({ ...scope, tables: entries }) }];
}
function search(nodes: TreeNode[], query: string, index?: TableInfo[] | null) {
  return filterLocallySearchedTables(nodes, { enabled: true, epoch: 0, queries: { [scope.nodeId]: query }, indexedResults: index === undefined ? {} : { [scope.nodeId]: { epoch: 0, entries: index } } });
}
const names = (nodes: TreeNode[]) => nodes[0]!.children!.map((node) => node.label).sort();

describe("local table comment search", () => {
  it.each([undefined, null])("matches comments in loaded nodes when index is %s", (index) => {
    const nodes = fixture();
    nodes[0]!.children!.push({ id: "function", label: "helper", type: "function", comment: "用户账号" });
    const result = search(nodes, "用户", index);
    expect(names(result)).toEqual(["mv_users", "tbl_accounts", "v_users"]);
    expect(nodes[0]!.children).toHaveLength(5);
    expect(result[0]!.children!.find((node) => node.label === "tbl_accounts")).toBe(nodes[0]!.children!.find((node) => node.label === "tbl_accounts"));
  });

  it("uses index comments for unloaded tables and retains loaded node identity/state", () => {
    const nodes = fixture();
    const live = nodes[0]!.children!.find((node) => node.label === "tbl_accounts")!;
    live.isExpanded = true;
    live.isLoading = true;
    live.children = [{ id: `${live.id}:columns`, label: "Columns", type: "group-columns" }];
    const index = [...entries, { name: "archive_users", table_type: "TABLE", comment: "用户历史" }];
    const result = search(nodes, "用户", index);
    expect(names(result)).toEqual(["archive_users", "mv_users", "tbl_accounts", "v_users"]);
    const found = result[0]!.children!.find((node) => node.label === "tbl_accounts")!;
    expect(found).toBe(live);
    expect(found.children).toBe(live.children);
    expect(found.isExpanded).toBe(true);
    expect(found.isLoading).toBe(true);
    expect(found.id).toBe(live.id);
    expect(found.label).toBe("tbl_accounts");
  });

  it("preserves case-insensitive names, abbreviation and regex matching", () => {
    expect(names(search(fixture(), "TBL_ACCOUNTS"))).toEqual(["tbl_accounts"]);
    expect(names(search(fixture(), "ta"))).toContain("tbl_accounts");
    expect(names(search(fixture(), "/^TBL_A/"))).toEqual(["tbl_accounts"]);
    expect(names(search(fixture(), "订单"))).toEqual(["tbl_orders"]);
  });

  it("keeps empty complete indexes empty instead of falling back to stale nodes", () => {
    expect(names(search(fixture(), "用户", []))).toEqual([]);
  });

  it("returns original nodes without a query or when local search is disabled", () => {
    const nodes = fixture();
    expect(search(nodes, " ")).toBe(nodes);
    expect(filterLocallySearchedTables(nodes, { enabled: false, epoch: 0, queries: { [scope.nodeId]: "用户" }, indexedResults: {} })).toBe(nodes);
  });

  it("does not recreate old relation names from an index after metadata refresh", () => {
    const freshEntries = entries.map((entry) => (entry.name === "tbl_accounts" ? { ...entry, name: "archived_accounts" } : entry));
    const nodes = fixture();
    nodes[0]!.children = buildTableTreeNodes({ ...scope, tables: freshEntries });
    const result = filterLocallySearchedTables(nodes, {
      enabled: true,
      epoch: 1,
      queries: { [scope.nodeId]: "用户" },
      indexedResults: { [scope.nodeId]: { epoch: 0, entries } },
    });
    expect(names(result)).toEqual(["archived_accounts", "mv_users", "v_users"]);
    expect(result[0]!.children!.find((node) => node.label === "archived_accounts")).toBe(nodes[0]!.children!.find((node) => node.label === "archived_accounts"));
  });

  it("handles absent comments and scopes filtering to the selected schema/group", () => {
    const nodes = fixture();
    nodes[0]!.children![0]!.comment = undefined;
    const unrelated: TreeNode = { id: "other", label: "Other", type: "schema", children: [{ id: "other:x", label: "x", type: "table", comment: "用户" }] };
    const result = search([...nodes, unrelated], "no-such-comment");
    expect(names(result)).toEqual([]);
    expect(result[1]).toBe(unrelated);
  });
});
