import type { ConnectionConfig } from "@/types/database";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";

export type QuickConnectionOpenTarget = { kind: "query"; database: string };

export function quickConnectionOpenTarget(connection: Pick<ConnectionConfig, "db_type" | "database">, databaseOptions: string[] = []): QuickConnectionOpenTarget {
  return { kind: "query", database: resolveDefaultDatabase(connection, databaseOptions) };
}
