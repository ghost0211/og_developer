import type { ConnectionConfig, TreeNode, TriggerInfo } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { quotePostgresIdentifier } from "@/lib/database/databaseUserAdmin";

export type TriggerEnabledMode = "O" | "D" | "R" | "A";

export function normalizeTriggerEnabledMode(mode: string | null | undefined): TriggerEnabledMode | undefined {
  return mode === "O" || mode === "D" || mode === "R" || mode === "A" ? mode : undefined;
}

export function canChangeTriggerEnabledMode(node: TreeNode, connection?: ConnectionConfig): boolean {
  return (
    node.type === "trigger" && !!node.connectionId && node.database != null && !!node.schema && !!node.tableName && !!node.objectName && !!connection && !connection.read_only && effectiveDatabaseTypeForConnection(connection) === "opengauss" && !!normalizeTriggerEnabledMode(node.triggerEnabledMode)
  );
}

/** ENABLE means normal/origin mode (O), not ALWAYS (A) or REPLICA (R). */
export function buildTriggerEnabledSql(node: Pick<TreeNode, "schema" | "tableName" | "objectName">, enabled: boolean): string {
  if (!node.schema || !node.tableName || !node.objectName) throw new Error("Trigger identity is incomplete");
  return `ALTER TABLE ${quotePostgresIdentifier(node.schema)}.${quotePostgresIdentifier(node.tableName)} ${enabled ? "ENABLE" : "DISABLE"} TRIGGER ${quotePostgresIdentifier(node.objectName)};`;
}

/** A cancelled production confirmation returns undefined: no success or refresh. */
export async function executeTriggerEnabledChange<T>(options: { node: TreeNode; connection?: ConnectionConfig; enabled: boolean; execute: (sql: string) => Promise<T | undefined>; onExecuted: () => void | Promise<void> }): Promise<boolean> {
  if (!canChangeTriggerEnabledMode(options.node, options.connection)) return false;
  const result = await options.execute(buildTriggerEnabledSql(options.node, options.enabled));
  if (result === undefined) return false;
  await options.onExecuted();
  return true;
}

/** Synchronize all visible copies using a fresh, table-scoped DB snapshot. */
export function synchronizeTriggerNodes(nodes: readonly TreeNode[], target: Pick<TreeNode, "connectionId" | "database" | "schema" | "tableName">, triggers: readonly TriggerInfo[]): string[] {
  const byName = new Map(triggers.map((trigger) => [trigger.name, trigger]));
  const removedIds: string[] = [];
  const visited = new WeakSet<TreeNode>();
  const visit = (items: readonly TreeNode[]) => {
    for (const node of items) {
      if (visited.has(node)) continue;
      visited.add(node);
      if (node.type === "trigger" && node.connectionId === target.connectionId && node.database === target.database && node.schema === target.schema && node.tableName === target.tableName) {
        const trigger = node.objectName ? byName.get(node.objectName) : undefined;
        if (!trigger) removedIds.push(node.id);
        else {
          node.triggerEnabledMode = trigger.enabled_mode ?? undefined;
          if (node.meta && "name" in node.meta) node.meta = { ...node.meta, ...trigger };
        }
      }
      if (node.children) visit(node.children);
      if (node.hiddenChildren) visit(node.hiddenChildren);
    }
  };
  visit(nodes);
  return removedIds;
}
