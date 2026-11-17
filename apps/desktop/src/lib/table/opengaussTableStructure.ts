import type { DatabaseType, QueryResult } from "@/types/database";

export type OpenGaussOrientation = "row" | "column";
export type OpenGaussStorageType = "astore" | "ustore";
export type OpenGaussCompression = "no" | "yes" | "low" | "middle" | "high";
export type OpenGaussPartitionStrategy = "range" | "list" | "hash" | "interval";
export type OpenGaussCreatePartitionStrategy = "range" | "list" | "hash";

export type OpenGaussMetadataQueryRunner = (sql: string) => Promise<Pick<QueryResult, "columns" | "rows">>;

export interface TableCheckConstraintInfo {
  name: string;
  definition: string;
  expression: string;
}

export interface EditableTableCheckConstraint {
  id: string;
  name: string;
  expression: string;
  nameEdited?: boolean;
  markedForDrop: boolean;
  original?: TableCheckConstraintInfo;
}

export interface ParsedOpenGaussReloptions {
  orientation: OpenGaussOrientation;
  storageType: OpenGaussStorageType;
  compression: OpenGaussCompression;
  fillfactor: number | null;
  extraOptions: Record<string, string>;
}

export interface OpenGaussTableOptionsSnapshot {
  orientation: OpenGaussOrientation;
  storageType: OpenGaussStorageType;
  compression: OpenGaussCompression;
  fillfactor: number | null;
  tablespace: string;
  enableRowMovement: boolean;
  isPartitioned?: boolean;
}

export interface EditableOpenGaussTableOptions {
  orientation: OpenGaussOrientation;
  storageType: OpenGaussStorageType;
  compression: OpenGaussCompression;
  fillfactor: number | null;
  tablespace: string;
  enableRowMovement: boolean;
}

export interface OpenGaussSubpartitionItemMetadata {
  oid: string;
  parentPartitionOid: string;
  name: string;
  strategy: OpenGaussPartitionStrategy;
  rawBoundaries: (string | null)[];
  boundaryDisplay: string;
  tablespace: string;
  estimatedRows: number | null;
}

export interface OpenGaussPartitionItemMetadata {
  oid: string;
  name: string;
  strategy: OpenGaussPartitionStrategy;
  rawBoundaries: (string | null)[];
  boundaryDisplay: string;
  editableBoundary: string;
  tablespace: string;
  estimatedRows: number | null;
  sizeBytes: number | null;
  subpartitionCount: number;
  subpartitions?: OpenGaussSubpartitionItemMetadata[];
}

export interface OpenGaussTablePartitionMetadata {
  tableOid: string;
  strategy: OpenGaussPartitionStrategy;
  partitionKeys: string[];
  interval: string;
  subpartitionCount: number;
  enableRowMovement: boolean;
  partitions: OpenGaussPartitionItemMetadata[];
}

export interface EditableOpenGaussCreatePartitionItem {
  id: string;
  name: string;
  boundary: string;
  tablespace: string;
}

export type OpenGaussPartitionPendingOp =
  | {
      id: string;
      type: "add";
      partitionName: string;
      boundary: string;
      tablespace?: string;
    }
  | {
      id: string;
      type: "drop";
      partitionName: string;
    }
  | {
      id: string;
      type: "truncate";
      partitionName: string;
    }
  | {
      id: string;
      type: "rename";
      partitionName: string;
      newPartitionName: string;
    }
  | {
      id: string;
      type: "split";
      partitionName: string;
      atValue: string;
      firstPartitionName: string;
      secondPartitionName: string;
    };

export interface EditableOpenGaussPartitionEditDraft {
  updateGlobalIndex: boolean;
  pendingOps: OpenGaussPartitionPendingOp[];
}

export interface EditableOpenGaussPartitionDraft {
  /** Create-mode toggle: whether the new table is partitioned. */
  enabled: boolean;
  strategy: OpenGaussCreatePartitionStrategy;
  partitionKeys: string[];
  interval: string;
  hashPartitionCount: number | null;
  enableRowMovement: boolean;
  partitions: EditableOpenGaussCreatePartitionItem[];
  /** Edit-mode pending partition DDL operations and global index flag. */
  updateGlobalIndex: boolean;
  pendingOps: OpenGaussPartitionPendingOp[];
}

export interface OpenGaussValidationMessages {
  checkNameRequired?: string;
  checkExpressionRequired?: string;
  duplicateCheckName?: (name: string) => string;
  columnUstoreIncompatible?: string;
  columnFillfactorIncompatible?: string;
  invalidFillfactor?: string;
  rowCompressionLevelIncompatible?: string;
  partitionKeyRequired?: string;
  partitionKeyUnknown?: (col: string) => string;
  columnPartitionStrategyIncompatible?: string;
  intervalSingleKeyRequired?: string;
  intervalMaxvalueIncompatible?: string;
  initialPartitionRequired?: string;
  partitionNameRequired?: string;
  partitionBoundaryRequired?: (name: string) => string;
  duplicatePartitionName?: (name: string) => string;
  invalidHashPartitionCount?: string;
  addPartitionUnsupportedStrategy?: (strategy: string) => string;
  splitPartitionUnsupported?: string;
  splitPartitionIncomplete?: (name: string) => string;
  splitPartitionSameTargetName?: (name: string) => string;
  renamePartitionRequired?: (name: string) => string;
  renamePartitionUnchanged?: (name: string) => string;
  dropLastPartitionForbidden?: (name: string) => string;
}

export interface AugmentCreateTableOpenGaussOptions {
  baseStatements: readonly string[];
  baseWarnings?: readonly string[];
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  availableColumns?: readonly string[];
  checks?: readonly EditableTableCheckConstraint[];
  storageOptions?: EditableOpenGaussTableOptions;
  partitionDraft?: EditableOpenGaussPartitionDraft;
  messages?: OpenGaussValidationMessages;
}

export interface BuildOpenGaussAlterTableOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  checks?: readonly EditableTableCheckConstraint[];
  storageOptions?: EditableOpenGaussTableOptions;
  originalStorageOptions?: OpenGaussTableOptionsSnapshot;
  partitionMetadata?: OpenGaussTablePartitionMetadata | null;
  partitionEditDraft?: Pick<EditableOpenGaussPartitionDraft, "updateGlobalIndex" | "pendingOps">;
  messages?: OpenGaussValidationMessages;
}

const DEFAULT_MESSAGES: Required<OpenGaussValidationMessages> = {
  checkNameRequired: "CHECK 约束名称不能为空",
  checkExpressionRequired: "CHECK 约束表达式不能为空",
  duplicateCheckName: (name) => `CHECK 约束名称 "${name}" 重复`,
  columnUstoreIncompatible: "openGauss 列存表 (orientation = column) 不支持 USTORE 存储引擎，请切换为行存或 ASTORE",
  columnFillfactorIncompatible: "openGauss 列存表 (orientation = column) 不支持设置填充因子 (fillfactor)",
  invalidFillfactor: "填充因子 (fillfactor) 必须是 10 到 100 之间的整数",
  rowCompressionLevelIncompatible: "行存表压缩仅支持 no 或 yes；low / middle / high 压缩级别仅适用于列存表",
  partitionKeyRequired: "启用分区表时必须至少选择一个分区键列",
  partitionKeyUnknown: (col) => `分区键列 "${col}" 不存在于当前字段列表中`,
  columnPartitionStrategyIncompatible: "openGauss 列存表仅支持普通 RANGE 分区（不支持 LIST / HASH / INTERVAL 分区）",
  intervalSingleKeyRequired: "openGauss INTERVAL 自动间隔分区仅支持单列分区键",
  intervalMaxvalueIncompatible: "openGauss INTERVAL 自动间隔分区不支持 MAXVALUE 分区边界",
  initialPartitionRequired: "启用分区表时必须至少定义一个初始分区",
  partitionNameRequired: "分区名称不能为空",
  partitionBoundaryRequired: (name) => `分区 "${name}" 的边界值不能为空`,
  duplicatePartitionName: (name) => `分区名称 "${name}" 已存在或重复`,
  invalidHashPartitionCount: "HASH 分区数量必须是大于等于 1 的整数，或手动指定初始分区列表",
  addPartitionUnsupportedStrategy: (strategy) => `openGauss 不支持对 ${strategy.toUpperCase()} 分区表手动执行 ADD PARTITION`,
  splitPartitionUnsupported: "openGauss SPLIT PARTITION 仅支持行存 RANGE / INTERVAL 分区表",
  splitPartitionIncomplete: (name) => `拆分分区 "${name}" 需要完整填写拆分点 (AT) 及两个目标分区名称`,
  splitPartitionSameTargetName: (name) => `拆分分区 "${name}" 的两个目标分区名称不能相同`,
  renamePartitionRequired: (name) => `重命名分区 "${name}" 的新名称不能为空`,
  renamePartitionUnchanged: (name) => `分区 "${name}" 的新名称不能与原名称相同`,
  dropLastPartitionForbidden: (name) => `不能删除最后一个分区 "${name}"（openGauss 要求分区表至少保留一个分区）`,
};

function resolveMessages(messages?: OpenGaussValidationMessages): Required<OpenGaussValidationMessages> {
  return { ...DEFAULT_MESSAGES, ...messages };
}

export function quotePgIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function escapeSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function formatQualifiedTableName(schema: string | undefined, tableName: string): string {
  const trimmedTable = tableName.trim();
  const trimmedSchema = schema?.trim();
  if (trimmedSchema) {
    return `${quotePgIdentifier(trimmedSchema)}.${quotePgIdentifier(trimmedTable)}`;
  }
  return quotePgIdentifier(trimmedTable);
}

function buildSchemaPredicate(alias: string, schema?: string): string {
  const trimmed = schema?.trim();
  if (trimmed) {
    return `${alias}.nspname = ${escapeSqlLiteral(trimmed)}`;
  }
  return `${alias}.nspname = pg_catalog.current_schema()`;
}

export function createDefaultOpenGaussTableOptions(): EditableOpenGaussTableOptions {
  return {
    orientation: "row",
    storageType: "astore",
    compression: "no",
    fillfactor: null,
    tablespace: "",
    enableRowMovement: false,
  };
}

export function createDefaultOpenGaussPartitionDraft(): EditableOpenGaussPartitionDraft {
  return {
    enabled: false,
    strategy: "range",
    partitionKeys: [],
    interval: "",
    hashPartitionCount: 4,
    enableRowMovement: false,
    partitions: [],
    updateGlobalIndex: true,
    pendingOps: [],
  };
}

/**
 * Parses PostgreSQL / openGauss text[] values returned either as a JS array,
 * JSON array string, or `{elem1,"elem2",NULL}` array literal.
 */
export function parsePgTextArrayAllowNull(raw: unknown): (string | null)[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => (item === null || item === undefined ? null : String(item)));
  }
  const text = String(raw).trim();
  if (!text || text === "{}") return [];

  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item) => (item === null || item === undefined ? null : String(item)));
      }
    } catch {
      // Fall through to literal parser
    }
  }

  if (!text.startsWith("{") || !text.endsWith("}")) {
    return [text];
  }

  const inner = text.slice(1, -1);
  if (!inner.length) return [];

  const result: (string | null)[] = [];
  let index = 0;
  while (index < inner.length) {
    while (index < inner.length && inner[index] === " ") index++;
    if (index >= inner.length) break;

    if (inner[index] === '"') {
      index++;
      let buf = "";
      while (index < inner.length) {
        const ch = inner[index];
        if (ch === "\\" && index + 1 < inner.length) {
          buf += inner[index + 1];
          index += 2;
          continue;
        }
        if (ch === '"') {
          if (inner[index + 1] === '"') {
            buf += '"';
            index += 2;
            continue;
          }
          index++;
          break;
        }
        buf += ch;
        index++;
      }
      result.push(buf);
      while (index < inner.length && inner[index] !== ",") index++;
      if (inner[index] === ",") index++;
    } else {
      const nextComma = inner.indexOf(",", index);
      const token = (nextComma === -1 ? inner.slice(index) : inner.slice(index, nextComma)).trim();
      result.push(token.toUpperCase() === "NULL" ? null : token);
      if (nextComma === -1) break;
      index = nextComma + 1;
    }
  }
  return result;
}

export function parsePgTextArray(raw: unknown): string[] {
  return parsePgTextArrayAllowNull(raw).filter((item): item is string => item !== null);
}

/**
 * Parses `pg_class.reloptions` (array or `{k=v,...}` string) into typed openGauss storage options.
 */
export function parseReloptions(raw: unknown): ParsedOpenGaussReloptions {
  const entries = parsePgTextArray(raw);
  let orientation: OpenGaussOrientation = "row";
  let storageType: OpenGaussStorageType = "astore";
  let compression: OpenGaussCompression = "no";
  let fillfactor: number | null = null;
  const extraOptions: Record<string, string> = {};

  for (const entry of entries) {
    const eqIndex = entry.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = entry.slice(0, eqIndex).trim().toLowerCase();
    const value = entry.slice(eqIndex + 1).trim();
    const lowerValue = value.toLowerCase();

    if (key === "orientation") {
      if (lowerValue === "column" || lowerValue === "row") {
        orientation = lowerValue;
      } else {
        extraOptions[key] = value;
      }
    } else if (key === "storage_type") {
      if (lowerValue === "ustore" || lowerValue === "astore") {
        storageType = lowerValue;
      } else {
        extraOptions[key] = value;
      }
    } else if (key === "compression") {
      if (lowerValue === "no" || lowerValue === "yes" || lowerValue === "low" || lowerValue === "middle" || lowerValue === "high") {
        compression = lowerValue;
      } else {
        extraOptions[key] = value;
      }
    } else if (key === "fillfactor") {
      const parsed = Number(value);
      if (Number.isInteger(parsed)) {
        fillfactor = parsed;
      } else {
        extraOptions[key] = value;
      }
    } else {
      extraOptions[key] = value;
    }
  }

  return {
    orientation,
    storageType,
    compression,
    fillfactor,
    extraOptions,
  };
}

function findMatchingClosingParen(text: string, openIndex: number): number {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inSingleQuote) {
      if (ch === "'" && text[i + 1] === "'") {
        i++;
        continue;
      }
      if (ch === "'") inSingleQuote = false;
      continue;
    }
    if (inDoubleQuote) {
      if (ch === '"' && text[i + 1] === '"') {
        i++;
        continue;
      }
      if (ch === '"') inDoubleQuote = false;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function unwrapBalancedOuterParens(expression: string): string {
  let current = expression.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    const closeIdx = findMatchingClosingParen(current, 0);
    if (closeIdx !== current.length - 1) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

/**
 * Strips `CHECK (...)` wrapper produced by `pg_catalog.pg_get_constraintdef(oid, true)`
 * while preserving valid inner boolean expressions.
 */
export function stripCheckConstraintWrapper(definition: string): string {
  const trimmed = definition.trim();
  const checkMatch = /^CHECK\s*\(/i.exec(trimmed);
  if (!checkMatch) return trimmed;
  const openIdx = checkMatch[0].length - 1;
  const closeIdx = findMatchingClosingParen(trimmed, openIdx);
  if (closeIdx === -1) return trimmed;
  const inner = trimmed.slice(openIdx + 1, closeIdx).trim();
  return unwrapBalancedOuterParens(inner);
}

export function createCheckConstraintDrafts(items: readonly TableCheckConstraintInfo[], createId: () => string = () => Math.random().toString(36).slice(2)): EditableTableCheckConstraint[] {
  return items.map((item) => ({
    id: `existing:check:${item.name}:${createId()}`,
    name: item.name,
    expression: item.expression,
    nameEdited: true,
    markedForDrop: false,
    original: { ...item },
  }));
}

export function checkConstraintChanged(check: EditableTableCheckConstraint): boolean {
  if (!check.original || check.markedForDrop) return true;
  return unwrapBalancedOuterParens(stripCheckConstraintWrapper(check.expression)) !== unwrapBalancedOuterParens(stripCheckConstraintWrapper(check.original.expression)) || check.name.trim() !== check.original.name;
}

export function generateCheckConstraintName(tableName: string, existingNames: readonly string[]): string {
  const cleanTable = (tableName.trim() || "table")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = `chk_${cleanTable || "table"}`;
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  for (let counter = 1; counter < 10_000; counter++) {
    const candidate = `${base}_${counter}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}_1`;
}

function formatCatalogBoundaryAtom(value: string | null, nullKeyword: "MAXVALUE" | "DEFAULT"): string {
  if (value === null) return nullKeyword;
  const trimmed = value.trim();
  if (trimmed.toUpperCase() === nullKeyword) return nullKeyword;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed;
  return escapeSqlLiteral(trimmed);
}

export function parsePartitionStrategyCode(code: unknown): OpenGaussPartitionStrategy {
  const normalized = String(code ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "l" || normalized === "list") return "list";
  if (normalized === "h" || normalized === "hash") return "hash";
  if (normalized === "i" || normalized === "interval") return "interval";
  return "range";
}

export function parsePartitionBoundaries(
  raw: unknown,
  strategy: OpenGaussPartitionStrategy,
): {
  rawValues: (string | null)[];
  boundaryDisplay: string;
  editableBoundary: string;
} {
  const rawValues = parsePgTextArrayAllowNull(raw);
  if (strategy === "hash") {
    return {
      rawValues,
      boundaryDisplay: "HASH",
      editableBoundary: "",
    };
  }
  if (strategy === "list") {
    if (rawValues.length === 0) {
      return { rawValues, boundaryDisplay: "VALUES ()", editableBoundary: "" };
    }
    const formatted = rawValues.map((v) => formatCatalogBoundaryAtom(v, "DEFAULT")).join(", ");
    return {
      rawValues,
      boundaryDisplay: `VALUES (${formatted})`,
      editableBoundary: formatted,
    };
  }
  // range or interval
  if (rawValues.length === 0) {
    return { rawValues, boundaryDisplay: "VALUES LESS THAN ()", editableBoundary: "" };
  }
  const formatted = rawValues.map((v) => formatCatalogBoundaryAtom(v, "MAXVALUE")).join(", ");
  return {
    rawValues,
    boundaryDisplay: `VALUES LESS THAN (${formatted})`,
    editableBoundary: formatted,
  };
}

const ISO_DATE_UNQUOTED_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

export function formatRangeBoundaryExpression(raw: string): string {
  const unwrapped = unwrapBalancedOuterParens(raw);
  if (!unwrapped) return "";
  if (/^MAXVALUE$/i.test(unwrapped)) return "MAXVALUE";
  if (ISO_DATE_UNQUOTED_RE.test(unwrapped)) {
    return escapeSqlLiteral(unwrapped);
  }
  return unwrapped;
}

export function formatListBoundaryExpression(raw: string): string {
  const unwrapped = unwrapBalancedOuterParens(raw);
  if (!unwrapped) return "";
  if (/^DEFAULT$/i.test(unwrapped)) return "DEFAULT";
  if (ISO_DATE_UNQUOTED_RE.test(unwrapped)) {
    return escapeSqlLiteral(unwrapped);
  }
  return unwrapped;
}

function formatIntervalExpression(raw: string): string {
  const unwrapped = unwrapBalancedOuterParens(raw);
  if (!unwrapped) return "";
  if (unwrapped.startsWith("'") && unwrapped.endsWith("'")) return unwrapped;
  return escapeSqlLiteral(unwrapped);
}

export function buildCreateTableWithClause(options: EditableOpenGaussTableOptions): string {
  const items: string[] = [];
  if (options.orientation === "column") {
    items.push("orientation = column");
  }
  if (options.orientation === "row" && options.storageType === "ustore") {
    items.push("storage_type = ustore");
  }
  if (options.compression && options.compression !== "no") {
    items.push(`compression = ${options.compression}`);
  }
  if (options.orientation === "row" && options.fillfactor !== null && options.fillfactor !== undefined && Number.isInteger(options.fillfactor)) {
    items.push(`fillfactor = ${options.fillfactor}`);
  }
  return items.length > 0 ? `WITH (${items.join(", ")})` : "";
}

export function buildCreateTablePartitionClause(draft: EditableOpenGaussPartitionDraft): string {
  const quotedKeys = draft.partitionKeys.map((col) => quotePgIdentifier(col.trim())).join(", ");
  if (draft.strategy === "range") {
    const intervalSql = draft.interval.trim() ? ` INTERVAL (${formatIntervalExpression(draft.interval)})` : "";
    const partDefs = draft.partitions.map((item) => {
      const tsSql = item.tablespace.trim() ? ` TABLESPACE ${quotePgIdentifier(item.tablespace.trim())}` : "";
      return `  PARTITION ${quotePgIdentifier(item.name.trim())} VALUES LESS THAN (${formatRangeBoundaryExpression(item.boundary)})${tsSql}`;
    });
    return `PARTITION BY RANGE (${quotedKeys})${intervalSql} (\n${partDefs.join(",\n")}\n)`;
  }

  if (draft.strategy === "list") {
    const partDefs = draft.partitions.map((item) => {
      const tsSql = item.tablespace.trim() ? ` TABLESPACE ${quotePgIdentifier(item.tablespace.trim())}` : "";
      return `  PARTITION ${quotePgIdentifier(item.name.trim())} VALUES (${formatListBoundaryExpression(item.boundary)})${tsSql}`;
    });
    return `PARTITION BY LIST (${quotedKeys}) (\n${partDefs.join(",\n")}\n)`;
  }

  // hash
  const nonEmptyNamed = draft.partitions.filter((item) => item.name.trim().length > 0 || item.tablespace.trim().length > 0);
  if (nonEmptyNamed.length > 0) {
    const partDefs = nonEmptyNamed.map((item) => {
      const tsSql = item.tablespace.trim() ? ` TABLESPACE ${quotePgIdentifier(item.tablespace.trim())}` : "";
      return `  PARTITION ${quotePgIdentifier(item.name.trim())}${tsSql}`;
    });
    return `PARTITION BY HASH (${quotedKeys}) (\n${partDefs.join(",\n")}\n)`;
  }
  const count = draft.hashPartitionCount ?? 4;
  return `PARTITION BY HASH (${quotedKeys}) PARTITIONS ${count}`;
}

function validateCheckDrafts(checks: readonly EditableTableCheckConstraint[], msg: Required<OpenGaussValidationMessages>): string[] {
  const warnings: string[] = [];
  const seenNames = new Set<string>();
  for (const check of checks) {
    if (check.markedForDrop) continue;
    const name = check.name.trim();
    const expr = check.expression.trim();
    if (!name) {
      warnings.push(msg.checkNameRequired);
    } else {
      const lower = name.toLowerCase();
      if (seenNames.has(lower)) {
        warnings.push(msg.duplicateCheckName(name));
      } else {
        seenNames.add(lower);
      }
    }
    if (!expr) {
      warnings.push(msg.checkExpressionRequired);
    }
  }
  return warnings;
}

export function hasCreateModeOpenGaussOptionsChanges(options: EditableOpenGaussTableOptions | undefined): boolean {
  if (!options) return false;
  return options.orientation !== "row" || options.storageType !== "astore" || options.compression !== "no" || (options.fillfactor !== null && options.fillfactor !== undefined) || !!options.tablespace.trim();
}

export function hasCreateModeOpenGaussPartitionChanges(draft: EditableOpenGaussPartitionDraft | undefined): boolean {
  return !!draft?.enabled;
}

export function openGaussOptionsChanged(draft: EditableOpenGaussTableOptions | undefined, original: OpenGaussTableOptionsSnapshot | undefined, isPartitioned = false): boolean {
  if (!draft || !original) return false;
  const nextFill = draft.fillfactor ?? null;
  const origFill = original.fillfactor ?? null;
  if (nextFill !== origFill) return true;
  if ((isPartitioned || original.isPartitioned) && Boolean(draft.enableRowMovement) !== Boolean(original.enableRowMovement)) {
    return true;
  }
  return false;
}

/**
 * Augments `CREATE TABLE` statements generated by `api.buildCreateTableSql` with
 * openGauss `WITH (...)`, `TABLESPACE`, `PARTITION BY ...`, `ENABLE ROW MOVEMENT`,
 * and `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)`.
 */
export function augmentCreateTableSqlWithOpenGauss(options: AugmentCreateTableOpenGaussOptions): {
  statements: string[];
  warnings: string[];
} {
  const msg = resolveMessages(options.messages);
  const warnings: string[] = [...(options.baseWarnings ?? [])];
  const isOpenGauss = (options.databaseType ?? "opengauss") === "opengauss";

  const storage = options.storageOptions;
  const partitionDraft = options.partitionDraft;
  const checks = options.checks ?? [];

  if (isOpenGauss && storage) {
    if (storage.orientation === "column" && storage.storageType === "ustore") {
      warnings.push(msg.columnUstoreIncompatible);
    }
    if (storage.fillfactor !== null && storage.fillfactor !== undefined) {
      if (storage.orientation === "column") {
        warnings.push(msg.columnFillfactorIncompatible);
      } else if (!Number.isInteger(storage.fillfactor) || storage.fillfactor < 10 || storage.fillfactor > 100) {
        warnings.push(msg.invalidFillfactor);
      }
    }
    if (storage.orientation === "row" && (storage.compression === "low" || storage.compression === "middle" || storage.compression === "high")) {
      warnings.push(msg.rowCompressionLevelIncompatible);
    }
  }

  let canRenderPartitionClause = false;
  if (isOpenGauss && partitionDraft?.enabled) {
    const keys = partitionDraft.partitionKeys.map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) {
      warnings.push(msg.partitionKeyRequired);
    } else if (options.availableColumns) {
      const availableSet = new Set(options.availableColumns.map((c) => c.trim()));
      for (const key of keys) {
        if (!availableSet.has(key)) {
          warnings.push(msg.partitionKeyUnknown(key));
        }
      }
    }

    if (storage?.orientation === "column" && (partitionDraft.strategy !== "range" || !!partitionDraft.interval.trim())) {
      warnings.push(msg.columnPartitionStrategyIncompatible);
    }

    if (partitionDraft.strategy === "range") {
      if (partitionDraft.interval.trim() && keys.length > 1) {
        warnings.push(msg.intervalSingleKeyRequired);
      }
      if (partitionDraft.partitions.length === 0) {
        warnings.push(msg.initialPartitionRequired);
      } else {
        const seenPartNames = new Set<string>();
        let allValid = keys.length > 0;
        for (const item of partitionDraft.partitions) {
          const pName = item.name.trim();
          const pBound = item.boundary.trim();
          if (!pName) {
            warnings.push(msg.partitionNameRequired);
            allValid = false;
          } else {
            const lower = pName.toLowerCase();
            if (seenPartNames.has(lower)) {
              warnings.push(msg.duplicatePartitionName(pName));
              allValid = false;
            } else {
              seenPartNames.add(lower);
            }
          }
          if (!pBound) {
            warnings.push(msg.partitionBoundaryRequired(pName || "#"));
            allValid = false;
          } else if (partitionDraft.interval.trim() && /^MAXVALUE$/i.test(unwrapBalancedOuterParens(pBound))) {
            warnings.push(msg.intervalMaxvalueIncompatible);
            allValid = false;
          }
        }
        canRenderPartitionClause = allValid;
      }
    } else if (partitionDraft.strategy === "list") {
      if (partitionDraft.partitions.length === 0) {
        warnings.push(msg.initialPartitionRequired);
      } else {
        const seenPartNames = new Set<string>();
        let allValid = keys.length > 0;
        for (const item of partitionDraft.partitions) {
          const pName = item.name.trim();
          const pBound = item.boundary.trim();
          if (!pName) {
            warnings.push(msg.partitionNameRequired);
            allValid = false;
          } else {
            const lower = pName.toLowerCase();
            if (seenPartNames.has(lower)) {
              warnings.push(msg.duplicatePartitionName(pName));
              allValid = false;
            } else {
              seenPartNames.add(lower);
            }
          }
          if (!pBound) {
            warnings.push(msg.partitionBoundaryRequired(pName || "#"));
            allValid = false;
          }
        }
        canRenderPartitionClause = allValid;
      }
    } else if (partitionDraft.strategy === "hash") {
      const nonEmptyNamed = partitionDraft.partitions.filter((item) => item.name.trim().length > 0 || item.tablespace.trim().length > 0);
      if (nonEmptyNamed.length > 0) {
        const seenPartNames = new Set<string>();
        let allValid = keys.length > 0;
        for (const item of nonEmptyNamed) {
          const pName = item.name.trim();
          if (!pName) {
            warnings.push(msg.partitionNameRequired);
            allValid = false;
          } else {
            const lower = pName.toLowerCase();
            if (seenPartNames.has(lower)) {
              warnings.push(msg.duplicatePartitionName(pName));
              allValid = false;
            } else {
              seenPartNames.add(lower);
            }
          }
        }
        canRenderPartitionClause = allValid;
      } else {
        const count = partitionDraft.hashPartitionCount;
        if (count === null || count === undefined || !Number.isInteger(count) || count < 1) {
          warnings.push(msg.invalidHashPartitionCount);
        } else {
          canRenderPartitionClause = keys.length > 0;
        }
      }
    }
  }

  const checkWarnings = validateCheckDrafts(checks, msg);
  warnings.push(...checkWarnings);

  const createIndex = options.baseStatements.findIndex((sql) => /^\s*CREATE\s+TABLE\b/i.test(sql));
  if (createIndex === -1 || !options.tableName.trim()) {
    return {
      statements: [...options.baseStatements],
      warnings: dedupeWarnings(warnings),
    };
  }

  const statements = [...options.baseStatements];
  const rawCreateSql = statements[createIndex];
  const hasSemicolon = /;\s*$/.test(rawCreateSql);
  let createSql = rawCreateSql.replace(/;\s*$/, "").trimEnd();

  if (isOpenGauss) {
    if (storage) {
      const withClause = buildCreateTableWithClause(storage);
      if (withClause) {
        createSql += `\n${withClause}`;
      }
      if (storage.tablespace.trim()) {
        createSql += `\nTABLESPACE ${quotePgIdentifier(storage.tablespace.trim())}`;
      }
    }
    if (partitionDraft?.enabled && canRenderPartitionClause) {
      createSql += `\n${buildCreateTablePartitionClause(partitionDraft)}`;
      if (partitionDraft.enableRowMovement) {
        createSql += "\nENABLE ROW MOVEMENT";
      }
    }
  }

  statements[createIndex] = hasSemicolon ? `${createSql};` : createSql;

  const qualifiedTable = formatQualifiedTableName(options.schema, options.tableName);
  const checkStatements: string[] = [];
  for (const check of checks) {
    if (check.markedForDrop) continue;
    const name = check.name.trim();
    const expr = stripCheckConstraintWrapper(check.expression);
    if (!name || !expr) continue;
    checkStatements.push(`ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${quotePgIdentifier(name)} CHECK (${expr})`);
  }

  if (checkStatements.length > 0) {
    statements.splice(createIndex + 1, 0, ...checkStatements);
  }

  return {
    statements,
    warnings: dedupeWarnings(warnings),
  };
}

/**
 * Builds `ALTER TABLE` statements and validation warnings for existing table edits:
 * - Check constraint drop / add / modify
 * - openGauss `SET (fillfactor = ...)` / `RESET (fillfactor)` & `ENABLE/DISABLE ROW MOVEMENT`
 * - openGauss partition operations (`ADD`, `SPLIT`, `TRUNCATE`, `RENAME`, `DROP` + `UPDATE GLOBAL INDEX`)
 */
export function buildOpenGaussAlterTableStatements(options: BuildOpenGaussAlterTableOptions): {
  statements: string[];
  warnings: string[];
} {
  const msg = resolveMessages(options.messages);
  const statements: string[] = [];
  const warnings: string[] = [];
  const isOpenGauss = (options.databaseType ?? "opengauss") === "opengauss";

  if (!options.tableName.trim()) {
    return { statements, warnings };
  }

  const qualifiedTable = formatQualifiedTableName(options.schema, options.tableName);

  // 1. Check constraints
  const checks = options.checks ?? [];
  warnings.push(...validateCheckDrafts(checks, msg));

  const dropCheckStatements: string[] = [];
  const addCheckStatements: string[] = [];
  for (const check of checks) {
    if (check.original && check.markedForDrop) {
      dropCheckStatements.push(`ALTER TABLE ${qualifiedTable} DROP CONSTRAINT ${quotePgIdentifier(check.original.name)}`);
      continue;
    }
    if (check.original && !check.markedForDrop && checkConstraintChanged(check)) {
      dropCheckStatements.push(`ALTER TABLE ${qualifiedTable} DROP CONSTRAINT ${quotePgIdentifier(check.original.name)}`);
      const name = check.name.trim();
      const expr = stripCheckConstraintWrapper(check.expression);
      if (name && expr) {
        addCheckStatements.push(`ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${quotePgIdentifier(name)} CHECK (${expr})`);
      }
      continue;
    }
    if (!check.original && !check.markedForDrop) {
      const name = check.name.trim();
      const expr = stripCheckConstraintWrapper(check.expression);
      if (name && expr) {
        addCheckStatements.push(`ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${quotePgIdentifier(name)} CHECK (${expr})`);
      }
    }
  }
  statements.push(...dropCheckStatements, ...addCheckStatements);

  if (!isOpenGauss) {
    return { statements, warnings: dedupeWarnings(warnings) };
  }

  // 2. Storage options (fillfactor & row movement)
  const storage = options.storageOptions;
  const origStorage = options.originalStorageOptions;
  const isPartitioned = Boolean(options.partitionMetadata) || Boolean(origStorage?.isPartitioned);

  if (storage && origStorage) {
    const nextFill = storage.fillfactor ?? null;
    const origFill = origStorage.fillfactor ?? null;
    if (nextFill !== origFill) {
      if (origStorage.orientation === "column" && nextFill !== null) {
        warnings.push(msg.columnFillfactorIncompatible);
      } else if (nextFill !== null) {
        if (!Number.isInteger(nextFill) || nextFill < 10 || nextFill > 100) {
          warnings.push(msg.invalidFillfactor);
        } else {
          statements.push(`ALTER TABLE ${qualifiedTable} SET (fillfactor = ${nextFill})`);
        }
      } else {
        statements.push(`ALTER TABLE ${qualifiedTable} RESET (fillfactor)`);
      }
    }

    if (isPartitioned && Boolean(storage.enableRowMovement) !== Boolean(origStorage.enableRowMovement)) {
      statements.push(`ALTER TABLE ${qualifiedTable} ${storage.enableRowMovement ? "ENABLE" : "DISABLE"} ROW MOVEMENT`);
    }
  }

  // 3. Partition DDL operations
  const partMeta = options.partitionMetadata;
  const partEdit = options.partitionEditDraft;
  if (partMeta && partEdit && partEdit.pendingOps.length > 0) {
    const gpiClause = partEdit.updateGlobalIndex !== false ? " UPDATE GLOBAL INDEX" : "";
    const activeNames = new Set(partMeta.partitions.map((p) => p.name.toLowerCase()));
    let remainingCount = partMeta.partitions.length;

    for (const op of partEdit.pendingOps) {
      if (op.type === "add") {
        if (partMeta.strategy === "hash" || partMeta.strategy === "interval") {
          warnings.push(msg.addPartitionUnsupportedStrategy(partMeta.strategy));
          continue;
        }
        const pName = op.partitionName.trim();
        const pBound = op.boundary.trim();
        if (!pName) {
          warnings.push(msg.partitionNameRequired);
          continue;
        }
        const lower = pName.toLowerCase();
        if (activeNames.has(lower)) {
          warnings.push(msg.duplicatePartitionName(pName));
          continue;
        }
        if (!pBound) {
          warnings.push(msg.partitionBoundaryRequired(pName));
          continue;
        }
        const boundSql = partMeta.strategy === "list" ? `VALUES (${formatListBoundaryExpression(pBound)})` : `VALUES LESS THAN (${formatRangeBoundaryExpression(pBound)})`;
        const tsSql = op.tablespace?.trim() ? ` TABLESPACE ${quotePgIdentifier(op.tablespace.trim())}` : "";
        statements.push(`ALTER TABLE ${qualifiedTable} ADD PARTITION ${quotePgIdentifier(pName)} ${boundSql}${tsSql}`);
        activeNames.add(lower);
        remainingCount += 1;
      } else if (op.type === "split") {
        const targetOrientation = origStorage?.orientation ?? "row";
        if ((partMeta.strategy !== "range" && partMeta.strategy !== "interval") || targetOrientation === "column") {
          warnings.push(msg.splitPartitionUnsupported);
          continue;
        }
        const sourceName = op.partitionName.trim();
        const atVal = op.atValue.trim();
        const p1 = op.firstPartitionName.trim();
        const p2 = op.secondPartitionName.trim();
        if (!sourceName || !atVal || !p1 || !p2) {
          warnings.push(msg.splitPartitionIncomplete(sourceName || "#"));
          continue;
        }
        if (p1.toLowerCase() === p2.toLowerCase()) {
          warnings.push(msg.splitPartitionSameTargetName(sourceName));
          continue;
        }
        const sourceLower = sourceName.toLowerCase();
        const p1Lower = p1.toLowerCase();
        const p2Lower = p2.toLowerCase();
        if (p1Lower !== sourceLower && activeNames.has(p1Lower)) {
          warnings.push(msg.duplicatePartitionName(p1));
          continue;
        }
        if (p2Lower !== sourceLower && activeNames.has(p2Lower)) {
          warnings.push(msg.duplicatePartitionName(p2));
          continue;
        }
        statements.push(`ALTER TABLE ${qualifiedTable} SPLIT PARTITION ${quotePgIdentifier(sourceName)} AT (${formatRangeBoundaryExpression(atVal)}) INTO (PARTITION ${quotePgIdentifier(p1)}, PARTITION ${quotePgIdentifier(p2)})${gpiClause}`);
        activeNames.delete(sourceLower);
        activeNames.add(p1Lower);
        activeNames.add(p2Lower);
        remainingCount += 1;
      } else if (op.type === "truncate") {
        const pName = op.partitionName.trim();
        if (!pName) {
          warnings.push(msg.partitionNameRequired);
          continue;
        }
        statements.push(`ALTER TABLE ${qualifiedTable} TRUNCATE PARTITION ${quotePgIdentifier(pName)}${gpiClause}`);
      } else if (op.type === "rename") {
        const oldName = op.partitionName.trim();
        const newName = op.newPartitionName.trim();
        if (!newName) {
          warnings.push(msg.renamePartitionRequired(oldName || "#"));
          continue;
        }
        if (newName === oldName) {
          warnings.push(msg.renamePartitionUnchanged(oldName));
          continue;
        }
        const oldLower = oldName.toLowerCase();
        const newLower = newName.toLowerCase();
        if (newLower !== oldLower && activeNames.has(newLower)) {
          warnings.push(msg.duplicatePartitionName(newName));
          continue;
        }
        statements.push(`ALTER TABLE ${qualifiedTable} RENAME PARTITION ${quotePgIdentifier(oldName)} TO ${quotePgIdentifier(newName)}`);
        activeNames.delete(oldLower);
        activeNames.add(newLower);
      } else if (op.type === "drop") {
        const pName = op.partitionName.trim();
        if (!pName) {
          warnings.push(msg.partitionNameRequired);
          continue;
        }
        if (remainingCount <= 1) {
          warnings.push(msg.dropLastPartitionForbidden(pName));
          continue;
        }
        statements.push(`ALTER TABLE ${qualifiedTable} DROP PARTITION ${quotePgIdentifier(pName)}${gpiClause}`);
        activeNames.delete(pName.toLowerCase());
        remainingCount -= 1;
      }
    }
  }

  return {
    statements,
    warnings: dedupeWarnings(warnings),
  };
}

function dedupeWarnings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

// ============================================================================
// System Catalog SQL Builders & Metadata Fetchers
// ============================================================================

export function buildListCheckConstraintsSql(schema: string | undefined, tableName: string): string {
  return `SELECT con.conname AS name,
       pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
JOIN pg_catalog.pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE con.contype = 'c'
  AND ${buildSchemaPredicate("nsp", schema)}
  AND rel.relname = ${escapeSqlLiteral(tableName.trim())}
ORDER BY con.conname`;
}

export async function fetchTableCheckConstraints(runQuery: OpenGaussMetadataQueryRunner, schema: string | undefined, tableName: string): Promise<TableCheckConstraintInfo[]> {
  const res = await runQuery(buildListCheckConstraintsSql(schema, tableName));
  const nameIdx = columnIndex(res.columns, "name", 0);
  const defIdx = columnIndex(res.columns, "definition", 1);
  return res.rows.map((row) => {
    const name = String(row[nameIdx] ?? "");
    const definition = String(row[defIdx] ?? "");
    return {
      name,
      definition,
      expression: stripCheckConstraintWrapper(definition),
    };
  });
}

export function buildOpenGaussTableOptionsSql(schema: string | undefined, tableName: string, includeRowMovement = true): string {
  const rowMovementCol = includeRowMovement ? ", c.relrowmovement AS row_movement" : "";
  return `SELECT c.reloptions AS reloptions, ts.spcname AS tablespace${rowMovementCol}
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = c.reltablespace
WHERE ${buildSchemaPredicate("n", schema)}
  AND c.relname = ${escapeSqlLiteral(tableName.trim())}`;
}

export async function fetchOpenGaussTableOptions(runQuery: OpenGaussMetadataQueryRunner, schema: string | undefined, tableName: string): Promise<OpenGaussTableOptionsSnapshot> {
  let res: Pick<QueryResult, "columns" | "rows">;
  try {
    res = await runQuery(buildOpenGaussTableOptionsSql(schema, tableName, true));
  } catch {
    res = await runQuery(buildOpenGaussTableOptionsSql(schema, tableName, false));
  }
  const row = res.rows[0];
  if (!row) {
    return {
      ...createDefaultOpenGaussTableOptions(),
    };
  }
  const reloptionsIdx = columnIndex(res.columns, "reloptions", 0);
  const tablespaceIdx = columnIndex(res.columns, "tablespace", 1);
  const rowMovementIdx = res.columns.findIndex((c) => c.toLowerCase() === "row_movement");

  const parsed = parseReloptions(row[reloptionsIdx]);
  const tablespace = row[tablespaceIdx] != null ? String(row[tablespaceIdx]) : "";
  const rawRowMovement = rowMovementIdx >= 0 ? row[rowMovementIdx] : false;
  const enableRowMovement = parsePgBool(rawRowMovement);

  return {
    orientation: parsed.orientation,
    storageType: parsed.storageType,
    compression: parsed.compression,
    fillfactor: parsed.fillfactor,
    tablespace,
    enableRowMovement,
  };
}

export function buildOpenGaussPartitionHeaderSql(schema: string | undefined, tableName: string, includeRowMovement = true): string {
  const rowMovementCol = includeRowMovement ? ", c.relrowmovement AS row_movement" : "";
  return `SELECT c.oid::text AS table_oid,
       r.partstrategy::text AS partstrategy,
       r.partkey::text AS partkey,
       r.interval AS interval_values${rowMovementCol}
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_partition r ON r.parentid = c.oid AND r.parttype = 'r'
WHERE ${buildSchemaPredicate("n", schema)}
  AND c.relname = ${escapeSqlLiteral(tableName.trim())}`;
}

function buildTableAttributesSql(tableOid: string): string {
  return `SELECT a.attnum::int AS attnum, a.attname AS attname
FROM pg_catalog.pg_attribute a
WHERE a.attrelid = ${escapeSqlLiteral(tableOid)}::oid
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum`;
}

function buildPartitionItemsSql(tableOid: string, includeSize: boolean): string {
  const sizeExpr = includeSize ? "pg_catalog.pg_partition_size(p.parentid, p.oid) AS size_bytes" : "NULL AS size_bytes";
  return `SELECT p.oid::text AS part_oid,
       p.relname AS name,
       p.partstrategy::text AS partstrategy,
       p.boundaries AS boundaries,
       ts.spcname AS tablespace,
       p.reltuples AS estimated_rows,
       ${sizeExpr},
       (SELECT COUNT(*)::int FROM pg_catalog.pg_partition sp WHERE sp.parentid = p.oid AND sp.parttype = 's') AS subpartition_count
FROM pg_catalog.pg_partition p
LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = p.reltablespace
WHERE p.parentid = ${escapeSqlLiteral(tableOid)}::oid
  AND p.parttype = 'p'
ORDER BY p.oid`;
}

function buildSubpartitionItemsSql(tableOid: string): string {
  return `SELECT sp.oid::text AS subpart_oid,
       sp.parentid::text AS parent_part_oid,
       sp.relname AS name,
       sp.partstrategy::text AS partstrategy,
       sp.boundaries AS boundaries,
       ts.spcname AS tablespace,
       sp.reltuples AS estimated_rows
FROM pg_catalog.pg_partition sp
JOIN pg_catalog.pg_partition p ON sp.parentid = p.oid
LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = sp.reltablespace
WHERE p.parentid = ${escapeSqlLiteral(tableOid)}::oid
  AND p.parttype = 'p'
  AND sp.parttype = 's'
ORDER BY p.oid, sp.oid`;
}

export async function fetchOpenGaussTablePartitions(runQuery: OpenGaussMetadataQueryRunner, schema: string | undefined, tableName: string): Promise<OpenGaussTablePartitionMetadata | null> {
  let headerRes: Pick<QueryResult, "columns" | "rows">;
  try {
    headerRes = await runQuery(buildOpenGaussPartitionHeaderSql(schema, tableName, true));
  } catch {
    headerRes = await runQuery(buildOpenGaussPartitionHeaderSql(schema, tableName, false));
  }

  const headerRow = headerRes.rows[0];
  if (!headerRow) return null;

  const tableOid = String(headerRow[columnIndex(headerRes.columns, "table_oid", 0)] ?? "").trim();
  if (!tableOid) return null;

  const strategy = parsePartitionStrategyCode(headerRow[columnIndex(headerRes.columns, "partstrategy", 1)]);
  const rawPartkey = String(headerRow[columnIndex(headerRes.columns, "partkey", 2)] ?? "").trim();
  const intervalArr = parsePgTextArray(headerRow[columnIndex(headerRes.columns, "interval_values", 3)]);
  const rowMoveIdx = headerRes.columns.findIndex((c) => c.toLowerCase() === "row_movement");
  const enableRowMovement = rowMoveIdx >= 0 ? parsePgBool(headerRow[rowMoveIdx]) : false;

  const [attrRes, partsRes] = await Promise.all([runQuery(buildTableAttributesSql(tableOid)), runQuery(buildPartitionItemsSql(tableOid, true)).catch(() => runQuery(buildPartitionItemsSql(tableOid, false)))]);

  const attMap = new Map<number, string>();
  const attNumIdx = columnIndex(attrRes.columns, "attnum", 0);
  const attNameIdx = columnIndex(attrRes.columns, "attname", 1);
  for (const r of attrRes.rows) {
    const num = Number(r[attNumIdx]);
    const name = String(r[attNameIdx] ?? "");
    if (Number.isInteger(num) && name) {
      attMap.set(num, name);
    }
  }

  const partitionKeys = rawPartkey
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => attMap.get(Number(token)) ?? token)
    .filter(Boolean);

  const oidIdx = columnIndex(partsRes.columns, "part_oid", 0);
  const nameIdx = columnIndex(partsRes.columns, "name", 1);
  const pStratIdx = columnIndex(partsRes.columns, "partstrategy", 2);
  const boundIdx = columnIndex(partsRes.columns, "boundaries", 3);
  const spcIdx = columnIndex(partsRes.columns, "tablespace", 4);
  const rowsIdx = columnIndex(partsRes.columns, "estimated_rows", 5);
  const sizeIdx = columnIndex(partsRes.columns, "size_bytes", 6);
  const subCntIdx = columnIndex(partsRes.columns, "subpartition_count", 7);

  let totalSubpartitions = 0;
  const partitions: OpenGaussPartitionItemMetadata[] = partsRes.rows.map((r) => {
    const itemStrategy = parsePartitionStrategyCode(r[pStratIdx] ?? strategy);
    const effectiveBoundaryStrategy = strategy === "interval" ? "range" : strategy === "hash" ? "hash" : itemStrategy;
    const parsedBounds = parsePartitionBoundaries(r[boundIdx], effectiveBoundaryStrategy);
    const subCnt = r[subCntIdx] != null ? Math.max(0, Number(r[subCntIdx]) || 0) : 0;
    totalSubpartitions += subCnt;
    const estRows = r[rowsIdx] != null && Number.isFinite(Number(r[rowsIdx])) ? Math.max(0, Math.round(Number(r[rowsIdx]))) : null;
    const sizeBytes = r[sizeIdx] != null && Number.isFinite(Number(r[sizeIdx])) ? Math.max(0, Number(r[sizeIdx])) : null;
    return {
      oid: String(r[oidIdx] ?? ""),
      name: String(r[nameIdx] ?? ""),
      strategy: itemStrategy,
      rawBoundaries: parsedBounds.rawValues,
      boundaryDisplay: parsedBounds.boundaryDisplay,
      editableBoundary: parsedBounds.editableBoundary,
      tablespace: r[spcIdx] != null ? String(r[spcIdx]) : "",
      estimatedRows: estRows,
      sizeBytes,
      subpartitionCount: subCnt,
    };
  });

  if (totalSubpartitions > 0) {
    try {
      const subRes = await runQuery(buildSubpartitionItemsSql(tableOid));
      const spOidIdx = columnIndex(subRes.columns, "subpart_oid", 0);
      const spParentIdx = columnIndex(subRes.columns, "parent_part_oid", 1);
      const spNameIdx = columnIndex(subRes.columns, "name", 2);
      const spStratIdx = columnIndex(subRes.columns, "partstrategy", 3);
      const spBoundIdx = columnIndex(subRes.columns, "boundaries", 4);
      const spSpcIdx = columnIndex(subRes.columns, "tablespace", 5);
      const spRowsIdx = columnIndex(subRes.columns, "estimated_rows", 6);

      const byParent = new Map<string, OpenGaussSubpartitionItemMetadata[]>();
      for (const r of subRes.rows) {
        const parentOid = String(r[spParentIdx] ?? "");
        const spStrategy = parsePartitionStrategyCode(r[spStratIdx]);
        const parsedBounds = parsePartitionBoundaries(r[spBoundIdx], spStrategy);
        const list = byParent.get(parentOid) ?? [];
        list.push({
          oid: String(r[spOidIdx] ?? ""),
          parentPartitionOid: parentOid,
          name: String(r[spNameIdx] ?? ""),
          strategy: spStrategy,
          rawBoundaries: parsedBounds.rawValues,
          boundaryDisplay: parsedBounds.boundaryDisplay,
          tablespace: r[spSpcIdx] != null ? String(r[spSpcIdx]) : "",
          estimatedRows: r[spRowsIdx] != null && Number.isFinite(Number(r[spRowsIdx])) ? Math.max(0, Math.round(Number(r[spRowsIdx]))) : null,
        });
        byParent.set(parentOid, list);
      }
      for (const part of partitions) {
        part.subpartitions = byParent.get(part.oid) ?? [];
      }
    } catch {
      // Optional subpartition detail fallback
    }
  }

  return {
    tableOid,
    strategy,
    partitionKeys,
    interval: intervalArr[0] ?? "",
    subpartitionCount: totalSubpartitions,
    enableRowMovement,
    partitions,
  };
}

function columnIndex(columns: readonly string[], name: string, fallback: number): number {
  const idx = columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
  return idx >= 0 ? idx : fallback;
}

function parsePgBool(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  return s === "true" || s === "t" || s === "1" || s === "yes" || s === "on";
}

export function formatByteSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIdx]}`;
}
