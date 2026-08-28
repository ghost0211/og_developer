import type { DatabaseObjectType, DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";

export type RenameableObjectType = DatabaseObjectType;

export interface BuildRenameObjectSqlOptions {
  databaseType?: DatabaseType;
  objectType: RenameableObjectType;
  schema?: string | null;
  oldName: string;
  newName: string;
}

const postgresLikeRenameTypes = new Set<DatabaseType>(["postgres"]);

export function supportsObjectRename(databaseType: DatabaseType | undefined, objectType: RenameableObjectType): boolean {
  if (!databaseType) return false;
  if (objectType === "PROCEDURE" || objectType === "FUNCTION") {
    return false;
  }
  if (postgresLikeRenameTypes.has(databaseType)) return objectType === "TABLE" || objectType === "VIEW" || objectType === "MATERIALIZED_VIEW";
  return false;
}

export function buildRenameObjectSql(options: BuildRenameObjectSqlOptions): Promise<string> {
  return api.buildRenameObjectSql(options);
}
