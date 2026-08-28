import { SIDEBAR_TREE_ROW_HEIGHT, type FlatTreeNode } from "@/composables/useFlatTree";
import type { QueryTab, TreeNode } from "@/types/database";

export type ActiveTabSidebarTarget =
  | {
      type: "table";
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
    }
  | {
      type: "query-context";
      connectionId: string;
      database: string;
      schema?: string;
    }
  | {
      type: "saved-sql-file";
      savedSqlId: string;
    };

export function activeTabSidebarTarget(tab: QueryTab | undefined | null): ActiveTabSidebarTarget | null {
  if (!tab) return null;

  if (tab.mode === "data") {
    const tableName = tab.tableMeta?.tableName || tab.title;
    if (!tableName) return null;
    return {
      type: "table",
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tab.tableMeta?.schema ?? tab.schema,
      tableName,
    };
  }

  if (tab.savedSqlId) {
    return { type: "saved-sql-file", savedSqlId: tab.savedSqlId };
  }

  if (tab.mode === "query") {
    if (!tab.connectionId || !tab.database) return null;
    return {
      type: "query-context",
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tab.schema,
    };
  }

  return null;
}

function schemaMatches(node: TreeNode, schema: string | undefined): boolean {
  if (!schema) return true;

  if ((node.schema || "") === schema) return true;
  // Some database engines (for example MySQL in database-object tree mode) do
  // not store a separate schema on table nodes. In that case the database name
  // is the effective schema, so a target schema equal to the node database
  // should still resolve to the loaded table node.
  return !node.schema && (node.database || "") === schema;
}

export function matchesTarget(node: TreeNode, target: ActiveTabSidebarTarget): boolean {
  if (target.type === "query-context") {
    if (target.schema) {
      return node.type === "schema" && node.connectionId === target.connectionId && node.database === target.database && node.label === target.schema;
    }
    return node.type === "database" && node.connectionId === target.connectionId && node.label === target.database;
  }

  if (target.type === "saved-sql-file") {
    return node.type === "saved-sql-file" && node.savedSqlId === target.savedSqlId;
  }

  return (node.type === "table" || node.type === "view" || node.type === "materialized_view") && node.connectionId === target.connectionId && node.database === target.database && schemaMatches(node, target.schema) && node.label === target.tableName;
}

export function findSidebarNodeForActiveTab(tab: QueryTab | undefined | null, flatNodes: readonly FlatTreeNode[]): FlatTreeNode | null {
  const target = activeTabSidebarTarget(tab);
  if (!target) return null;
  return findSidebarNodeForTarget(target, flatNodes);
}

export function findSidebarNodeForTarget(target: ActiveTabSidebarTarget, flatNodes: readonly FlatTreeNode[]): FlatTreeNode | null {
  return flatNodes.find((item) => matchesTarget(item.node, target)) ?? null;
}

export function shouldScrollActiveSidebarSelection(options: { activeTabId: string | null | undefined; previousActiveTabId: string | null | undefined; autoSelectEnabled: boolean; previousAutoSelectEnabled: boolean | undefined }): boolean {
  if (!options.autoSelectEnabled) return false;
  return options.activeTabId !== options.previousActiveTabId || (options.autoSelectEnabled && options.previousAutoSelectEnabled === false);
}

// nearest is used for passive auto-selection; smart keeps context for explicit locate actions.
export type SidebarNodeScrollAlign = "nearest" | "top" | "smart";

export function scrollTopForSidebarNode(options: { index: number; currentScrollTop: number; viewportHeight: number; rowHeight?: number; topOcclusionHeight?: number; align?: SidebarNodeScrollAlign }): number {
  const rowHeight = options.rowHeight ?? SIDEBAR_TREE_ROW_HEIGHT;
  if (options.index < 0 || options.viewportHeight <= 0) return options.currentScrollTop;

  const rowTop = options.index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  const topOcclusionHeight = options.topOcclusionHeight ?? 0;
  if (options.align === "top") return Math.max(0, rowTop - topOcclusionHeight);
  if (options.align === "smart") {
    // Similar to IDE Locate: place the target around the upper third of the viewport.
    const availableViewportHeight = Math.max(rowHeight, options.viewportHeight - topOcclusionHeight);
    const smartOffset = Math.max(0, (availableViewportHeight - rowHeight) / 3);
    return Math.max(0, Math.round(rowTop - topOcclusionHeight - smartOffset));
  }

  const viewportTop = options.currentScrollTop + topOcclusionHeight;
  const viewportBottom = options.currentScrollTop + options.viewportHeight;

  if (rowTop < viewportTop) return Math.max(0, rowTop - topOcclusionHeight);
  if (rowBottom > viewportBottom) return Math.max(0, rowBottom - options.viewportHeight);
  return options.currentScrollTop;
}

export function findNodePathForActiveTab(tab: QueryTab | undefined | null, treeNodes: readonly TreeNode[]): TreeNode[] | null {
  const target = activeTabSidebarTarget(tab);
  if (!target) return null;
  return findNodePathForTarget(target, treeNodes);
}

export function findNodePathForTarget(target: ActiveTabSidebarTarget, treeNodes: readonly TreeNode[]): TreeNode[] | null {
  return findPath(treeNodes, (node) => matchesTarget(node, target));
}

function findPath(nodes: readonly TreeNode[], predicate: (node: TreeNode) => boolean, path: TreeNode[] = []): TreeNode[] | null {
  for (const node of nodes) {
    const currentPath = [...path, node];
    if (predicate(node)) return currentPath;
    if (node.children) {
      const result = findPath(node.children, predicate, currentPath);
      if (result) return result;
    }
  }
  return null;
}
