import type { DatabaseType } from "@/types/database";
import { isSchemaAware, usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";

export interface TableDataCapability {
  insert: boolean;
  updateRequiresPrimaryKey: boolean;
  deleteRequiresPrimaryKey: boolean;
  keylessRowPredicate?: boolean;
  transaction: boolean;
  readonly?: boolean;
}

export interface DatabaseCapability {
  schemaAware: boolean;
  treeSchemaMode: boolean;
  tableData: TableDataCapability;
}

const DEFAULT_TABLE_DATA_CAPABILITY: TableDataCapability = {
  insert: false,
  updateRequiresPrimaryKey: true,
  deleteRequiresPrimaryKey: true,
  keylessRowPredicate: false,
  transaction: true,
};

const NAVICAT_STYLE_TABLE_DATA_CAPABILITY: TableDataCapability = {
  insert: true,
  updateRequiresPrimaryKey: false,
  deleteRequiresPrimaryKey: false,
  keylessRowPredicate: true,
  transaction: true,
};

const DEFAULT_CAPABILITY: DatabaseCapability = {
  schemaAware: false,
  treeSchemaMode: false,
  tableData: DEFAULT_TABLE_DATA_CAPABILITY,
};

const NAVICAT_STYLE_TABLE_DATA_TYPES = new Set<DatabaseType>(["postgres", "opengauss"]);

const DATABASE_CAPABILITY_OVERRIDES: Partial<Record<DatabaseType, Partial<DatabaseCapability>>> = {
  jdbc: {
    tableData: {
      insert: false,
      updateRequiresPrimaryKey: true,
      deleteRequiresPrimaryKey: true,
      transaction: false,
    },
  },
};

function defaultTableDataCapability(dbType?: DatabaseType): TableDataCapability {
  if (dbType && NAVICAT_STYLE_TABLE_DATA_TYPES.has(dbType)) return NAVICAT_STYLE_TABLE_DATA_CAPABILITY;
  return DEFAULT_TABLE_DATA_CAPABILITY;
}

export function getDatabaseCapability(dbType?: DatabaseType): DatabaseCapability {
  const override = dbType ? DATABASE_CAPABILITY_OVERRIDES[dbType] : undefined;
  const tableData = defaultTableDataCapability(dbType);
  return {
    ...DEFAULT_CAPABILITY,
    ...override,
    schemaAware: isSchemaAware(dbType),
    treeSchemaMode: usesTreeSchemaMode(dbType),
    tableData: {
      ...tableData,
      ...override?.tableData,
    },
  };
}
