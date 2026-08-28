import type { DatabaseType } from "@/types/database";
import type { EditableStructureIndex } from "@/lib/table/tableStructureEditorSql";

export type TableStructureDialect = "postgres" | "unsupported";
export type TableStructureAlterStrategy = "none" | "direct";

export interface TableStructureCapabilities {
  dialect: TableStructureDialect;
  alterStrategy: TableStructureAlterStrategy;
  createTable: boolean;
  addColumn: boolean;
  dropColumn: boolean;
  renameColumn: boolean;
  alterExistingColumn: boolean;
  alterType: boolean;
  alterNullability: boolean;
  alterDefault: boolean;
  alterPrimaryKey: boolean;
  reorderColumn: boolean;
  comment: boolean;
  createIndex: boolean;
  dropIndex: boolean;
  rebuildIndex: boolean;
  indexType: boolean;
  indexInclude: boolean;
  indexFilter: boolean;
  indexComment: boolean;
  foreignKey: boolean;
}

const unsupportedCapabilities: TableStructureCapabilities = {
  dialect: "unsupported",
  alterStrategy: "none",
  createTable: false,
  addColumn: false,
  dropColumn: false,
  renameColumn: false,
  alterExistingColumn: false,
  alterType: false,
  alterNullability: false,
  alterDefault: false,
  alterPrimaryKey: false,
  reorderColumn: false,
  comment: false,
  createIndex: false,
  dropIndex: false,
  rebuildIndex: false,
  indexType: false,
  indexInclude: false,
  indexFilter: false,
  indexComment: false,
  foreignKey: false,
};

function capabilities(overrides: Partial<TableStructureCapabilities>): TableStructureCapabilities {
  const resolved = { ...unsupportedCapabilities, ...overrides };
  if (overrides.alterStrategy === undefined && resolved.alterExistingColumn) {
    resolved.alterStrategy = "direct";
  }
  return resolved;
}

const postgresCapabilities = capabilities({
  dialect: "postgres",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  alterExistingColumn: true,
  alterType: true,
  alterNullability: true,
  alterDefault: true,
  comment: true,
  createIndex: true,
  dropIndex: true,
  rebuildIndex: true,
  indexType: true,
  indexInclude: true,
  indexFilter: true,
  indexComment: true,
  alterPrimaryKey: true,
  foreignKey: true,
});

const postgresBefore11Capabilities = capabilities({
  ...postgresCapabilities,
  indexInclude: false,
});

const capabilityByType: Partial<Record<DatabaseType, TableStructureCapabilities>> = {
  postgres: postgresCapabilities,
  opengauss: postgresCapabilities,
};

function postgresMajorVersion(productVersion?: string): number | undefined {
  const normalized = productVersion?.trim();
  if (!normalized) return undefined;
  const match = normalized.match(/\bPostgreSQL\s+(\d+)(?:\.\d+)?\b/i) ?? normalized.match(/^(\d+)(?:\.\d+)?\b/);
  if (!match) return undefined;
  const majorVersion = Number.parseInt(match[1], 10);
  return Number.isFinite(majorVersion) ? majorVersion : undefined;
}

export function getTableStructureCapabilities(dbType?: DatabaseType, _connectionDbType?: DatabaseType, productVersion?: string): TableStructureCapabilities {
  if (dbType === "postgres") {
    const majorVersion = postgresMajorVersion(productVersion);
    if (majorVersion !== undefined && majorVersion < 11) return postgresBefore11Capabilities;
  }
  return dbType ? (capabilityByType[dbType] ?? unsupportedCapabilities) : unsupportedCapabilities;
}

export function sanitizeStructureIndexesForCapabilities(indexes: EditableStructureIndex[], capabilities: Pick<TableStructureCapabilities, "indexInclude">): EditableStructureIndex[] {
  if (capabilities.indexInclude || indexes.every((index) => index.includedColumns.length === 0)) return indexes;
  return indexes.map((index) => (index.includedColumns.length === 0 ? index : { ...index, includedColumns: [] }));
}

export function canEditTableStructure(dbType?: DatabaseType): boolean {
  const caps = getTableStructureCapabilities(dbType);
  return caps.createTable || caps.addColumn || caps.alterExistingColumn || caps.createIndex || caps.dropIndex;
}

export function supportsLocalTableColumnReorder(dbType?: DatabaseType, connectionDbType?: DatabaseType): boolean {
  const caps = getTableStructureCapabilities(dbType, connectionDbType);
  return canEditTableStructure(dbType) && !caps.reorderColumn;
}

export function isPhysicalTableColumnOrderChange(dbType: DatabaseType | undefined, connectionDbType: DatabaseType | undefined, originalPosition: number | undefined, currentPosition: number): boolean {
  return getTableStructureCapabilities(dbType, connectionDbType).reorderColumn && originalPosition !== currentPosition;
}

export function hasLocalTableColumnOrderChange(columns: readonly { originalPosition?: number; original?: unknown; markedForDrop?: boolean }[]): boolean {
  const activeColumns = columns.filter((column) => !column.markedForDrop);
  // Databases without physical reorder support keep existing columns in ordinal order
  // and append newly added columns, so compare against that post-save layout.
  const databaseOrder = [...activeColumns.filter((column) => column.original).sort((left, right) => (left.originalPosition ?? Number.MAX_SAFE_INTEGER) - (right.originalPosition ?? Number.MAX_SAFE_INTEGER)), ...activeColumns.filter((column) => !column.original)];
  return activeColumns.some((column, index) => column !== databaseOrder[index]);
}

export function canAddTableStructureColumn(dbType: DatabaseType | undefined, isCreateMode: boolean): boolean {
  const caps = getTableStructureCapabilities(dbType);
  return isCreateMode ? caps.createTable : caps.addColumn;
}
