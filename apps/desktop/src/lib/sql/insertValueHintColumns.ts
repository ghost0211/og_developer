import type { DatabaseType, SqlServerColumnMetadata } from "@/types/database";

type InsertValueHintColumn = Pick<SqlServerColumnMetadata, "name"> & Partial<Pick<SqlServerColumnMetadata, "is_identity" | "is_computed" | "is_hidden" | "generated_always_type">>;

export function insertValueHintColumnNames(databaseType: DatabaseType | undefined, columns: readonly InsertValueHintColumn[]): string[] {
  void databaseType;
  return columns.map((column) => column.name);
}
