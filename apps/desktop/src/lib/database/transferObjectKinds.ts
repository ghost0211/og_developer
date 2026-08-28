import type { DatabaseType } from "@/types/database";

export enum TransferObjectFamily {
  Postgres = "postgres",
}

export type TransferObjectKind = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "EVENT";

const POSTGRES_KINDS: TransferObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE"];

const FAMILY_BY_DB = new Map<DatabaseType, TransferObjectFamily>([
  ["postgres", TransferObjectFamily.Postgres],
  ["opengauss", TransferObjectFamily.Postgres],
]);

export function transferObjectFamily(dbType?: DatabaseType): TransferObjectFamily | undefined {
  return dbType ? FAMILY_BY_DB.get(dbType) : undefined;
}

export function isSameTransferFamily(a?: DatabaseType, b?: DatabaseType): boolean {
  const fa = transferObjectFamily(a);
  const fb = transferObjectFamily(b);
  return !!fa && fa === fb;
}

export function transferObjectKindsForDatabase(dbType?: DatabaseType): TransferObjectKind[] {
  switch (transferObjectFamily(dbType)) {
    case TransferObjectFamily.Postgres:
      return [...POSTGRES_KINDS];
    default:
      return [];
  }
}

/**
 * Kinds selectable for a transfer between the two databases. Only the
 * Postgres family (postgres/opengauss) remains, so anything crossing a
 * family boundary has no supported conversion path and stays unselectable.
 */
export function crossFamilyTransferableKinds(a?: DatabaseType, b?: DatabaseType): TransferObjectKind[] {
  if (isSameTransferFamily(a, b)) {
    return transferObjectKindsForDatabase(a);
  }
  return [];
}
