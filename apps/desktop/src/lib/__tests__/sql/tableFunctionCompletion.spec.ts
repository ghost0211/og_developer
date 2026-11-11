import { describe, expect, it } from "vitest";
import { postgresTableFunctionCompositeColumnsQuery, postgresTableFunctionOutputColumnsQuery, tableFunctionCompletionColumnsFromResult } from "@/lib/sql/tableFunctionCompletion";
import type { QueryResult } from "@/types/database";

function result(rows: unknown[][]): QueryResult {
  return { columns: ["name", "data_type", "ordinal"], rows, affected_rows: 0, execution_time_ms: 0 };
}

describe("table function completion metadata", () => {
  it("reads RETURNS TABLE and OUT columns from pg_proc with a safely scoped routine name", () => {
    const sql = postgresTableFunctionOutputColumnsQuery("yi_app", "get_menu_tree");

    expect(sql).toContain("n.nspname = 'yi_app'");
    expect(sql).toContain("p.proname = 'get_menu_tree'");
    expect(sql).toContain("IN ('t', 'o', 'b')");
    expect(sql).toContain("p.proallargtypes[gs.ordinal]");
  });

  it("maps output metadata to the visible alias and deduplicates overloads", () => {
    const columns = tableFunctionCompletionColumnsFromResult(
      result([
        ["menu_id", "bigint", 1],
        ["menu_name", "text", 2],
        ["menu_name", "text", 2],
      ]),
      "t",
      "yi_app",
    );

    expect(columns).toEqual([
      { name: "menu_id", table: "t", schema: "yi_app", dataType: "bigint" },
      { name: "menu_name", table: "t", schema: "yi_app", dataType: "text" },
    ]);
  });

  it("supports functions returning a composite type", () => {
    const sql = postgresTableFunctionCompositeColumnsQuery("public", "get_user");

    expect(sql).toContain("relation.reltype = p.prorettype");
    expect(sql).toContain("a.attrelid = relation.oid");
    expect(sql).toContain("NOT a.attisdropped");
  });
});
