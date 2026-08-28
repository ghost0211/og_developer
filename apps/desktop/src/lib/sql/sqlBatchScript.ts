import type { DatabaseType } from "@/types/database";

/**
 * Joins generated DDL statements into a script for display/copy.
 */
export function joinSqlStatementsForScript(statements: readonly string[], databaseType?: DatabaseType): string {
  void databaseType;
  return statements.join("\n");
}
