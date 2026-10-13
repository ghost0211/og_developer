import type { ConnectionConfig, TreeNode } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { buildRenameObjectSql, renameObjectRequiresSignature, renameObjectRequiresTableContext, renameObjectTypeForTreeNode, supportsObjectRename } from "@/lib/table/objectRenameSql";
import { createSidebarActionTarget, type SidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
import { treeNodeRenameObjectName } from "@/lib/sidebar/treeNodeContext";

/**
 * Direct `ALTER ... RENAME TO` capability for a sidebar node. Requires a live
 * writable connection and every identity field the generated SQL needs.
 */
export function canRenameTreeNodeObject(node: TreeNode, connection?: ConnectionConfig): boolean {
  const objectType = renameObjectTypeForTreeNode(node.type);
  if (!objectType || !node.connectionId || !connection || connection.id !== node.connectionId || connection.read_only) return false;
  if (!node.database) return false;
  if (node.type === "database" && !(node.database ?? "").trim()) return false;
  if (renameObjectRequiresTableContext(objectType) && !(node.tableName ?? "").trim()) return false;
  return supportsObjectRename(effectiveDatabaseTypeForConnection(connection), objectType);
}

/**
 * Applies a successful rename to the node identity used for pin persistence.
 * Only the renamed field is touched so parent context (tableName/schema) stays
 * valid for table children and routines keep their signature in the label.
 */
export function renamedObjectTreeNode(target: SidebarActionTarget, appliedName: string): TreeNode {
  const next: TreeNode = { ...target };
  if (target.type === "database") {
    next.label = appliedName;
    next.database = appliedName;
    return next;
  }
  if (target.type === "schema") {
    next.label = appliedName;
    next.schema = appliedName;
    return next;
  }
  if (target.type === "column" || target.type === "index" || target.type === "fkey" || target.type === "constraint") {
    next.label = appliedName;
    next.objectName = appliedName;
    if (target.meta && typeof target.meta === "object") next.meta = { ...target.meta, name: appliedName };
    return next;
  }
  if (target.type === "trigger") {
    next.label = appliedName;
    next.objectName = appliedName;
    return next;
  }
  if (target.type === "function" || target.type === "procedure") {
    next.label = target.signature ? `${appliedName}(${target.signature})` : appliedName;
    next.objectName = appliedName;
    return next;
  }
  next.label = appliedName;
  next.objectName = appliedName;
  if (target.type === "table" || target.type === "view" || target.type === "materialized_view") next.tableName = appliedName;
  return next;
}

/** Direct object rename only. A production guard cancellation has no UI effects. */
export async function executeObjectRename<T>(options: {
  node: TreeNode;
  newName: string;
  getConnection: () => ConnectionConfig | undefined;
  execute: (sql: string, target: SidebarActionTarget) => Promise<T | undefined>;
  onExecuted: (target: SidebarActionTarget, newName: string) => void | Promise<void>;
}): Promise<boolean> {
  const target = createSidebarActionTarget(options.node);
  const objectType = renameObjectTypeForTreeNode(target.type);
  const newName = options.newName.trim();
  const oldName = treeNodeRenameObjectName(target);
  const connection = options.getConnection();
  if (!objectType || !canRenameTreeNodeObject(target, connection) || !newName || newName === oldName) return false;
  const databaseType = effectiveDatabaseTypeForConnection(connection);
  const sql = await buildRenameObjectSql({
    databaseType,
    objectType,
    schema: target.schema,
    oldName,
    newName,
    signature: renameObjectRequiresSignature(objectType) ? (target.signature ?? "") : undefined,
    tableName: renameObjectRequiresTableContext(objectType) ? target.tableName : undefined,
  });
  // Building SQL may be asynchronous. Recheck the live connection settings
  // rather than trusting the configuration captured when the dialog opened.
  const currentConnection = options.getConnection();
  if (!canRenameTreeNodeObject(target, currentConnection) || effectiveDatabaseTypeForConnection(currentConnection) !== databaseType) return false;
  const result = await options.execute(sql, target);
  if (result === undefined) return false;
  await options.onExecuted(target, newName);
  return true;
}
