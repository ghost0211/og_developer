import type { ConnectionConfig, DatabaseType } from "@/types/database";

type SystemNameRules = {
  exact?: ReadonlySet<string>;
  prefixes?: readonly string[];
};

type SchemaFilterOptions = {
  showSystemSchemas?: boolean;
};

function schemaFilterShowSystemSchemas(connection: Partial<Pick<ConnectionConfig, "show_system_schemas">> | undefined, options?: SchemaFilterOptions): boolean {
  return options?.showSystemSchemas ?? connection?.show_system_schemas === true;
}

const SYSTEM_DATABASE_RULES: Partial<Record<DatabaseType, ReadonlySet<string>>> = {
  postgres: new Set(["template0", "template1"]),
  opengauss: new Set(["template0", "template1"]),
};

const POSTGRES_LIKE_SYSTEM_SCHEMA_RULES: SystemNameRules = {
  exact: new Set(["information_schema", "pg_catalog", "pg_toast"]),
  prefixes: ["pg_temp_", "pg_toast_temp_"],
};

const SYSTEM_SCHEMA_RULES: Partial<Record<DatabaseType, SystemNameRules>> = {
  postgres: POSTGRES_LIKE_SYSTEM_SCHEMA_RULES,
  opengauss: {
    exact: new Set(["blockchain", "coverage", "cstore", "db4ai", "dbe_perf", "dbe_pldebugger", "dbe_pldeveloper", "dbe_sql_util", "information_schema", "pg_catalog", "pg_toast", "pkg_service", "snapshot", "sqladvisor", "xmltype"]),
    prefixes: ["pg_temp_", "pg_toast_temp_", "dbe_"],
  },
};

export function visibleDatabaseFilterIsEnabled(visibleDatabases: string[] | undefined): boolean {
  return Array.isArray(visibleDatabases);
}

export function connectionUsesVisibleSchemaFilter(_connection?: Partial<ConnectionConfig>): boolean {
  return false;
}

export function canSaveVisibleDatabaseSelection(selectedNames: string[]): boolean {
  return selectedNames.length > 0;
}

export function filterVisibleDatabaseNames(databaseNames: string[], visibleDatabases: string[] | undefined): string[] {
  if (!visibleDatabaseFilterIsEnabled(visibleDatabases)) return databaseNames;
  const visible = new Set(visibleDatabases);
  return databaseNames.filter((name) => visible.has(name));
}

export function normalizeVisibleDatabaseSelection(selectedNames: string[], databaseNames: string[]): string[] {
  const available = new Set(databaseNames);
  const seen = new Set<string>();
  return selectedNames.filter((name) => {
    if (!available.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

export function isSystemDatabaseName(databaseType: DatabaseType | undefined, databaseName: string): boolean {
  if (!databaseType) return false;
  return SYSTEM_DATABASE_RULES[databaseType]?.has(databaseName.toLowerCase()) ?? false;
}

export function isSystemSchemaName(databaseType: DatabaseType | undefined, schemaName: string): boolean {
  if (!databaseType) return false;
  const normalized = schemaName.toLowerCase();
  const rules = SYSTEM_SCHEMA_RULES[databaseType];
  if (!rules) return false;
  if (rules.exact?.has(normalized)) return true;
  return rules.prefixes?.some((prefix) => normalized.startsWith(prefix)) ?? false;
}

export function filterDatabaseNamesForConnection(databaseNames: string[], connection: Pick<ConnectionConfig, "db_type" | "driver_profile" | "visible_databases"> | undefined): string[] {
  const visibleDatabases = connection?.visible_databases;
  if (visibleDatabaseFilterIsEnabled(visibleDatabases)) {
    return filterVisibleDatabaseNames(databaseNames, visibleDatabases);
  }
  return filterDatabaseNamesForVisiblePicker(databaseNames, connection);
}

export function filterDatabaseNamesForVisiblePicker(databaseNames: string[], connection: Pick<ConnectionConfig, "db_type" | "driver_profile"> | undefined): string[] {
  return databaseNames.filter((name) => !isSystemDatabaseName(connection?.db_type, name));
}

export function filterSchemaNamesForVisiblePicker(schemaNames: string[], connection: Partial<Pick<ConnectionConfig, "db_type" | "username" | "show_system_schemas">> | undefined, options?: SchemaFilterOptions): string[] {
  if (schemaFilterShowSystemSchemas(connection, options)) return schemaNames;
  const currentSchema = connection?.username?.trim().toLowerCase();
  return schemaNames.filter((name) => name.toLowerCase() === currentSchema || !isSystemSchemaName(connection?.db_type, name));
}

export function visibleSchemaFilterIsEnabled(visibleSchemas: Record<string, string[]> | undefined, database: string): boolean {
  return Array.isArray(visibleSchemas?.[database]);
}

export function filterSchemaNamesForConnection(
  schemaNames: string[],
  connection: (Pick<ConnectionConfig, "db_type" | "visible_schemas" | "visible_databases" | "show_system_schemas"> & Partial<Pick<ConnectionConfig, "username">>) | undefined,
  database: string,
  options?: SchemaFilterOptions,
): string[] {
  const visibleSchemas = connection?.visible_schemas;
  if (!visibleSchemaFilterIsEnabled(visibleSchemas, database)) {
    return filterSchemaNamesForVisiblePicker(schemaNames, connection, options);
  }
  const visible = new Set(visibleSchemas![database]);
  return schemaNames.filter((name) => visible.has(name));
}

export function normalizeVisibleSchemaSelection(selectedNames: string[], schemaNames: string[]): string[] {
  const available = new Set(schemaNames);
  const seen = new Set<string>();
  return selectedNames.filter((name) => {
    if (!available.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

const DRAFT_VISIBLE_SCHEMAS_PREFIX = "__visible_schema_draft_";

export function buildDraftVisibleSchemasConnectionId(seed: string): string {
  return `${DRAFT_VISIBLE_SCHEMAS_PREFIX}${seed}`;
}
