import { ref } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { filterDatabaseNamesForConnection } from "@/lib/database/visibleDatabases";
import { usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";

type NamespaceOptionsConnection = Pick<ConnectionConfig, "database" | "db_type" | "driver_profile" | "visible_databases" | "visible_schemas">;

export function databaseOptionsForConnection(databaseNames: string[], connection: Pick<ConnectionConfig, "db_type" | "visible_databases"> | undefined): string[] {
  const names = filterDatabaseNamesForConnection(databaseNames, connection);
  if (names.length === 0 && usesTreeSchemaMode(connection?.db_type)) return [""];
  return names;
}

export async function fetchNamespaceOptionsForConnection(connectionId: string, connection: NamespaceOptionsConnection): Promise<string[]> {
  const databases = await api.listDatabases(connectionId);
  return databaseOptionsForConnection(
    databases.map((database) => database.name),
    connection,
  );
}

export async function fetchSqlFileTargetOptions(connectionId: string, connection: NamespaceOptionsConnection): Promise<string[]> {
  return fetchNamespaceOptionsForConnection(connectionId, connection);
}

export function useDatabaseOptions() {
  const connectionStore = useConnectionStore();

  const databaseOptions = ref<Record<string, string[]>>({});
  const loadingDatabaseOptions = ref<Record<string, boolean>>({});

  async function loadDatabaseOptions(connectionId: string) {
    const connection = connectionStore.getConfig(connectionId);
    if (!connection || loadingDatabaseOptions.value[connectionId]) return;

    loadingDatabaseOptions.value[connectionId] = true;
    try {
      await connectionStore.ensureConnected(connectionId);
      const dbs = await api.listDatabases(connectionId);
      databaseOptions.value[connectionId] = databaseOptionsForConnection(
        dbs.map((db) => db.name),
        connection,
      );
    } finally {
      loadingDatabaseOptions.value[connectionId] = false;
    }
  }

  async function getDatabaseOptions(connectionId: string): Promise<string[]> {
    if (!databaseOptions.value[connectionId]) {
      await loadDatabaseOptions(connectionId);
    }
    return databaseOptions.value[connectionId] ?? [];
  }

  return {
    databaseOptions,
    loadingDatabaseOptions,
    loadDatabaseOptions,
    getDatabaseOptions,
  };
}
