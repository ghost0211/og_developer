export interface MenuSearchObjectTarget {
  connectionId: string;
  database: string;
  schema: string;
  objectType: string;
  name: string;
}

export interface MenuSearchTableDdlTarget {
  connectionId: string;
  database: string;
  schema: string | undefined;
  tableName: string;
  /** Tables use the command's default DDL path; TABLE/COLUMN are not object-source enum variants. */
  objectType: undefined;
}

export function menuSearchTableDdlTarget(hit: MenuSearchObjectTarget): MenuSearchTableDdlTarget | undefined {
  const objectType = hit.objectType.trim().toUpperCase();
  let tableName = "";
  if (objectType === "TABLE") {
    tableName = hit.name;
  } else if (objectType === "COLUMN") {
    const separator = hit.name.lastIndexOf(".");
    if (separator <= 0) return undefined;
    tableName = hit.name.slice(0, separator);
  } else {
    return undefined;
  }

  if (!tableName) return undefined;
  return {
    connectionId: hit.connectionId,
    database: hit.database,
    schema: hit.schema || undefined,
    tableName,
    objectType: undefined,
  };
}
