import type { DatabaseType, TreeNode } from "@/types/database";

const sidebarTreeCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortByLabel(nodes: readonly TreeNode[]): TreeNode[] {
  return [...nodes].sort((left, right) => sidebarTreeCollator.compare(left.label, right.label));
}

function sortRecursive(node: TreeNode, databaseType?: DatabaseType): TreeNode {
  const children = node.children ? sortSidebarTreeChildrenForParent(node, node.children, databaseType) : node.children;
  const hiddenChildren = node.hiddenChildren ? sortSidebarTreeChildrenForParent(node, node.hiddenChildren, databaseType) : node.hiddenChildren;
  if (children === node.children && hiddenChildren === node.hiddenChildren) return node;
  return {
    ...node,
    children,
    hiddenChildren,
  };
}

export function sortSidebarTreeChildrenForParent(parent: Pick<TreeNode, "type">, children: readonly TreeNode[], databaseType?: DatabaseType): TreeNode[] {
  const normalized = children.map((child) => sortRecursive(child, databaseType));

  if (parent.type === "connection") {
    const savedSqlNodes = normalized.filter((child) => child.type === "saved-sql-root");
    const userAdminNodes = normalized.filter((child) => child.type === "user-admin");
    const regularChildren = normalized.filter((child) => child.type !== "user-admin" && child.type !== "saved-sql-root");
    const withConnectionUtilityOrder = (children: TreeNode[]) => [...savedSqlNodes, ...children, ...userAdminNodes];

    if (regularChildren.every((child) => child.type === "database")) {
      return withConnectionUtilityOrder(sortByLabel(regularChildren));
    }

    if (regularChildren.every((child) => child.type === "schema")) {
      return withConnectionUtilityOrder(sortByLabel(regularChildren));
    }

    return withConnectionUtilityOrder(regularChildren);
  }

  if (parent.type === "database") {
    if (normalized.every((child) => child.type === "schema")) {
      return sortByLabel(normalized);
    }
  }

  return normalized;
}
