import type { ColumnInfo, DatabaseType, IndexInfo } from "@/types/database";
import { getDatabaseCapability } from "@/lib/database/databaseCapabilities";

function isViewTableType(tableType?: string): boolean {
  return tableType?.toUpperCase().includes("VIEW") === true;
}

export function editablePrimaryKeys(_databaseType: DatabaseType | undefined, columns: ColumnInfo[], _tableType?: string): string[] {
  return columns.filter((column) => column.is_primary_key).map((column) => column.name);
}

export function editableRowIdentifierColumns(databaseType: DatabaseType | undefined, columns: ColumnInfo[], indexes?: IndexInfo[], tableType?: string): string[] {
  const primaryKeys = editablePrimaryKeys(databaseType, columns, tableType);
  if (primaryKeys.length > 0) return primaryKeys;
  const uniqueIndex = indexes?.filter((index) => !index.filter && index.columns.length > 0 && (index.is_primary || index.is_unique)).sort((left, right) => Number(right.is_primary) - Number(left.is_primary) || left.columns.length - right.columns.length)[0];
  return uniqueIndex?.columns ?? [];
}

export function isTableDataEditable(databaseType: DatabaseType | undefined, primaryKeys: string[], tableType?: string): boolean {
  if (isViewTableType(tableType)) return false;
  const cap = getDatabaseCapability(databaseType).tableData;
  if (cap.readonly) return false;
  if (cap.insert) return true;
  return primaryKeys.length > 0;
}

export function canInsertTableRows(databaseType: DatabaseType | undefined): boolean {
  return getDatabaseCapability(databaseType).tableData.insert;
}

export function supportsDataGridTransaction(databaseType: DatabaseType | undefined): boolean {
  return getDatabaseCapability(databaseType).tableData.transaction;
}

export function usesKeylessRowPredicate(databaseType: DatabaseType | undefined): boolean {
  return !!getDatabaseCapability(databaseType).tableData.keylessRowPredicate;
}

export function canUseKeylessRowPredicate(databaseType: DatabaseType | undefined, primaryKeys: readonly string[]): boolean {
  return primaryKeys.length === 0 && usesKeylessRowPredicate(databaseType);
}

export function canEditExistingTableRows(databaseType: DatabaseType | undefined, primaryKeys?: string[]): boolean {
  const tableData = getDatabaseCapability(databaseType).tableData;
  if (tableData.readonly) return false;
  if (tableData.updateRequiresPrimaryKey && primaryKeys && primaryKeys.length === 0) return false;
  return true;
}
