import type { DatabaseType } from "@/types/database";

export type SidebarObjectKind = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "SYNONYM" | "PACKAGE" | "PACKAGE_BODY" | "TYPE" | "TYPE_BODY" | "JOB";

export interface DatabaseObjectCapabilities {
  sidebarObjects: SidebarObjectKind[];
  sourceReadable: SidebarObjectKind[];
  executable: SidebarObjectKind[];
}

const TABLE_VIEW_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW"];
const TABLE_VIEW_MV_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW"];

const ROUTINE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION"];

const POSTGRES_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE"];
// openGauss adds Oracle-style packages and synonyms (gs_package / pg_synonym catalogs).
const OPENGAUSS_OBJECTS: SidebarObjectKind[] = [...POSTGRES_OBJECTS, "SYNONYM", "PACKAGE", "PACKAGE_BODY"];

// Compatibility-mode rules verified on a live openGauss 7.0 instance:
// - CREATE PACKAGE succeeds only in A mode ("Package only allowed create in A compatibility")
//   even though the gs_package catalog exists in every mode;
// - CREATE SYNONYM works in both A and PG modes;
// - CREATE EVENT is supported only in B mode.
// When the mode is unknown (legacy connections, detection failed) every group
// stays visible so nothing disappears unexpectedly.
function opengaussObjectsForCompatibility(sqlCompatibility?: string): SidebarObjectKind[] {
  // pg_job (DBMS_JOB) is system infrastructure and exists in every mode.
  const base: SidebarObjectKind[] = [...POSTGRES_OBJECTS, "SYNONYM", "JOB"];
  switch (sqlCompatibility?.trim().toUpperCase()) {
    case "A":
      return [...base, "PACKAGE", "PACKAGE_BODY"];
    case "B":
    case "C":
    case "M":
    case "PG":
      return base;
    default:
      return [...base, "PACKAGE", "PACKAGE_BODY"];
  }
}
const POSTGRES_LIKE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION"];
const ORACLE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"];
const DAMENG_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE", "PACKAGE", "PACKAGE_BODY"];
const XUGU_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "SYNONYM", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY"];

const DATABASE_TYPE_OBJECTS = new Map<DatabaseType, SidebarObjectKind[]>([
  // postgres
  ["postgres", POSTGRES_OBJECTS],
  ["gaussdb", POSTGRES_OBJECTS],
  ["kwdb", POSTGRES_OBJECTS],
  ["opengauss", OPENGAUSS_OBJECTS],
  // postgres like
  ["kingbase", POSTGRES_LIKE_OBJECTS],
  ["highgo", POSTGRES_LIKE_OBJECTS],
  ["uxdb", POSTGRES_LIKE_OBJECTS],
  ["vastbase", POSTGRES_LIKE_OBJECTS],
  ["redshift", POSTGRES_LIKE_OBJECTS],
  // oracle
  ["oracle", ORACLE_OBJECTS],
  ["dameng", DAMENG_OBJECTS],
  ["oceanbase-oracle", ORACLE_OBJECTS],
  ["xugu", XUGU_OBJECTS],
  // table and view
  ["sqlite", TABLE_VIEW_OBJECTS],
  ["rqlite", TABLE_VIEW_OBJECTS],
  ["turso", TABLE_VIEW_OBJECTS],
  ["cloudflare-d1", TABLE_VIEW_OBJECTS],
  ["duckdb", TABLE_VIEW_OBJECTS],
  ["clickhouse", TABLE_VIEW_OBJECTS],
  // Doris: backend listing path still uses the generic SHOW TABLES path (see
  // `list_tables_once` for `PoolKind::Mysql` in crates/dbx-core/src/schema.rs)
  // and lacks a MV classifier. Keep Doris on TABLE_VIEW_OBJECTS until a
  // Doris-specific MV listing/classification lands, otherwise the UI advertises
  // MV support that the backend cannot route.
  ["doris", TABLE_VIEW_OBJECTS],
  ["starrocks", TABLE_VIEW_MV_OBJECTS],
  ["hive", TABLE_VIEW_OBJECTS],
  ["spark", TABLE_VIEW_OBJECTS],
  ["trino", TABLE_VIEW_OBJECTS],
  ["prestosql", TABLE_VIEW_OBJECTS],
  ["cassandra", TABLE_VIEW_OBJECTS],
  ["bigquery", TABLE_VIEW_OBJECTS],
  ["kylin", TABLE_VIEW_OBJECTS],
  ["tdengine", TABLE_VIEW_OBJECTS],
  ["iotdb", TABLE_VIEW_OBJECTS],
  ["neo4j", TABLE_VIEW_OBJECTS],
  // others
  ["influxdb", ["TABLE"]],
  ["victoriametrics", ["TABLE"]],
  ["hbase", ["TABLE"]],
  ["questdb", ["TABLE", "VIEW", "MATERIALIZED_VIEW"]],
  ["manticoresearch", ["TABLE", "FUNCTION"]],
  ["databend", ["TABLE", "VIEW", "PROCEDURE"]],
]);
export function databaseObjectCapabilities(dbType?: DatabaseType): DatabaseObjectCapabilities {
  const sidebarObjects = sidebarObjectKindsForDatabase(dbType);
  return {
    sidebarObjects,
    sourceReadable: sidebarObjects.filter((kind) => kind !== "TABLE"),
    executable: sidebarObjects.filter((kind) => kind === "PROCEDURE"),
  };
}

export function sidebarObjectKindsForDatabase(dbType?: DatabaseType, sqlCompatibility?: string): SidebarObjectKind[] {
  if (!dbType) return [...TABLE_VIEW_OBJECTS];
  if (dbType === "opengauss") return opengaussObjectsForCompatibility(sqlCompatibility);
  return DATABASE_TYPE_OBJECTS.get(dbType) ?? [...ROUTINE_OBJECTS];
}

export function normalizeSidebarObjectKind(type: string): SidebarObjectKind {
  const value = type.toUpperCase();
  const normalized = value.replace(/[\s-]+/g, "_");
  if (normalized.includes("PACKAGE_BODY")) return "PACKAGE_BODY";
  if (normalized.includes("TYPE_BODY")) return "TYPE_BODY";
  if (normalized.includes("PACKAGE")) return "PACKAGE";
  if (normalized.includes("TRIGGER")) return "TRIGGER";
  if (normalized.includes("TYPE")) return "TYPE";
  if (normalized.includes("MATERIALIZED_VIEW")) return "MATERIALIZED_VIEW";
  if (normalized === "JOB") return "JOB";
  if (value.includes("VIEW")) return "VIEW";
  if (value.includes("SEQ")) return "SEQUENCE";
  if (value.includes("SYNONYM")) return "SYNONYM";
  if (value.includes("PROC")) return "PROCEDURE";
  if (value.includes("FUNC")) return "FUNCTION";
  return "TABLE";
}
