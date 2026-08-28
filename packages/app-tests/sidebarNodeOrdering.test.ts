import assert from "node:assert/strict";
import { test } from "vitest";
import { sortSidebarTreeChildrenForParent } from "../../apps/desktop/src/lib/sidebar/sidebarNodeOrdering.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";





test("keeps connection utility nodes in fixed positions", () => {
  const parent: Pick<TreeNode, "type"> = { type: "connection" };
  const children: TreeNode[] = [
    { id: "conn:__user_admin", label: "tree.userAdmin", type: "user-admin" },
    { id: "conn:z", label: "z", type: "database" },
    { id: "conn:__saved_sql", label: "tree.savedSql", type: "saved-sql-root" },
    { id: "conn:a", label: "a", type: "database" },
  ];

  const sorted = sortSidebarTreeChildrenForParent(parent, children, "postgres");

  assert.deepEqual(
    sorted.map((child) => [child.type, child.label]),
    [
      ["saved-sql-root", "tree.savedSql"],
      ["database", "a"],
      ["database", "z"],
      ["user-admin", "tree.userAdmin"],
    ],
  );
});
