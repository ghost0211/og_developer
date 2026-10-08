import { describe, expect, it } from "vitest";
import { Braces, Eye, Link2, ListTree, ScrollText, Table } from "@lucide/vue";
import { getTreeNodeIconInfo } from "@/lib/sidebar/treeNodeIcon";
import type { TreeNode } from "@/types/database";

function synonymNode(targetKind?: string): TreeNode {
  return { type: "synonym", targetKind } as TreeNode;
}

describe("synonym tree node icons", () => {
  it.each([
    ["r", Table],
    ["v", Eye],
    ["m", Eye],
    ["S", ListTree],
    ["f", Braces],
    ["p", ScrollText],
  ] as const)("uses the target object icon for relkind %s", (targetKind, icon) => {
    expect(getTreeNodeIconInfo(synonymNode(targetKind))?.icon).toBe(icon);
  });

  it("keeps the link icon when the target kind is unresolved or unknown", () => {
    expect(getTreeNodeIconInfo(synonymNode())?.icon).toBe(Link2);
    expect(getTreeNodeIconInfo(synonymNode("x"))?.icon).toBe(Link2);
  });
});
