// SPDX-License-Identifier: Apache-2.0
//
// OG Developer — modified from upstream dbx (https://github.com/t8y2/dbx,
// Apache-2.0, Copyright (c) dbx contributors) for openGauss support:
// sidebar object capabilities extended with SYNONYM / PACKAGE / PACKAGE_BODY.
// See NOTICE for the full list of modifications.

import type { DatabaseType } from "@/types/database";

export type SidebarObjectKind = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "SYNONYM" | "PACKAGE" | "PACKAGE_BODY" | "TYPE" | "TYPE_BODY" | "JOB" | "SCHEDULER";

export interface DatabaseObjectCapabilities {
  sidebarObjects: SidebarObjectKind[];
  sourceReadable: SidebarObjectKind[];
  executable: SidebarObjectKind[];
}

const TABLE_VIEW_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW"];

const ROUTINE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION"];

const POSTGRES_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE"];
// openGauss adds Oracle-style packages and synonyms (gs_package / pg_synonym catalogs).
const OPENGAUSS_OBJECTS: SidebarObjectKind[] = [...POSTGRES_OBJECTS, "SYNONYM", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY", "JOB", "SCHEDULER"];

// Compatibility-mode rules verified on a live openGauss 7.0 instance:
// - CREATE PACKAGE succeeds only in A mode ("Package only allowed create in A compatibility")
//   even though the gs_package catalog exists in every mode;
// - CREATE SYNONYM works in both A and PG modes;
// - CREATE EVENT is supported only in B mode.
// When the mode is unknown (legacy connections, detection failed) every group
// stays visible so nothing disappears unexpectedly.
function opengaussObjectsForCompatibility(sqlCompatibility?: string): SidebarObjectKind[] {
  // pg_job (DBMS_JOB / DBMS_SCHEDULER) 是系统基础设施，任何模式都存在；自定义 TYPE 也始终可用。
  const base: SidebarObjectKind[] = [...POSTGRES_OBJECTS, "SYNONYM", "JOB", "SCHEDULER", "TYPE", "TYPE_BODY"];
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
const DATABASE_TYPE_OBJECTS = new Map<DatabaseType, SidebarObjectKind[]>([
  ["postgres", POSTGRES_OBJECTS],
  ["opengauss", OPENGAUSS_OBJECTS],
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
  if (normalized.includes("SCHEDULER")) return "SCHEDULER";
  if (normalized === "JOB") return "JOB";
  if (value.includes("VIEW")) return "VIEW";
  if (value.includes("SEQ")) return "SEQUENCE";
  if (value.includes("SYNONYM")) return "SYNONYM";
  if (value.includes("PROC")) return "PROCEDURE";
  if (value.includes("FUNC")) return "FUNCTION";
  return "TABLE";
}
