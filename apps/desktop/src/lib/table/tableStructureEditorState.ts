import type { ColumnInfo, DatabaseType, ForeignKeyInfo, IndexInfo, TriggerInfo } from "@/types/database.ts";
import type { ColumnExtra, EditableStructureColumn, EditableStructureForeignKey, EditableStructureIndex, EditableStructureTrigger } from "@/lib/table/tableStructureEditorSql.ts";

export function hasExistingColumnTypeChange(columns: readonly EditableStructureColumn[]): boolean {
  return columns.some((column) => !!column.original && !column.markedForDrop && column.dataType !== column.original.data_type);
}

export const DATA_TYPE_OPTIONS: Record<string, string[]> = {
  postgres: [
    "smallint",
    "int2",
    "integer",
    "int",
    "int4",
    "bigint",
    "int8",
    "smallserial",
    "serial",
    "bigserial",
    "decimal",
    "numeric",
    "real",
    "float",
    "float4",
    "double precision",
    "float8",
    "money",
    "boolean",
    "bool",
    "char",
    "character",
    "varchar",
    "character varying",
    "text",
    "bytea",
    "date",
    "time",
    "time without time zone",
    "time with time zone",
    "timetz",
    "timestamp",
    "timestamp without time zone",
    "timestamp with time zone",
    "timestamptz",
    "interval",
    "uuid",
    "json",
    "jsonb",
    "xml",
    "bit",
    "bit varying",
    "varbit",
    "tsvector",
    "tsquery",
    "cidr",
    "inet",
    "macaddr",
    "macaddr8",
    "point",
    "line",
    "lseg",
    "box",
    "path",
    "polygon",
    "circle",
    "int4range",
    "int8range",
    "numrange",
    "tsrange",
    "tstzrange",
    "daterange",
    "oid",
  ],
};

const DATA_TYPE_OPTION_ALIASES: Partial<Record<DatabaseType, string>> = {
  opengauss: "postgres",
};

export function getDataTypeOptions(dbType: DatabaseType | undefined): string[] {
  const key = dbType ? (DATA_TYPE_OPTION_ALIASES[dbType] ?? dbType) : "";
  return DATA_TYPE_OPTIONS[key] ?? [];
}

export interface ColumnEditorControls {
  length: boolean;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: boolean;
  comment: boolean;
}

const DEFAULT_COLUMN_EDITOR_CONTROLS: ColumnEditorControls = {
  length: true,
  nullable: true,
  primaryKey: true,
  defaultValue: true,
  comment: true,
};

export function getColumnEditorControls(_dbType: DatabaseType | undefined): ColumnEditorControls {
  return DEFAULT_COLUMN_EDITOR_CONTROLS;
}

export const DEFAULT_TYPE_LENGTHS: Record<string, string> = {
  tinyint: "4",
  "tinyint unsigned": "4",
  smallint: "6",
  "smallint unsigned": "6",
  mediumint: "9",
  "mediumint unsigned": "9",
  int: "11",
  "int unsigned": "11",
  integer: "11",
  "integer unsigned": "11",
  int4: "11",
  bigint: "20",
  "bigint unsigned": "20",
  int8: "20",
  float: "10,2",
  real: "10,2",
  "double precision": "10,2",
  double: "10,2",
  decimal: "10,0",
  numeric: "10,0",
  number: "10,0",
  char: "1",
  character: "1",
  varchar: "255",
  "character varying": "255",
  varchar2: "255",
  nvarchar2: "255",
  nvarchar: "255",
  nchar: "1",
  varbinary: "255",
  binary: "1",
  bit: "1",
  year: "4",
};

export const DEFAULT_TYPE_LENGTH_DISABLES: string[] = [];

export const POSTGRES_TYPE_LENGTH_DISABLES: string[] = [
  "bigint",
  "int8",
  "bigserial",
  "serial8",
  "boolean",
  "bool",
  "box",
  "bytea",
  "cidr",
  "circle",
  "date",
  "double precision",
  "float",
  "float8",
  "inet",
  "integer",
  "int",
  "int4",
  "json",
  "jsonb",
  "line",
  "lseg",
  "macaddr",
  "macaddr8",
  "money",
  "path",
  "pg_lsn",
  "pg_snapshot",
  "point",
  "polygon",
  "real",
  "float4",
  "smallint",
  "int2",
  "smallserial",
  "serial2",
  "serial",
  "serial4",
  "text",
  "tsquery",
  "tsvector",
  "txid_snapshot",
  "uuid",
  "xml",
];

export function parseExtraToColumnExtra(extra: string | null | undefined, databaseType?: DatabaseType): ColumnExtra {
  const result: ColumnExtra = {};
  if (!extra) return result;
  const lower = extra.toLowerCase().trim();
  if (!lower) return result;

  if (databaseType === "postgres" || databaseType === "opengauss") {
    const identityMatch = lower.match(/generated\s+(by\s+default|always)\s+as\s+identity/i);
    if (identityMatch) {
      const sequenceMatch = lower.match(/start\s+with\s*(-?\d+)\s+increment\s+by\s*(-?\d+)/i);
      result.identity = {
        generation: identityMatch[1].toUpperCase() === "BY DEFAULT" ? "BY DEFAULT" : "ALWAYS",
      };
      if (sequenceMatch) {
        result.identity.seed = Number(sequenceMatch[1]);
        result.identity.increment = Number(sequenceMatch[2]);
      }
    }
  }

  return result;
}

function isPostgresTextualType(dataType: string): boolean {
  const baseType = dataType.split("(")[0]?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
  return ["char", "character", "varchar", "character varying", "text", "bpchar", "name", "json", "jsonb", "xml", "bytea", "uuid"].includes(baseType);
}

function stripPostgresStringDefaultCast(defaultValue: string, dataType: string): string {
  if (!isPostgresTextualType(dataType)) return defaultValue;
  const trimmed = defaultValue.trim();
  const match = trimmed.match(/^('(?:''|[^'])*')::\s*((?:character\s+varying)|character|varchar|char|text|bpchar|name|jsonb?|xml|bytea|uuid)(?:\s*\(\s*\d+\s*\))?$/i);
  return match?.[1] ?? defaultValue;
}

function columnDefaultForEditor(column: ColumnInfo, databaseType?: DatabaseType): string {
  if (column.column_default === null) return "";
  const defaultValue = column.column_default;
  if (databaseType === "postgres") return stripPostgresStringDefaultCast(defaultValue, column.data_type);
  return defaultValue;
}

const CHARACTER_LENGTH_METADATA_TYPES = new Set(["binary", "char", "character", "character varying", "nchar", "nvarchar", "nvarchar2", "varbinary", "varchar", "varchar2"]);
const NUMERIC_PRECISION_METADATA_TYPES = new Set(["decimal", "number", "numeric"]);

function columnDataTypeForEditor(column: ColumnInfo, databaseType?: DatabaseType): string {
  const parsed = splitDataType(column.data_type);
  if (parsed.params) return column.data_type;

  const baseType = parsed.baseType.trim().replace(/\s+/g, " ");
  const normalized = baseType.toLowerCase();
  if (CHARACTER_LENGTH_METADATA_TYPES.has(normalized) && Number.isInteger(column.character_maximum_length) && Number(column.character_maximum_length) > 0) {
    return combineDataTypeForDatabase(databaseType, baseType, String(column.character_maximum_length));
  }
  if (NUMERIC_PRECISION_METADATA_TYPES.has(normalized) && Number.isInteger(column.numeric_precision) && Number(column.numeric_precision) > 0) {
    const scale = Number.isInteger(column.numeric_scale) && Number(column.numeric_scale) >= 0 ? `,${column.numeric_scale}` : "";
    return combineDataTypeForDatabase(databaseType, baseType, `${column.numeric_precision}${scale}`);
  }
  return column.data_type;
}

export function createColumnDrafts(columns: ColumnInfo[], databaseType?: DatabaseType): EditableStructureColumn[] {
  return columns.map((column, index) => {
    const defaultValue = columnDefaultForEditor(column, databaseType);
    const dataType = columnDataTypeForEditor(column, databaseType);
    return {
      id: `existing:${column.name}`,
      name: column.name,
      dataType,
      isNullable: column.is_nullable,
      defaultValue,
      comment: column.comment ?? "",
      isPrimaryKey: column.is_primary_key,
      characterSet: column.character_set ?? "",
      collation: column.collation ?? "",
      extra: parseExtraToColumnExtra(column.extra, databaseType),
      original: { ...column, data_type: dataType, column_default: column.column_default === null ? null : defaultValue },
      originalPosition: index,
      markedForDrop: false,
    };
  });
}

function existingColumnIdName(id: string): string | undefined {
  const prefix = "existing:";
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

function isNewColumnDraftId(id: string): boolean {
  return id.startsWith("new:");
}

function uniqueNames(names: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function findColumnDraftByName(columns: EditableStructureColumn[], names: string[], usedIndexes: Set<number>): number | undefined {
  for (const name of names) {
    const exactIndex = columns.findIndex((column, index) => !usedIndexes.has(index) && column.name === name);
    if (exactIndex >= 0) return exactIndex;
  }

  for (const name of names) {
    const lowerName = name.toLowerCase();
    const matches = columns.map((column, index) => ({ column, index })).filter(({ column, index }) => !usedIndexes.has(index) && column.name.toLowerCase() === lowerName);
    if (matches.length === 1) return matches[0]!.index;
  }

  return undefined;
}

export function rehydrateColumnDraftsFromMetadata(draftColumns: EditableStructureColumn[], columns: ColumnInfo[], databaseType?: DatabaseType): EditableStructureColumn[] {
  const metadataDrafts = createColumnDrafts(columns, databaseType);
  if (!metadataDrafts.length) return draftColumns;
  if (!draftColumns.length) return metadataDrafts;

  const usedMetadataIndexes = new Set<number>();
  const nextColumns = draftColumns.map((column) => {
    if (!column.original && isNewColumnDraftId(column.id)) return column;

    const needsHydration = !column.original || column.originalPosition === undefined;
    const candidates = uniqueNames([column.original?.name, existingColumnIdName(column.id), column.name]);
    const metadataIndex = findColumnDraftByName(metadataDrafts, candidates, usedMetadataIndexes);
    if (metadataIndex === undefined) return column;
    usedMetadataIndexes.add(metadataIndex);
    const metadataDraft = metadataDrafts[metadataIndex]!;
    if (!needsHydration) return column;

    return {
      ...column,
      enumValues: column.enumValues ?? metadataDraft.enumValues,
      original: column.original ?? metadataDraft.original,
      originalPosition: column.originalPosition ?? metadataDraft.originalPosition,
    };
  });

  if (usedMetadataIndexes.size === 0) {
    return [...metadataDrafts, ...draftColumns];
  }

  const missingMetadataDrafts = metadataDrafts.filter((_, index) => !usedMetadataIndexes.has(index));
  return [...nextColumns, ...missingMetadataDrafts];
}

/** Canonicalize index method for structure editor options (e.g. Postgres `btree` → `BTREE`). */
export function normalizeStructureIndexType(indexType: string | null | undefined): string {
  return (indexType ?? "").trim().toUpperCase();
}

/** Case-insensitive index-type equality (draft is uppercased; API may still return lowercase amname). */
export function sameStructureIndexType(left: string | null | undefined, right: string | null | undefined): boolean {
  return normalizeStructureIndexType(left) === normalizeStructureIndexType(right);
}

/** Keep selected fields removable even after they are no longer available on the table. */
export function filterStructureIndexColumnOptions(availableColumns: readonly string[], selectedColumns: readonly string[], search = ""): string[] {
  const availableSet = new Set(availableColumns);
  const unavailableSelected = selectedColumns.filter((column) => column.trim() && !availableSet.has(column));
  const options = [...new Set([...unavailableSelected, ...availableColumns])];
  const query = search.trim().toLowerCase();
  return query ? options.filter((option) => option.toLowerCase().includes(query)) : options;
}

export function createIndexDrafts(indexes: IndexInfo[]): EditableStructureIndex[] {
  return indexes.map((index) => ({
    id: `existing:${index.name}`,
    name: index.name,
    columns: [...index.columns],
    nameEdited: true,
    isUnique: index.is_unique,
    isPrimary: index.is_primary,
    filter: index.filter ?? "",
    // Match Select options (BTREE/GIN/…); Postgres pg_am.amname is lowercase.
    indexType: normalizeStructureIndexType(index.index_type),
    includedColumns: index.included_columns ? [...index.included_columns] : [],
    comment: index.comment ?? "",
    original: index,
    markedForDrop: false,
  }));
}

export function createForeignKeyDrafts(foreignKeys: ForeignKeyInfo[]): EditableStructureForeignKey[] {
  const groups = new Map<string, ForeignKeyInfo[]>();
  for (const foreignKey of foreignKeys) {
    const key = [foreignKey.name, foreignKey.ref_schema ?? "", foreignKey.ref_table, foreignKey.on_update ?? "", foreignKey.on_delete ?? ""].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), foreignKey]);
  }

  return [...groups.values()].map((group, index) => {
    const first = group[0]!;
    const original = {
      ...first,
      column: group.map((foreignKey) => foreignKey.column).join(", "),
      ref_column: group.map((foreignKey) => foreignKey.ref_column).join(", "),
    };
    return {
      id: `existing:${first.name}:${index}`,
      name: first.name,
      column: original.column,
      refSchema: first.ref_schema ?? "",
      refTable: first.ref_table,
      refColumn: original.ref_column,
      onUpdate: first.on_update ?? "",
      onDelete: first.on_delete ?? "",
      original,
      markedForDrop: false,
    };
  });
}

export function createTriggerDrafts(triggers: TriggerInfo[]): EditableStructureTrigger[] {
  return triggers.map((trigger) => ({
    id: `existing:${trigger.name}`,
    name: trigger.name,
    timing: trigger.timing,
    event: trigger.event,
    statement: trigger.statement ?? "",
    original: trigger,
    markedForDrop: false,
  }));
}

export function canEditStructuredTriggerDraft(databaseType: DatabaseType | undefined, trigger: EditableStructureTrigger): boolean {
  return !trigger.original || databaseType !== undefined;
}

export function toColumnNames(columns: string[]): string {
  return columns.join(", ");
}

const AUTO_INDEX_NAME_MAX_LENGTH = 63;

function normalizeIndexNamePart(value: string): string {
  const trimmed = value.trim();
  const unquoted = (trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("`") && trimmed.endsWith("`")) || (trimmed.startsWith('"') && trimmed.endsWith('"')) ? trimmed.slice(1, -1) : trimmed;
  return unquoted
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function truncateIndexName(value: string, maxLength = AUTO_INDEX_NAME_MAX_LENGTH): string {
  if (value.length <= maxLength) return value;
  const suffix = "_IDX";
  if (!value.endsWith(suffix)) return value.slice(0, maxLength).replace(/_+$/g, "");
  return `${value.slice(0, maxLength - suffix.length).replace(/_+$/g, "")}${suffix}`;
}

export function generateIndexName(tableName: string, columns: string[], maxLength = AUTO_INDEX_NAME_MAX_LENGTH): string {
  const parts = [tableName, ...columns].map(normalizeIndexNamePart).filter(Boolean);
  if (parts.length === 0) return "";
  return truncateIndexName(`${parts.join("_")}_IDX`, maxLength);
}

export function generateUniqueIndexName(tableName: string, columns: string[], existingNames: Iterable<string>, maxLength = AUTO_INDEX_NAME_MAX_LENGTH): string {
  const base = generateIndexName(tableName, columns, maxLength);
  if (!base) return "";

  const taken = new Set([...existingNames].map((name) => name.trim().toLowerCase()).filter(Boolean));
  if (!taken.has(base.toLowerCase())) return base;

  for (let counter = 2; counter < 10_000; counter++) {
    const suffix = `_${counter}`;
    const stem = base.length + suffix.length <= maxLength ? base : base.slice(0, maxLength - suffix.length).replace(/_+$/g, "");
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

export function splitDataType(raw: string): { baseType: string; params: string } {
  const trimmed = raw.trim();
  const parenIdx = trimmed.indexOf("(");
  if (parenIdx === -1) return { baseType: trimmed, params: "" };
  const closeIdx = trimmed.lastIndexOf(")");
  const baseTypePrefix = trimmed.slice(0, parenIdx).trim();
  const params = trimmed.slice(parenIdx + 1, closeIdx).trim();
  const suffix = trimmed
    .slice(closeIdx + 1)
    .trim()
    .replace(/\s+/g, " ");
  const baseType = /^(?:signed|unsigned|zerofill)(?:\s+(?:signed|unsigned|zerofill))*$/i.test(suffix) ? `${baseTypePrefix} ${suffix}`.trim() : baseTypePrefix;
  return { baseType, params };
}

export function combineDataType(baseType: string, params: string): string {
  const type = baseType.trim();
  const p = params.trim();
  if (!type) return "";
  if (!p) return type;
  return `${type}(${p})`;
}

export function combineDataTypeForDatabase(dbType: DatabaseType | undefined, baseType: string, params: string): string {
  if (isDataTypeLengthDisabled(dbType, baseType)) {
    return baseType;
  }
  const normalizedParams = normalizeDataTypeParams(dbType, baseType, params);
  return combineDataType(baseType, normalizedParams);
}

export function dataTypeLengthInputValue(dbType: DatabaseType | undefined, rawDataType: string): string {
  const parsed = splitDataType(rawDataType);
  return isDataTypeLengthDisabled(dbType, parsed.baseType) ? "" : splitDataType(rawDataType).params;
}

export function normalizeDataTypeParams(dbType: DatabaseType | undefined, baseType: string, params: string): string {
  const p = params.trim();
  if (!p) return "";
  if (!isTemporalPrecisionType(dbType, baseType)) return p;
  return isValidTemporalPrecision(p) ? p : "";
}

function isTemporalPrecisionType(dbType: DatabaseType | undefined, baseType: string): boolean {
  const normalized = baseType.trim().replace(/\s+/g, " ").toLowerCase();
  switch (dbType) {
    case "postgres":
    case "opengauss":
      return ["time", "time without time zone", "time with time zone", "timestamp", "timestamp without time zone", "timestamp with time zone"].includes(normalized);
    default:
      return false;
  }
}

function isValidTemporalPrecision(params: string): boolean {
  if (!/^\d+$/.test(params)) return false;
  const value = Number(params);
  return Number.isInteger(value) && value >= 0 && value <= 6 && String(value) === params;
}

export function getDefaultLengthForType(_dbType: DatabaseType | undefined, baseType: string): string {
  const key = baseType.trim().toLowerCase();
  return DEFAULT_TYPE_LENGTHS[key] ?? "";
}

/** Default data type for a newly added structure-editor column. */
export function defaultNewColumnDataType(dbType: DatabaseType | undefined, dataTypeOptions: readonly string[] = []): string {
  const options = dataTypeOptions.length > 0 ? dataTypeOptions : getDataTypeOptions(dbType);

  if (options.length > 0) {
    const preferred = options.find((type) => /^(varchar|character varying|nvarchar)$/i.test(type.trim())) ?? options.find((type) => /^(string|clob|lvarchar|text)$/i.test(type.trim())) ?? options.find((type) => /^varchar/i.test(type.trim()));
    if (preferred) {
      return combineDataTypeForDatabase(dbType, preferred, getDefaultLengthForType(dbType, preferred));
    }
  }

  return "varchar(255)";
}

/** Index at which to insert a new column (after the selected row, or append when none). */
export function resolveInsertColumnIndex(columns: readonly { id: string; markedForDrop?: boolean }[], selectedColumnId: string | null | undefined): number {
  if (!selectedColumnId) return columns.length;
  // Dropped rows are not valid insertion anchors.
  const index = columns.findIndex((column) => column.id === selectedColumnId && !column.markedForDrop);
  return index >= 0 ? index + 1 : columns.length;
}

export function isDataTypeLengthDisabled(_dbType: DatabaseType | undefined, baseType: string): boolean {
  const key = baseType.trim().toLowerCase();
  if (_dbType === "postgres" || _dbType === "opengauss") {
    return POSTGRES_TYPE_LENGTH_DISABLES.includes(key);
  }
  return DEFAULT_TYPE_LENGTH_DISABLES.includes(key);
}

export function buildStructureTargetLabel(connectionName: string | undefined, database: string | undefined, schema: string | undefined, tableName: string | undefined): string {
  const parts = [connectionName, database];
  if (schema && schema !== database) parts.push(schema);
  if (tableName) parts.push(tableName);
  return parts.filter(Boolean).join(" / ");
}
