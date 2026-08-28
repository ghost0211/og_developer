import type { ConnectionConfig, DatabaseType, TreeNodeType } from "@/types/database";

export type DatabasePropertyEditGroup = "databaseComment" | "schemaComment";

export interface DatabasePropertyEditingEntry {
  database?: DatabasePropertyEditGroup[];
  schema?: DatabasePropertyEditGroup[];
  deferred?: string;
}

type PropertyEditConnection = Pick<ConnectionConfig, "db_type" | "driver_profile" | "read_only"> | undefined;
type DatabaseNode = Pick<{ type: TreeNodeType; database?: string | null }, "type" | "database">;
type SchemaNode = Pick<{ type: TreeNodeType; database?: string | null; schema?: string | null }, "type" | "database" | "schema">;

const POSTGRES_COMMENT_TYPES = new Set<DatabaseType>(["postgres", "opengauss"]);

export const DATABASE_PROPERTY_EDITING_MATRIX = {
  postgres: { database: ["databaseComment"], schema: ["schemaComment"] },
  opengauss: { database: ["databaseComment"], schema: ["schemaComment"] },
  jdbc: { deferred: "generic JDBC does not expose reliable dialect-specific properties" },
} satisfies Record<DatabaseType, DatabasePropertyEditingEntry>;

function entryFor(connection: PropertyEditConnection): DatabasePropertyEditingEntry | null {
  if (!connection || connection.read_only) return null;
  return DATABASE_PROPERTY_EDITING_MATRIX[connection.db_type] ?? null;
}

export function editableDatabasePropertyGroups(connection: PropertyEditConnection, node: DatabaseNode): DatabasePropertyEditGroup[] {
  if (node.type !== "database" || !node.database) return [];
  return entryFor(connection)?.database ?? [];
}

export function editableSchemaPropertyGroups(connection: PropertyEditConnection, node: SchemaNode): DatabasePropertyEditGroup[] {
  if (node.type !== "schema" || !node.database) return [];
  return entryFor(connection)?.schema ?? [];
}

export function canEditDatabaseProperties(connection: PropertyEditConnection, node: DatabaseNode): boolean {
  return editableDatabasePropertyGroups(connection, node).length > 0;
}

export function canEditSchemaProperties(connection: PropertyEditConnection, node: SchemaNode): boolean {
  return editableSchemaPropertyGroups(connection, node).length > 0;
}

export function supportsPostgresStyleComments(databaseType?: DatabaseType): boolean {
  return !!databaseType && POSTGRES_COMMENT_TYPES.has(databaseType);
}
