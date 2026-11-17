import type { DatabaseType, TableInfoTab } from "@/types/database";

export interface TableMetadataCapabilities {
  columns: boolean;
  indexes: boolean;
  foreignKeys: boolean;
  triggers: boolean;
  checks?: boolean;
  partitions?: boolean;
  options?: boolean;
  ddl: boolean;
}

const defaultCapabilities: TableMetadataCapabilities = {
  columns: true,
  indexes: true,
  foreignKeys: true,
  triggers: true,
  checks: false,
  partitions: false,
  options: false,
  ddl: true,
};

export function getTableMetadataCapabilities(dbType?: DatabaseType): TableMetadataCapabilities {
  const isOpenGauss = dbType === "opengauss";
  const isPostgres = dbType === "postgres";
  return {
    ...defaultCapabilities,
    checks: isOpenGauss || isPostgres,
    partitions: isOpenGauss,
    options: isOpenGauss,
  };
}

export function firstStructureMetadataTab(capabilities: TableMetadataCapabilities, isCreateMode: boolean): TableInfoTab {
  // Structure editing should open on an editable metadata page; DDL remains a
  // read-only fallback for databases that do not expose editable metadata.
  if (capabilities.columns) return "columns";
  if (capabilities.indexes) return "indexes";
  if (capabilities.foreignKeys) return "foreignKeys";
  if (capabilities.triggers) return "triggers";
  if (capabilities.checks) return "checks";
  if (capabilities.partitions) return "partitions";
  if (capabilities.options) return "options";
  if (!isCreateMode && capabilities.ddl) return "ddl";
  return "columns";
}

export function isStructureMetadataTabSupported(tab: TableInfoTab, capabilities: TableMetadataCapabilities, isCreateMode: boolean): boolean {
  return (
    (tab === "columns" && capabilities.columns) ||
    (tab === "indexes" && capabilities.indexes) ||
    (tab === "foreignKeys" && capabilities.foreignKeys) ||
    (tab === "triggers" && capabilities.triggers) ||
    (tab === "checks" && !!capabilities.checks) ||
    (tab === "partitions" && !!capabilities.partitions) ||
    (tab === "options" && !!capabilities.options) ||
    (tab === "ddl" && capabilities.ddl && !isCreateMode)
  );
}
