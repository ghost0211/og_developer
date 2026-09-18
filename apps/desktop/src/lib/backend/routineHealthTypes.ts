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
  /** "synonym" marks openGauss synonyms; other values are pg_class relkinds. */
  kind: string;
  /** NULL for dangling synonyms: the reference exists but its columns are unknown. */
  columns: string[] | null;
}
export interface RoutineHealthIndex {
  schema: string;
  name: string;
  tableSchema: string;
  tableName: string;
}
/** Coverage notes arrive as stable codes so the panel can localize them; detail carries raw technical context. */
export interface RoutineHealthWarning {
  code: string;
  detail?: string;
}
export interface RoutineHealthSnapshot {
  routines: RoutineHealthRoutine[];
  relations: RoutineHealthRelation[];
  indexes: RoutineHealthIndex[];
  searchPath: string[];
  invalidObjects: import("./tauri").InvalidObjectInfo[];
  warnings: RoutineHealthWarning[];
}
