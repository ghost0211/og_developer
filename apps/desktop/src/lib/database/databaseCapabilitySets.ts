import type { DatabaseType } from "@/types/database";

export const SCHEMA_AWARE_TYPES = new Set<DatabaseType>(["postgres", "opengauss", "jdbc"]);

// Engines where an object can be addressed as database/catalog.schema.table.
// Keep this narrower than SCHEMA_AWARE_TYPES: PostgreSQL, for example, cannot
// query another database through a three-part name on the same connection.
export const DATABASE_SCHEMA_QUALIFIED_TYPES = new Set<DatabaseType>([]);

export const SINGLE_DATABASE_TYPES = new Set<DatabaseType>([]);

export const CLEARABLE_QUERY_SCHEMA_TYPES = new Set<DatabaseType>([]);

export const FETCH_FIRST_TYPES = new Set<DatabaseType>([]);

export const TREE_SCHEMA_TYPES = new Set<DatabaseType>(["postgres", "opengauss", "jdbc"]);

export const DATABASE_OBJECT_TREE_TYPES = new Set<DatabaseType>(["jdbc"]);

export const PG_LIKE_STRUCTURE_TYPES = new Set<DatabaseType>(["postgres", "opengauss"]);

export const DIAGRAM_SQL_TYPES = new Set<DatabaseType>(["postgres", "opengauss"]);
