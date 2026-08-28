import type { DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";

export interface CreateDatabaseSqlOptions {
  databaseType?: DatabaseType;
  driverProfile?: string | null;
  target?: "database" | "schema" | "catalog" | "namespace";
  parent?: string | null;
  name: string;
  charset?: string;
  collation?: string;
}

export function buildCreateDatabaseSql(options: CreateDatabaseSqlOptions): Promise<string> {
  return api.buildCreateDatabaseSql(options);
}
