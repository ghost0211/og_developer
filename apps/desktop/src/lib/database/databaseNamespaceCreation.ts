import type { ConnectionConfig, DatabaseType, TreeNodeType } from "@/types/database";

export type DatabaseNamespaceCreationTarget = "database" | "schema" | "attach" | "special";

type ConnectionCreationTarget = Extract<DatabaseNamespaceCreationTarget, "database" | "schema" | "attach" | "special">;
type DatabaseNodeCreationTarget = Extract<DatabaseNamespaceCreationTarget, "schema">;

export interface DatabaseNamespaceCreationMatrixEntry {
  connection?: ConnectionCreationTarget;
  database?: DatabaseNodeCreationTarget;
  deferred?: string;
}

type CreationConnection = (Pick<ConnectionConfig, "db_type" | "driver_profile" | "read_only"> & Partial<Pick<ConnectionConfig, "host" | "password">>) | undefined;

// Keep creation target-specific: many products expose schemas or dialect-specific namespaces instead of a top-level database.
export const DATABASE_NAMESPACE_CREATION_MATRIX = {
  postgres: { connection: "database", database: "schema" },
  opengauss: { connection: "database", database: "schema" },
  jdbc: { deferred: "generic JDBC does not expose a reliable dialect-specific create target" },
} satisfies Record<DatabaseType, DatabaseNamespaceCreationMatrixEntry>;

export function connectionNamespaceCreationTarget(connection: CreationConnection): ConnectionCreationTarget | null {
  if (!connection || connection.read_only) return null;
  const entry: DatabaseNamespaceCreationMatrixEntry | undefined = DATABASE_NAMESPACE_CREATION_MATRIX[connection.db_type];
  return entry?.connection ?? null;
}

export function databaseNodeNamespaceCreationTarget(connection: CreationConnection, node: Pick<{ type: TreeNodeType; database?: string | null }, "type" | "database">): DatabaseNodeCreationTarget | null {
  if (!connection || connection.read_only || node.type !== "database" || !node.database) return null;
  const entry: DatabaseNamespaceCreationMatrixEntry | undefined = DATABASE_NAMESPACE_CREATION_MATRIX[connection.db_type];
  return entry?.database ?? null;
}

export function canCreateConnectionNamespace(connection: CreationConnection): boolean {
  return connectionNamespaceCreationTarget(connection) !== null;
}

export function canCreateDatabaseNodeNamespace(connection: CreationConnection, node: Pick<{ type: TreeNodeType; database?: string | null }, "type" | "database">): boolean {
  return databaseNodeNamespaceCreationTarget(connection, node) !== null;
}
