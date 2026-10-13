import type { DatabaseType, TreeNodeType } from "@/types/database";
import * as api from "@/lib/backend/api";

/**
 * Direct `ALTER ... RENAME TO` targets supported by openGauss/PostgreSQL.
 *
 * `SYNONYM`, `PACKAGE`, `PACKAGE_BODY`, `TYPE_BODY`, `JOB` and `SCHEDULER` are
 * deliberately absent: openGauss has no native rename statement for them.
 */
export type RenameableObjectType = "DATABASE" | "SCHEMA" | "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "SEQUENCE" | "TYPE" | "FUNCTION" | "PROCEDURE" | "TRIGGER" | "INDEX" | "COLUMN" | "CONSTRAINT";

export interface BuildRenameObjectSqlOptions {
  databaseType?: DatabaseType;
  objectType: RenameableObjectType;
  schema?: string | null;
  oldName: string;
  newName: string;
  /** Routine identity argument list without parentheses; required for FUNCTION/PROCEDURE. */
  signature?: string | null;
  /** Parent table for COLUMN/CONSTRAINT/TRIGGER renames. */
  tableName?: string | null;
}

const POSTGRES_LIKE_RENAME_TYPES = new Set<DatabaseType>(["postgres", "opengauss"]);

const DIRECT_RENAME_TYPES = new Set<RenameableObjectType>(["DATABASE", "SCHEMA", "TABLE", "VIEW", "MATERIALIZED_VIEW", "SEQUENCE", "TYPE", "FUNCTION", "PROCEDURE", "TRIGGER", "INDEX", "COLUMN", "CONSTRAINT"]);

const TREE_NODE_RENAME_TYPES: Partial<Record<TreeNodeType, RenameableObjectType>> = {
  database: "DATABASE",
  schema: "SCHEMA",
  table: "TABLE",
  view: "VIEW",
  materialized_view: "MATERIALIZED_VIEW",
  sequence: "SEQUENCE",
  type: "TYPE",
  function: "FUNCTION",
  procedure: "PROCEDURE",
  trigger: "TRIGGER",
  index: "INDEX",
  column: "COLUMN",
  fkey: "CONSTRAINT",
  constraint: "CONSTRAINT",
};

export function supportsObjectRename(databaseType: DatabaseType | undefined, objectType: RenameableObjectType): boolean {
  if (!databaseType || !POSTGRES_LIKE_RENAME_TYPES.has(databaseType)) return false;
  return DIRECT_RENAME_TYPES.has(objectType);
}

export function renameObjectTypeForTreeNode(type: TreeNodeType): RenameableObjectType | null {
  return TREE_NODE_RENAME_TYPES[type] ?? null;
}

export function renameObjectRequiresTableContext(objectType: RenameableObjectType): boolean {
  return objectType === "COLUMN" || objectType === "CONSTRAINT" || objectType === "TRIGGER";
}

export function renameObjectRequiresSignature(objectType: RenameableObjectType): boolean {
  return objectType === "FUNCTION" || objectType === "PROCEDURE";
}

export function buildRenameObjectSql(options: BuildRenameObjectSqlOptions): Promise<string> {
  return api.buildRenameObjectSql(options);
}
