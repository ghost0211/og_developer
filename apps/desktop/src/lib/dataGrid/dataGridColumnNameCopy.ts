import type { DatabaseType } from "@/types/database";
import { quoteTableIdentifier } from "@/lib/table/tableSelectSql";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export type ColumnNameCopySeparator = "tab" | "comma" | "newline" | "comma-newline";

export const COLUMN_NAME_COPY_SEPARATOR_VALUES: Record<ColumnNameCopySeparator, string> = {
  tab: "\t",
  comma: ",",
  newline: "\n",
  "comma-newline": ",\n",
};

export const COLUMN_NAME_COPY_SEPARATOR_OPTIONS = Object.keys(COLUMN_NAME_COPY_SEPARATOR_VALUES) as ColumnNameCopySeparator[];

export const COLUMN_NAME_COPY_SEPARATOR_LABELS: Record<ColumnNameCopySeparator, string> = {
  tab: "\\t",
  comma: ",",
  newline: "\\n",
  "comma-newline": ",\\n",
};

export function isColumnNameCopySeparator(value: unknown): value is ColumnNameCopySeparator {
  return typeof value === "string" && value in COLUMN_NAME_COPY_SEPARATOR_VALUES;
}

// quoteTableIdentifier 对 jdbc 原样返回（无引用字符可用）。
const UNQUOTABLE_DATABASE_TYPES = new Set<DatabaseType>(["jdbc"]);

export function supportsColumnNameQuoting(databaseType?: DatabaseType): boolean {
  return !!databaseType && !UNQUOTABLE_DATABASE_TYPES.has(databaseType);
}

export function columnNamesForCopy(allColumnNames: readonly string[], visibleColumnNames: readonly string[], scope: "all" | "visible"): string[] {
  return [...(scope === "all" ? allColumnNames : visibleColumnNames)];
}

export function formatColumnNamesForCopy(names: readonly string[], options: { separator: ColumnNameCopySeparator; quote?: boolean; databaseType?: DatabaseType; showByComment?: boolean; commentByColumn?: Map<string, string> }): string {
  const quote = !!options.quote && supportsColumnNameQuoting(options.databaseType);
  const displayNames = options.showByComment && options.commentByColumn ? names.map((name) => options.commentByColumn!.get(name) || name) : [...names];
  const parts = quote ? displayNames.map((name) => quoteTableIdentifier(options.databaseType, name)) : displayNames;
  return parts.join(COLUMN_NAME_COPY_SEPARATOR_VALUES[options.separator]);
}

const SEPARATOR_STORAGE_KEY = "dbx-copy-column-names-separator";

export function loadColumnNameCopySeparator(): ColumnNameCopySeparator {
  const stored = safeLocalStorageGet(SEPARATOR_STORAGE_KEY);
  return isColumnNameCopySeparator(stored) ? stored : "tab";
}

export function saveColumnNameCopySeparator(separator: ColumnNameCopySeparator) {
  safeLocalStorageSet(SEPARATOR_STORAGE_KEY, separator);
}
