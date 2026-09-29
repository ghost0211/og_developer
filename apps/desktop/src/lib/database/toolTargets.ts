import type { ConnectionConfig } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { supportsDatabaseFeature } from "@/lib/database/databaseDriverManifest";
import { connectionSupportsProcessList } from "@/lib/database/processListDrivers";

export type ToolConnectionKind = "processlist" | "pg-stats" | "sql" | "table-import";

export function connectionSupportsTool(connection: ConnectionConfig | undefined, kind: ToolConnectionKind): boolean {
  if (!connection) return false;
  const type = effectiveDatabaseTypeForConnection(connection);
  switch (kind) {
    case "processlist":
      return connectionSupportsProcessList(connection);
    case "pg-stats":
      return type === "postgres" || type === "opengauss";
    case "sql":
      return supportsDatabaseFeature(type, "queryExecution");
    case "table-import":
      return supportsDatabaseFeature(type, "tableImport");
  }
}

export function toolConnections(connections: ConnectionConfig[], kind: ToolConnectionKind): ConnectionConfig[] {
  return connections.filter((connection) => connectionSupportsTool(connection, kind));
}

/**
 * Pick the default target when a tool is opened from the menu: prefer the
 * current editor tab's connection, then the globally active connection, then
 * the first eligible configured connection.
 */
export function pickToolConnection(connections: ConnectionConfig[], kind: ToolConnectionKind, preferredIds: Array<string | null | undefined>): ConnectionConfig | undefined {
  const eligible = toolConnections(connections, kind);
  for (const id of preferredIds) {
    const match = id ? eligible.find((connection) => connection.id === id) : undefined;
    if (match) return match;
  }
  return eligible[0];
}
