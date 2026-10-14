import type { DatabaseType } from "@/types/database";

interface ObjectExistenceCheckConnection {
  db_type?: DatabaseType;
  driver_profile?: string | null;
}

const OPENGAUSS_DRIVER_PROFILES = new Set(["opengauss", "opengauss-jdbc", "gaussdb"]);

/**
 * Empty column metadata is ambiguous: a real table can have no visible columns
 * while a missing openGauss/PostgreSQL relation also returns zero catalog rows.
 * The structure editor verifies that empty result through the DDL endpoint,
 * which checks pg_class and fails before the empty result can be persisted.
 */
export function shouldCheckEmptyColumnsObjectExistence(connection?: ObjectExistenceCheckConnection | null): boolean {
  if (!connection) return false;
  if (connection.db_type === "opengauss" || connection.db_type === "postgres") return true;
  return OPENGAUSS_DRIVER_PROFILES.has((connection.driver_profile ?? "").trim().toLowerCase());
}
