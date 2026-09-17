/** Complete read-only catalog input; null source means identity-only, outside scan scope. */
export interface RoutineHealthRoutine {
  id: string;
  schema: string;
  name: string;
  objectType: string;
  signature: string;
  source: string | null;
  language: string;
  /** Stored routine search_path when resolved; otherwise use snapshot.searchPath. */
  searchPath?: string[];
}
export interface RoutineHealthRelation {
  schema: string;
  name: string;
  kind: string;
  columns: string[];
}
export interface RoutineHealthIndex {
  schema: string;
  name: string;
  tableSchema: string;
  tableName: string;
}
export interface RoutineHealthSnapshot {
  routines: RoutineHealthRoutine[];
  relations: RoutineHealthRelation[];
  indexes: RoutineHealthIndex[];
  searchPath: string[];
  invalidObjects: import("./tauri").InvalidObjectInfo[];
  warnings: string[];
}
