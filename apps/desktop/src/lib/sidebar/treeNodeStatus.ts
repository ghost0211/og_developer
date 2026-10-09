import type { TreeNode } from "@/types/database";

/** Database object state, not whether the sidebar row can be selected/opened. */
export function isTreeNodeDisabled(node: TreeNode): boolean {
  if (node.type === "trigger") return node.triggerEnabledMode === "D";
  if (node.type === "job" || node.type === "scheduler") return node.jobEnabled === false;
  return false;
}
