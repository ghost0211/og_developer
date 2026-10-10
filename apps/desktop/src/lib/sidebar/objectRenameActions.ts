import type { ConnectionConfig, TreeNode } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { buildRenameObjectSql, supportsObjectRename } from "@/lib/table/objectRenameSql";
import { createSidebarActionTarget, type SidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
import { treeNodeDataObjectName } from "@/lib/sidebar/treeNodeContext";

function relationType(node: TreeNode) {
  return node.type === "table" ? "TABLE" : node.type === "view" ? "VIEW" : node.type === "materialized_view" ? "MATERIALIZED_VIEW" : undefined;
}

function canRename(node: TreeNode, connection?: ConnectionConfig): boolean {
  const type = relationType(node);
  return !!type && !!node.connectionId && !!node.database && connection?.id === node.connectionId && !connection.read_only && supportsObjectRename(effectiveDatabaseTypeForConnection(connection), type);
}

/** Direct relation rename only. A production guard cancellation has no UI effects. */
export async function executeObjectRename<T>(options: {
  node: TreeNode;
  newName: string;
  getConnection: () => ConnectionConfig | undefined;
  execute: (sql: string, target: SidebarActionTarget) => Promise<T | undefined>;
  onExecuted: (target: SidebarActionTarget, newName: string) => void | Promise<void>;
}): Promise<boolean> {
  const target = createSidebarActionTarget(options.node);
  const newName = options.newName.trim();
  const connection = options.getConnection();
  if (!canRename(target, connection) || !newName || newName === treeNodeDataObjectName(target)) return false;
  const databaseType = effectiveDatabaseTypeForConnection(connection);
  const sql = await buildRenameObjectSql({
    databaseType,
    objectType: relationType(target)!,
    schema: target.schema,
    oldName: treeNodeDataObjectName(target),
    newName,
  });
  // Building SQL may be asynchronous. Recheck the live connection settings
  // rather than trusting the configuration captured when the dialog opened.
  const currentConnection = options.getConnection();
  if (!canRename(target, currentConnection) || effectiveDatabaseTypeForConnection(currentConnection) !== databaseType) return false;
  const result = await options.execute(sql, target);
  if (result === undefined) return false;
  await options.onExecuted(target, newName);
  return true;
}
