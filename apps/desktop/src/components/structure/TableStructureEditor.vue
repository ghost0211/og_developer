<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Copy, Database, Eraser, Info, KeyRound, ListChevronsUpDown, Loader2, Maximize2, Pencil, Plus, RefreshCw, Save, Search, Settings, SlidersHorizontal, Split, Trash2, X } from "@lucide/vue";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useSettingsStore, type StructureEditorDensity } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import { type SqlHighlighter, createShikiSqlHighlighter } from "@/lib/sql/sqlHighlighter";
import { joinSqlStatementsForScript } from "@/lib/sql/sqlBatchScript";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatSqlForDisplay, sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { invalidateObjectDdl, loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import { loadObjectMetadataFacet, type ObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import { invalidateTableMetadataCache } from "@/lib/metadata/tableMetadataCache";
import { shouldCheckEmptyColumnsObjectExistence } from "@/lib/table/tableStructureMissingObject";
import { type BuildTableStructureChangeSqlOptions, type EditableStructureColumn, type EditableStructureForeignKey, type EditableStructureIndex, type EditableStructureTrigger } from "@/lib/table/tableStructureEditorSql";
import { PRESET_FIELDS_TEMPLATE_ID, createTableColumnTemplateDrafts } from "@/lib/table/tableColumnTemplates";
import { getPostgresDataTypeHelp } from "@/lib/table/postgresDataTypeHelp";
import { getTableMetadataCapabilities, firstStructureMetadataTab, isStructureMetadataTabSupported } from "@/lib/table/tableMetadataCapabilities";
import { hasTableStructureRefreshWork, unloadedTableStructureRefreshScope, visibleTableStructureRefreshScope, type TableStructureRefreshScope } from "@/lib/table/tableStructureMetadataLoading";
import { canAddTableStructureColumn, getTableStructureCapabilities, hasLocalTableColumnOrderChange, isPhysicalTableColumnOrderChange, sanitizeStructureIndexesForCapabilities, supportsLocalTableColumnReorder } from "@/lib/table/tableStructureCapabilities";
import { orderedColumnIndexes, uniqueDataGridColumnOrderKeys } from "@/lib/dataGrid/dataGridColumnOrder";
import { loadTableDataGridColumnOrder, notifyTableDataGridColumnOrderChanged, removeTableDataGridColumnOrder, saveTableDataGridColumnOrder, tableDataGridColumnOrderScopeKey } from "@/lib/dataGrid/dataGridColumnLayoutStorage";
import { connectionObjectTreeQuerySchema, tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import type { TableInfoTab, TableStructureEditorDraft, TableStructureEditorTarget, TableStructureEditorViewport } from "@/types/database";
import {
  buildStructureTargetLabel,
  canEditStructuredTriggerDraft,
  combineDataTypeForDatabase,
  createColumnDrafts,
  createForeignKeyDrafts,
  createIndexDrafts,
  createTriggerDrafts,
  dataTypeLengthInputValue,
  defaultNewColumnDataType,
  filterStructureIndexColumnOptions,
  generateIndexName,
  generateUniqueIndexName,
  getColumnEditorControls,
  getDataTypeOptions,
  getDefaultLengthForType,
  isDataTypeLengthDisabled,
  parseExtraToColumnExtra,
  rehydrateColumnDraftsFromMetadata,
  resolveInsertColumnIndex,
  sameStructureIndexType,
  splitDataType,
  toColumnNames,
} from "@/lib/table/tableStructureEditorState";
import {
  augmentCreateTableSqlWithOpenGauss,
  buildOpenGaussAlterTableStatements,
  checkConstraintChanged,
  createCheckConstraintDrafts,
  createDefaultOpenGaussPartitionDraft,
  createDefaultOpenGaussTableOptions,
  fetchOpenGaussTableOptions,
  fetchOpenGaussTablePartitions,
  fetchTableCheckConstraints,
  formatByteSize,
  generateCheckConstraintName,
  hasCreateModeOpenGaussOptionsChanges,
  hasCreateModeOpenGaussPartitionChanges,
  openGaussOptionsChanged,
  type EditableOpenGaussPartitionDraft,
  type EditableOpenGaussTableOptions,
  type EditableTableCheckConstraint,
  type OpenGaussCompression,
  type OpenGaussCreatePartitionStrategy,
  type OpenGaussOrientation,
  type OpenGaussPartitionPendingOp,
  type OpenGaussStorageType,
  type OpenGaussTableOptionsSnapshot,
  type OpenGaussTablePartitionMetadata,
  type OpenGaussValidationMessages,
} from "@/lib/table/opengaussTableStructure";
import * as api from "@/lib/backend/api";

const { t } = useI18n();
const { isDark } = useTheme();
const store = useConnectionStore();
const productionSafetyStore = useProductionSafetyStore();
const queryStore = useQueryStore();
const historyStore = useHistoryStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const rootRef = ref<HTMLElement>();
type StructureScrollerRef = HTMLElement | { $el?: HTMLElement };
const columnsScrollerRef = ref<StructureScrollerRef>();
const indexesScrollerRef = ref<StructureScrollerRef>();
const foreignKeysScrollerRef = ref<StructureScrollerRef>();
const triggersScrollerRef = ref<StructureScrollerRef>();
const checksScrollerRef = ref<StructureScrollerRef>();
const partitionsScrollerRef = ref<StructureScrollerRef>();
const optionsScrollerRef = ref<StructureScrollerRef>();
const ddlScrollerRef = ref<StructureScrollerRef>();
const dynamicDataTypeOptionsCache = new Map<string, string[]>();

const sqlHighlighter = ref<SqlHighlighter>();
onMounted(async () => {
  sqlHighlighter.value = await createShikiSqlHighlighter({
    appearance: () => (isDark.value ? "dark" : "light"),
  });
});

const highlightedSql = computed(() => {
  if (!pendingStatements.value.length) return "";
  const sql = previewSqlText.value;
  return sqlHighlighter.value?.(sql) ?? sql;
});
const previewSqlText = computed(() => joinSqlStatementsForScript(pendingStatements.value, databaseType.value));

const props = defineProps<{
  connectionId: string;
  database: string;
  catalog?: string;
  schema?: string;
  tableName: string;
  initialTab?: TableInfoTab;
  initialTabRequestId?: number;
  initialTarget?: TableStructureEditorTarget;
  draft?: TableStructureEditorDraft;
}>();

const emit = defineEmits<{
  "update:draft": [draft: TableStructureEditorDraft | undefined];
  saved: [commentChanged: boolean];
  close: [];
  openSettings: [initialTab?: string, initialSection?: string];
}>();

const activeTab = ref<TableInfoTab>("columns");
const loading = ref(false);
const saving = ref(false);
const postSaveRefreshing = ref(false);
const sqlPreviewLoading = ref(false);
const indexesLoading = ref(false);
const foreignKeysLoading = ref(false);
const triggersLoading = ref(false);
const checksLoading = ref(false);
const openGaussOptionsLoading = ref(false);
const openGaussPartitionsLoading = ref(false);
const ddlContent = ref("");
const ddlLoading = ref(false);
const loadedMetadataFacets = new Set<ObjectMetadataFacet>();
let structureEditorReady = false;
const ddlPreRef = ref<HTMLPreElement | null>(null);
function onDdlKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    e.preventDefault();
    const el = ddlPreRef.value;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}
const ddlFetched = ref(false);

function ddlRequest() {
  return {
    connectionId: props.connectionId,
    database: props.database,
    schema: metadataSchema.value,
    tableName: props.tableName,
    catalog: props.catalog,
  };
}

async function fetchDdl(force = false) {
  if (!props.connectionId || !props.database || !props.tableName || (!force && ddlFetched.value) || !tableMetadataCapabilities.value.ddl) return;
  ddlLoading.value = true;
  try {
    const { ddl } = await loadObjectDdl(ddlRequest(), { force });
    ddlContent.value = await formatSqlForDisplay(ddl, sqlFormatDialectForDbType(databaseType.value), settingsStore.editorSettings.sqlFormatter);
    ddlFetched.value = true;
  } catch (e: any) {
    ddlContent.value = `-- Error: ${e?.message || e}`;
    ddlFetched.value = true;
  } finally {
    ddlLoading.value = false;
  }
}
const errorMessage = ref("");
const columns = ref<EditableStructureColumn[]>([]);
const indexes = ref<EditableStructureIndex[]>([]);
const pendingStatements = ref<string[]>([]);
const warnings = ref<string[]>([]);
const foreignKeys = ref<EditableStructureForeignKey[]>([]);
const triggers = ref<EditableStructureTrigger[]>([]);
const triggersLoaded = ref(false);
const checks = ref<EditableTableCheckConstraint[]>([]);
const checksLoaded = ref(false);
const openGaussOptions = ref<EditableOpenGaussTableOptions>(createDefaultOpenGaussTableOptions());
const originalOpenGaussOptions = ref<OpenGaussTableOptionsSnapshot | undefined>(undefined);
const openGaussOptionsLoaded = ref(false);
const openGaussPartitions = ref<EditableOpenGaussPartitionDraft>(createDefaultOpenGaussPartitionDraft());
const originalOpenGaussPartitions = ref<OpenGaussTablePartitionMetadata | null>(null);
const openGaussPartitionsLoaded = ref(false);
const secondaryMetadataLoading = computed(() => indexesLoading.value || foreignKeysLoading.value || triggersLoading.value || checksLoading.value || openGaussOptionsLoading.value || openGaussPartitionsLoading.value);

function sameList(left: string[] | null | undefined, right: string[] | null | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameText(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? "") === (right ?? "");
}

function columnChanged(column: EditableStructureColumn, index: number): boolean {
  if (!column.original || column.markedForDrop) return true;
  const original = column.original;
  return (
    isPhysicalTableColumnOrderChange(databaseType.value, connection.value?.db_type, column.originalPosition, index) ||
    column.name !== original.name ||
    column.dataType !== original.data_type ||
    column.isNullable !== original.is_nullable ||
    !sameText(column.defaultValue, original.column_default) ||
    !sameText(column.comment, original.comment) ||
    column.isPrimaryKey !== original.is_primary_key ||
    !sameText(column.characterSet, original.character_set) ||
    !sameText(column.collation, original.collation) ||
    JSON.stringify(column.extra) !== JSON.stringify(parseExtraToColumnExtra(original.extra, databaseType.value))
  );
}

function indexChanged(index: EditableStructureIndex): boolean {
  if (!index.original || index.markedForDrop) return true;
  const original = index.original;
  return (
    index.name !== original.name ||
    !sameList(index.columns, original.columns) ||
    index.isUnique !== original.is_unique ||
    !sameText(index.filter, original.filter) ||
    !sameStructureIndexType(index.indexType, original.index_type) ||
    !sameList(index.includedColumns, original.included_columns) ||
    !sameText(index.comment, original.comment)
  );
}

function foreignKeyChanged(foreignKey: EditableStructureForeignKey): boolean {
  if (!foreignKey.original || foreignKey.markedForDrop) return true;
  const original = foreignKey.original;
  return (
    foreignKey.name !== original.name ||
    foreignKey.column !== original.column ||
    !sameText(foreignKey.refSchema, original.ref_schema) ||
    foreignKey.refTable !== original.ref_table ||
    foreignKey.refColumn !== original.ref_column ||
    !sameText(foreignKey.onUpdate, original.on_update) ||
    !sameText(foreignKey.onDelete, original.on_delete)
  );
}

function triggerChanged(trigger: EditableStructureTrigger): boolean {
  if (!trigger.original || trigger.markedForDrop) return true;
  const original = trigger.original;
  return trigger.name !== original.name || trigger.timing !== original.timing || trigger.event !== original.event || !sameText(trigger.statement, original.statement);
}

function captureStructureRefreshScope(): TableStructureRefreshScope {
  return {
    columns: columns.value.some(columnChanged),
    indexes: indexes.value.some(indexChanged),
    foreignKeys: foreignKeys.value.some(foreignKeyChanged),
    triggers: triggers.value.some(triggerChanged),
    tableComment: tableComment.value !== originalTableComment.value,
  };
}

function isPlainModShortcut(event: KeyboardEvent, key: string): boolean {
  if (event.isComposing || event.altKey || event.shiftKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return event.key.toLowerCase() === key;
}

const structureDensityValues: StructureEditorDensity[] = ["compact", "standard", "comfortable"];
const STRUCTURE_COLUMNS_WIDTHS_STORAGE_KEY = "ogdeveloper-structure-editor-column-widths";
const STRUCTURE_INDEX_COLUMNS_WIDTHS_STORAGE_KEY = "ogdeveloper-structure-editor-index-column-widths";
const STRUCTURE_SQL_PREVIEW_COLLAPSED_STORAGE_KEY = "ogdeveloper-structure-editor-sql-preview-collapsed";
const STRUCTURE_COLUMN_WIDTH_COUNT = 12;
const STRUCTURE_INDEX_COLUMN_WIDTH_COUNT = 8;
const PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS = new Set([0, 1, 6]);
const structureDensityMetrics: Record<
  StructureEditorDensity,
  {
    columns: number[];
    indexes: number[];
    minColumnWidth: number;
    minLengthColumnWidth: number;
    minIndexColumnWidth: number;
    actionButtonWidth: number;
    fontSize: number;
    shellPadding: number;
    cellPaddingX: number;
    cellPaddingY: number;
    headerPaddingY: number;
    controlHeight: number;
    controlPaddingX: number;
    iconSize: number;
    checkboxSize: number;
    lineHeight: number;
  }
> = {
  compact: {
    columns: [28, 168, 136, 82, 60, 52, 108, 220, 80, 120, 144, 108],
    indexes: [120, 180, 60, 88, 124, 144, 120, 70],
    minColumnWidth: 24,
    minLengthColumnWidth: 140,
    minIndexColumnWidth: 48,
    actionButtonWidth: 24,
    fontSize: 11,
    shellPadding: 10,
    cellPaddingX: 6,
    cellPaddingY: 4,
    headerPaddingY: 5,
    controlHeight: 24,
    controlPaddingX: 8,
    iconSize: 14,
    checkboxSize: 13,
    lineHeight: 1.35,
  },
  standard: {
    columns: [32, 200, 160, 104, 72, 64, 128, 260, 90, 140, 160, 136],
    indexes: [148, 224, 72, 108, 148, 180, 148, 84],
    minColumnWidth: 28,
    minLengthColumnWidth: 156,
    minIndexColumnWidth: 60,
    actionButtonWidth: 28,
    fontSize: 12,
    shellPadding: 12,
    cellPaddingX: 8,
    cellPaddingY: 5,
    headerPaddingY: 7,
    controlHeight: 28,
    controlPaddingX: 10,
    iconSize: 15,
    checkboxSize: 14,
    lineHeight: 1.4,
  },
  comfortable: {
    columns: [36, 232, 188, 116, 84, 76, 152, 300, 100, 160, 188, 148],
    indexes: [176, 260, 84, 124, 176, 216, 176, 104],
    minColumnWidth: 32,
    minLengthColumnWidth: 176,
    minIndexColumnWidth: 64,
    actionButtonWidth: 32,
    fontSize: 13,
    shellPadding: 16,
    cellPaddingX: 10,
    cellPaddingY: 7,
    headerPaddingY: 9,
    controlHeight: 32,
    controlPaddingX: 12,
    iconSize: 16,
    checkboxSize: 16,
    lineHeight: 1.5,
  },
};

function isStructureEditorDensity(value: unknown): value is StructureEditorDensity {
  return structureDensityValues.includes(value as StructureEditorDensity);
}

function metricsForDensity(density: StructureEditorDensity) {
  return structureDensityMetrics[density];
}

function normalizeStructureColumnWidths(value: unknown, density: StructureEditorDensity): number[] | null {
  if (!Array.isArray(value)) return null;
  let widths = value.map((item) => Number(item));
  if (widths.some((item) => !Number.isFinite(item))) return null;
  // Backward compatibility: pad old 11-column persisted layout to 12 by inserting
  // a default collation width at index 9.
  if (widths.length === STRUCTURE_COLUMN_WIDTH_COUNT - 1) {
    const defaultWidths = metricsForDensity(density).columns;
    widths = [...widths.slice(0, 9), defaultWidths[9], ...widths.slice(9)];
  }
  if (widths.length !== STRUCTURE_COLUMN_WIDTH_COUNT) return null;
  const minWidth = metricsForDensity(density).minColumnWidth;
  return widths.map((item) => Math.max(minWidth, item));
}

function normalizeStructureIndexColumnWidths(value: unknown, density: StructureEditorDensity): number[] | null {
  if (!Array.isArray(value) || value.length !== STRUCTURE_INDEX_COLUMN_WIDTH_COUNT) return null;
  const minWidth = metricsForDensity(density).minIndexColumnWidth;
  const widths = value.map((item) => Number(item));
  if (widths.some((item) => !Number.isFinite(item))) return null;
  return widths.map((item) => Math.max(minWidth, item));
}

function loadStructureWidthsByDensity(storageKey: string, density: StructureEditorDensity): unknown {
  const raw = safeLocalStorageGet(storageKey);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<StructureEditorDensity, unknown>>;
    return parsed?.[density];
  } catch {
    return undefined;
  }
}

function loadStructureColumnWidths(density: StructureEditorDensity): number[] {
  const fallback = [...metricsForDensity(density).columns];
  const stored = loadStructureWidthsByDensity(STRUCTURE_COLUMNS_WIDTHS_STORAGE_KEY, density);
  return normalizeStructureColumnWidths(stored, density) ?? fallback;
}

function loadStructureIndexColumnWidths(density: StructureEditorDensity): number[] {
  const fallback = [...metricsForDensity(density).indexes];
  const stored = normalizeStructureIndexColumnWidths(loadStructureWidthsByDensity(STRUCTURE_INDEX_COLUMNS_WIDTHS_STORAGE_KEY, density), density);
  if (!stored) return fallback;
  return fallback.map((width, index) => (PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS.has(index) ? stored[index] : width));
}

function saveStructureWidthsByDensity(storageKey: string, density: StructureEditorDensity, widths: readonly number[]) {
  let payload: Partial<Record<StructureEditorDensity, number[]>> = {};
  const raw = safeLocalStorageGet(storageKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") payload = parsed;
    } catch {
      payload = {};
    }
  }
  payload[density] = [...widths];
  safeLocalStorageSet(storageKey, JSON.stringify(payload));
}

function saveStructureColumnWidths(density: StructureEditorDensity, widths: readonly number[]) {
  const normalized = normalizeStructureColumnWidths([...widths], density);
  if (!normalized) return;
  saveStructureWidthsByDensity(STRUCTURE_COLUMNS_WIDTHS_STORAGE_KEY, density, normalized);
}

function saveStructureIndexColumnWidths(density: StructureEditorDensity, widths: readonly number[]) {
  const normalized = normalizeStructureIndexColumnWidths([...widths], density);
  if (!normalized) return;
  const fallback = metricsForDensity(density).indexes;
  const stored = fallback.map((width, index) => (PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS.has(index) ? normalized[index] : width));
  saveStructureWidthsByDensity(STRUCTURE_INDEX_COLUMNS_WIDTHS_STORAGE_KEY, density, stored);
}

function loadSqlPreviewCollapsed(): boolean {
  return safeLocalStorageGet(STRUCTURE_SQL_PREVIEW_COLLAPSED_STORAGE_KEY) === "true";
}

const structureDensity = computed(() => settingsStore.editorSettings.structureEditorDensity);
const localStructureDensity = ref<StructureEditorDensity>(structureDensity.value);
const structureDensityMetric = computed(() => metricsForDensity(localStructureDensity.value));
const structureDensityOptions = computed(() => [
  { value: "compact", label: t("structureEditor.densityCompact") },
  { value: "standard", label: t("structureEditor.densityStandard") },
  { value: "comfortable", label: t("structureEditor.densityComfortable") },
]);
const structureDensityStyle = computed(() => {
  const metric = structureDensityMetric.value;
  return {
    "--structure-font-size": `${metric.fontSize}px`,
    "--structure-shell-padding": `${metric.shellPadding}px`,
    "--structure-cell-px": `${metric.cellPaddingX}px`,
    "--structure-cell-py": `${metric.cellPaddingY}px`,
    "--structure-header-py": `${metric.headerPaddingY}px`,
    "--structure-control-height": `${metric.controlHeight}px`,
    "--structure-control-px": `${metric.controlPaddingX}px`,
    "--structure-icon-size": `${metric.iconSize}px`,
    "--structure-checkbox-size": `${metric.checkboxSize}px`,
    "--structure-line-height": String(metric.lineHeight),
  };
});
const structureControlClass = "h-[var(--structure-control-height)] min-w-0 rounded-[6px] px-[var(--structure-control-px)] py-0 text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25";
const structureMonoControlClass = `${structureControlClass} font-mono`;
const structureToolbarButtonClass = "h-[var(--structure-control-height)] gap-1 px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]";
const structureIconButtonClass = "h-[var(--structure-control-height)] w-[var(--structure-control-height)]";
const structureIconClass = "h-[var(--structure-icon-size)] w-[var(--structure-icon-size)]";
const structureCheckboxClass = "h-[var(--structure-checkbox-size)] w-[var(--structure-checkbox-size)]";
const structureHeaderCellClass = "relative min-w-0 overflow-hidden border-b border-r px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-left";
const structureCellClass = "min-w-0 overflow-hidden border-b border-r px-[var(--structure-cell-px)] py-[var(--structure-cell-py)]";
const structureLastCellClass = "min-w-0 overflow-hidden border-b px-[var(--structure-cell-px)] py-[var(--structure-cell-py)]";
const structurePropertyListClass = "flex min-w-0 items-center gap-0 overflow-hidden";
const structureActionButtonClass = `${structureIconButtonClass} shrink-0`;
const structureDensityMenuOpen = ref(false);
const structureDensityMenuRef = ref<HTMLElement>();

function applyStructureDensityWidths(density: StructureEditorDensity) {
  colWidths.value = loadStructureColumnWidths(density);
  indexColWidths.value = loadStructureIndexColumnWidths(density);
}

function setStructureDensity(value: unknown) {
  if (!isStructureEditorDensity(value)) return;
  if (value === localStructureDensity.value) return;
  localStructureDensity.value = value;
}

function selectStructureDensity(value: unknown) {
  setStructureDensity(value);
  structureDensityMenuOpen.value = false;
}

function toggleStructureDensityMenu() {
  structureDensityMenuOpen.value = !structureDensityMenuOpen.value;
}

function focusStructureDensityOption(offset: number) {
  const currentIndex = structureDensityValues.indexOf(localStructureDensity.value);
  const nextIndex = (currentIndex + offset + structureDensityValues.length) % structureDensityValues.length;
  selectStructureDensity(structureDensityValues[nextIndex]);
}

function onStructureDensityKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    structureDensityMenuOpen.value = false;
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!structureDensityMenuOpen.value) {
      structureDensityMenuOpen.value = true;
      return;
    }
    focusStructureDensityOption(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!structureDensityMenuOpen.value) {
      structureDensityMenuOpen.value = true;
      return;
    }
    focusStructureDensityOption(-1);
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    structureDensityMenuOpen.value = !structureDensityMenuOpen.value;
  }
}

function onStructureDensityDocumentPointerdown(event: PointerEvent) {
  if (!structureDensityMenuOpen.value) return;
  const target = event.target;
  if (target instanceof Node && structureDensityMenuRef.value?.contains(target)) return;
  structureDensityMenuOpen.value = false;
}

function persistStructureDensity(density = localStructureDensity.value) {
  if (settingsStore.editorSettings.structureEditorDensity === density) return;
  settingsStore.updateEditorSettings({ structureEditorDensity: density });
}

const colWidths = ref(loadStructureColumnWidths(structureDensity.value));
const colResizing = ref<{ col: number; startX: number; startW: number } | null>(null);
const indexColWidths = ref(loadStructureIndexColumnWidths(structureDensity.value));
const resizing = ref<{ col: number; startX: number; startW: number } | null>(null);
const columnSearchInputRef = ref<InstanceType<typeof Input>>();
const columnSearchText = ref("");
const selectedColumnId = ref<string | null>(null);
const highlightedColumnId = ref<string | null>(null);
const indexSearchInputRef = ref<InstanceType<typeof Input>>();
const indexSearchText = ref("");
const highlightedIndexId = ref<string | null>(null);
const sqlPreviewCollapsed = ref(loadSqlPreviewCollapsed());
let columnHighlightTimer: ReturnType<typeof window.setTimeout> | undefined;
let indexHighlightTimer: ReturnType<typeof window.setTimeout> | undefined;

watch(
  structureDensity,
  (density) => {
    if (density === localStructureDensity.value) return;
    localStructureDensity.value = density;
  },
  { flush: "sync" },
);

watch(localStructureDensity, (density, previousDensity) => {
  if (density === previousDensity) return;
  applyStructureDensityWidths(density);
  persistStructureDensity(density);
});

function onColResize(e: MouseEvent, col: number) {
  e.preventDefault();
  const widthIndex = columnWidthIndex(col);
  const minimumWidth = structureDensityMetric.value.minColumnWidth;
  colResizing.value = { col: widthIndex, startX: e.clientX, startW: Math.max(colWidths.value[widthIndex] ?? minimumWidth, minimumWidth) };
  const onMove = (ev: MouseEvent) => {
    if (!colResizing.value) return;
    const delta = ev.clientX - colResizing.value.startX;
    colWidths.value[widthIndex] = Math.max(minimumWidth, colResizing.value.startW + delta);
  };
  const onUp = () => {
    colResizing.value = null;
    saveStructureColumnWidths(localStructureDensity.value, colWidths.value);
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onIndexColResize(e: MouseEvent, col: number) {
  e.preventDefault();
  resizing.value = { col, startX: e.clientX, startW: indexColWidths.value[col] };
  const onMove = (ev: MouseEvent) => {
    if (!resizing.value) return;
    const delta = ev.clientX - resizing.value.startX;
    indexColWidths.value[col] = Math.max(structureDensityMetric.value.minIndexColumnWidth, resizing.value.startW + delta);
  };
  const onUp = () => {
    resizing.value = null;
    if (PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS.has(col)) {
      saveStructureIndexColumnWidths(localStructureDensity.value, indexColWidths.value);
    }
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

const connection = computed(() => (props.connectionId ? store.getConfig(props.connectionId) : undefined));
const databaseType = computed(() => tableStructureDatabaseTypeForConnection(connection.value));
const isOpenGaussStructure = computed(() => databaseType.value === "opengauss" || connection.value?.db_type === "opengauss");
const effectiveMetadataDbType = computed(() => (isOpenGaussStructure.value ? "opengauss" : databaseType.value));
const structureCapabilities = computed(() => getTableStructureCapabilities(databaseType.value, connection.value?.db_type, connection.value?.database_info?.productVersion));
const tableMetadataCapabilities = computed(() => getTableMetadataCapabilities(effectiveMetadataDbType.value));
const structureDialect = computed(() => structureCapabilities.value.dialect);
const isTableCommentDisabled = computed(() => !structureCapabilities.value.comment);
const dynamicDataTypeOptions = ref<string[]>([]);
const dataTypeOptions = computed(() => mergeDataTypeOptions(dynamicDataTypeOptions.value, getDataTypeOptions(databaseType.value)));
const columnEditorControls = computed(() => getColumnEditorControls(databaseType.value));

const indexTypesByDb: Record<string, string[]> = {
  postgres: ["BTREE", "HASH", "GIST", "SPGIST", "GIN", "BRIN"],
};
const indexTypeOptions = computed(() => (structureCapabilities.value.indexType ? (indexTypesByDb[structureDialect.value] ?? []) : []));

interface DefaultValuePreset {
  label: string;
  value: string;
}

const defaultValuePresets = computed((): DefaultValuePreset[] => {
  const universal: DefaultValuePreset[] = [
    { label: "''", value: "''" },
    { label: "NULL", value: "NULL" },
    { label: "0", value: "0" },
    { label: "1", value: "1" },
  ];

  const dialectPresets: Record<string, DefaultValuePreset[]> = {
    postgres: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE" },
      { label: "now()", value: "now()" },
      { label: "gen_random_uuid()", value: "gen_random_uuid()" },
    ],
  };

  return [...universal, ...(dialectPresets[structureDialect.value] ?? [])];
});

const showExtendedProperties = computed(() => structureDialect.value === "postgres");

const extendedPropertiesColumnIndex = 10;
const actionButtonGap = 2;
const columnActionButtonCount = computed(() => (canShowColumnDragControls.value ? 2 : 1));
const columnActionsWidth = computed(() => {
  const metric = structureDensityMetric.value;
  const count = columnActionButtonCount.value;
  return metric.actionButtonWidth * count + actionButtonGap * Math.max(0, count - 1) + metric.cellPaddingX * 2;
});
const visibleColumnIndexes = computed(() => colLabels.value.map((column) => column.widthIndex));
const visibleColWidths = computed(() =>
  colLabels.value.map((column) => {
    if (column.key === "actions") return columnActionsWidth.value;
    const width = colWidths.value[column.widthIndex] ?? structureDensityMetric.value.minColumnWidth;
    return width;
  }),
);

function columnWidthIndex(visibleIndex: number) {
  return visibleColumnIndexes.value[visibleIndex] ?? visibleIndex;
}

const colLabels = computed(() => {
  const labels = [
    { key: "ordinal", label: "#", widthIndex: 0 },
    { key: "name", label: t("structureEditor.columnName"), widthIndex: 1 },
    { key: "type", label: t("structureEditor.dataType"), widthIndex: 2 },
  ];
  if (columnEditorControls.value.length) labels.push({ key: "length", label: t("structureEditor.length"), widthIndex: 3 });
  if (columnEditorControls.value.nullable) labels.push({ key: "nullable", label: t("structureEditor.nullable"), widthIndex: 4 });
  if (columnEditorControls.value.primaryKey) labels.push({ key: "primaryKey", label: t("structureEditor.primaryKey"), widthIndex: 5 });
  if (columnEditorControls.value.defaultValue) labels.push({ key: "defaultValue", label: t("structureEditor.defaultValue"), widthIndex: 6 });
  if (columnEditorControls.value.comment) labels.push({ key: "comment", label: t("structureEditor.comment"), widthIndex: 7 });
  if (showExtendedProperties.value) {
    labels.push({ key: "extendedProperties", label: t("structureEditor.extendedProperties"), widthIndex: extendedPropertiesColumnIndex });
  }
  labels.push({ key: "actions", label: t("structureEditor.actions"), widthIndex: 11 });
  return labels;
});
const indexColLabels = computed(() => [t("structureEditor.indexName"), t("structureEditor.indexColumns"), t("structureEditor.unique"), t("structureEditor.indexType"), t("structureEditor.includedColumns"), t("structureEditor.filter"), t("structureEditor.comment"), t("structureEditor.actions")]);
const filteredColumnRowIds = computed(() => {
  const query = columnSearchText.value.trim().toLowerCase();
  if (!query) return new Set<string>();
  return new Set(
    columns.value
      .filter((column) =>
        [column.name, column.comment].some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(query),
        ),
      )
      .map((column) => column.id),
  );
});
const columnSearchMatchCount = computed(() => (columnSearchText.value.trim() ? filteredColumnRowIds.value.size : 0));
const filteredIndexRowIds = computed(() => {
  const query = indexSearchText.value.trim().toLowerCase();
  if (!query) return new Set<string>();
  return new Set(indexes.value.filter((index) => indexMatchesSearch(index, query)).map((index) => index.id));
});
const indexSearchMatchCount = computed(() => (indexSearchText.value.trim() ? filteredIndexRowIds.value.size : 0));
const foreignKeyActionOptions = ["", "CASCADE", "SET NULL", "RESTRICT", "NO ACTION"];
const triggerTimingOptions = ["BEFORE", "AFTER"];
const triggerEventOptions = ["INSERT", "UPDATE", "DELETE"];
const metadataSchema = computed(() => connectionObjectTreeQuerySchema(connection.value, props.database, props.schema));
const refreshVersion = computed(() => (props.connectionId && props.tableName ? queryStore.tableStructureRefreshVersion(props.connectionId, props.database, props.schema, props.tableName) : 0));
const isCreateMode = computed(() => !props.tableName);
const canAddColumn = computed(() => canAddTableStructureColumn(databaseType.value, isCreateMode.value));
const newTableName = ref("");
const tableComment = ref("");
const originalTableComment = ref("");
const targetLabel = computed(() => buildStructureTargetLabel(connection.value?.name, props.database, props.schema, isCreateMode.value ? undefined : props.tableName));

let sqlPreviewRequestId = 0;
let structureLoadRequestId = 0;
let dataTypeOptionsRequestId = 0;
let sqlPreviewDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let deferredSqlPreviewRefresh = false;
let keydownListenerRegistered = false;
let skipNextRefreshVersion = false;
let restoringDraft = false;
let syncingDraft = false;
let draftHydrated = false;
let hydratingRestoredDraft = false;
let structureScrollFrame = 0;
// A context-menu target may arrive before metadata rows render, so search text
// and row scrolling are tracked separately for each request.
let appliedInitialTargetSearchKey = "";
let appliedInitialTargetScrollKey = "";

function cloneDraftValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const structureScrollPositions = ref<Partial<Record<TableInfoTab, TableStructureEditorViewport>>>({});

function structureScrollerElement(scroller: StructureScrollerRef | undefined): HTMLElement | undefined {
  if (!scroller) return undefined;
  if (scroller instanceof HTMLElement) return scroller;
  return scroller.$el instanceof HTMLElement ? scroller.$el : undefined;
}

function structureScrollerForTab(tab: TableInfoTab): HTMLElement | undefined {
  if (tab === "columns") return structureScrollerElement(columnsScrollerRef.value);
  if (tab === "indexes") return structureScrollerElement(indexesScrollerRef.value);
  if (tab === "foreignKeys") return structureScrollerElement(foreignKeysScrollerRef.value);
  if (tab === "triggers") return structureScrollerElement(triggersScrollerRef.value);
  if (tab === "checks") return structureScrollerElement(checksScrollerRef.value);
  if (tab === "partitions") return structureScrollerElement(partitionsScrollerRef.value);
  if (tab === "options") return structureScrollerElement(optionsScrollerRef.value);
  if (tab === "ddl") return structureScrollerElement(ddlScrollerRef.value);
  return undefined;
}

function restoreStructureScrollPosition(tab = activeTab.value) {
  const position = structureScrollPositions.value[tab];
  if (!position) return;
  nextTick(() => {
    const scroller = structureScrollerForTab(tab);
    if (!scroller) return;
    scroller.scrollTop = Math.max(0, position.scrollTop);
    scroller.scrollLeft = Math.max(0, position.scrollLeft);
  });
}

function onStructureContentScroll(tab: TableInfoTab, event: Event) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const position: TableStructureEditorViewport = {
    scrollTop: Math.max(0, Math.round(target.scrollTop)),
    scrollLeft: Math.max(0, Math.round(target.scrollLeft)),
  };
  const previous = structureScrollPositions.value[tab];
  if (previous?.scrollTop === position.scrollTop && previous.scrollLeft === position.scrollLeft) return;
  structureScrollPositions.value = {
    ...structureScrollPositions.value,
    [tab]: position,
  };
  if (structureScrollFrame) return;
  structureScrollFrame = window.requestAnimationFrame(() => {
    structureScrollFrame = 0;
    syncDraftToParent();
  });
}

function createCurrentDraft(initialized = true): TableStructureEditorDraft {
  return {
    dirty: hasPendingStructureChanges(),
    activeTab: activeTab.value as TableStructureEditorDraft["activeTab"],
    newTableName: newTableName.value,
    tableComment: tableComment.value,
    originalTableComment: originalTableComment.value,
    columns: cloneDraftValue(columns.value),
    indexes: cloneDraftValue(indexes.value),
    foreignKeys: cloneDraftValue(foreignKeys.value),
    triggers: cloneDraftValue(triggers.value),
    checks: cloneDraftValue(checks.value),
    checksLoaded: checksLoaded.value,
    openGaussOptions: cloneDraftValue(openGaussOptions.value),
    originalOpenGaussOptions: originalOpenGaussOptions.value ? cloneDraftValue(originalOpenGaussOptions.value) : undefined,
    openGaussOptionsLoaded: openGaussOptionsLoaded.value,
    openGaussPartitions: cloneDraftValue(openGaussPartitions.value),
    originalOpenGaussPartitions: originalOpenGaussPartitions.value ? cloneDraftValue(originalOpenGaussPartitions.value) : null,
    openGaussPartitionsLoaded: openGaussPartitionsLoaded.value,
    triggersLoaded: triggersLoaded.value,
    loadedMetadataFacets: [...loadedMetadataFacets],
    scrollPositions: cloneDraftValue(structureScrollPositions.value),
    initialized,
  };
}

function syncDraftToParent() {
  if (!draftHydrated) return;
  if (restoringDraft || syncingDraft) return;
  syncingDraft = true;
  emit("update:draft", createCurrentDraft());
  syncingDraft = false;
}

function baseStructureRefreshTab(tab: TableInfoTab | undefined): "columns" | "indexes" | "foreignKeys" | "triggers" | "ddl" {
  if (!tab || tab === "checks" || tab === "partitions" || tab === "options") {
    return "columns";
  }
  return tab;
}

function restoreDraft(draft: TableStructureEditorDraft) {
  restoringDraft = true;
  draftHydrated = false;
  activeTab.value = draft.activeTab || "columns";
  newTableName.value = draft.newTableName || "";
  tableComment.value = draft.tableComment || "";
  originalTableComment.value = draft.originalTableComment || "";
  columns.value = cloneDraftValue(draft.columns || []);
  indexes.value = cloneDraftValue(draft.indexes || []);
  foreignKeys.value = cloneDraftValue(draft.foreignKeys || []);
  triggers.value = cloneDraftValue(draft.triggers || []);
  checks.value = cloneDraftValue(draft.checks || []);
  checksLoaded.value = draft.checksLoaded ?? false;
  openGaussOptions.value = draft.openGaussOptions ? cloneDraftValue(draft.openGaussOptions) : createDefaultOpenGaussTableOptions();
  originalOpenGaussOptions.value = draft.originalOpenGaussOptions ? cloneDraftValue(draft.originalOpenGaussOptions) : undefined;
  openGaussOptionsLoaded.value = draft.openGaussOptionsLoaded ?? false;
  openGaussPartitions.value = draft.openGaussPartitions ? cloneDraftValue(draft.openGaussPartitions) : createDefaultOpenGaussPartitionDraft();
  originalOpenGaussPartitions.value = draft.originalOpenGaussPartitions ? cloneDraftValue(draft.originalOpenGaussPartitions) : null;
  openGaussPartitionsLoaded.value = draft.openGaussPartitionsLoaded ?? false;
  // Drafts created before lazy trigger loading always contained live trigger metadata.
  triggersLoaded.value = draft.triggersLoaded ?? true;
  loadedMetadataFacets.clear();
  if (draft.loadedMetadataFacets) {
    for (const facet of draft.loadedMetadataFacets) loadedMetadataFacets.add(facet);
  } else {
    const activeScope = visibleTableStructureRefreshScope(baseStructureRefreshTab(draft.activeTab));
    if (activeScope.columns) loadedMetadataFacets.add("columns");
    if (activeScope.indexes || draft.indexes?.length) loadedMetadataFacets.add("indexes");
    if (activeScope.foreignKeys || draft.foreignKeys?.length) loadedMetadataFacets.add("foreign-keys");
    if (activeScope.triggers || triggersLoaded.value) loadedMetadataFacets.add("triggers");
    if (activeScope.tableComment) loadedMetadataFacets.add("comment");
  }
  structureScrollPositions.value = cloneDraftValue(draft.scrollPositions || {});
  restoringDraft = false;
  draftHydrated = !needsColumnDraftMetadataHydration();
  restoreStructureScrollPosition();
}

function needsColumnDraftMetadataHydration() {
  return !isCreateMode.value && columns.value.some((column) => !column.original && !column.id.startsWith("new:") && !!column.name.trim());
}

async function hydrateRestoredDraftFromDatabase() {
  if (!needsColumnDraftMetadataHydration() || hydratingRestoredDraft) return;
  const connectionId = props.connectionId;
  const database = props.database;
  const catalog = props.catalog;
  const schema = metadataSchema.value;
  const tableName = props.tableName;
  if (!connectionId || !database || !tableName) return;

  hydratingRestoredDraft = true;
  let shouldRefreshPreview = false;
  try {
    await store.ensureConnected(connectionId);
    const { value: nextColumns } = await loadObjectMetadataFacet({ connectionId, database, schema, tableName, catalog }, "columns", () => api.getColumns(connectionId, database, schema, tableName, catalog));
    columns.value = rehydrateColumnDraftsFromMetadata(columns.value, nextColumns, databaseType.value);
    markDraftHydratedAndSync();
    shouldRefreshPreview = true;
  } catch (e: any) {
    console.warn("[ogdeveloper][structure-editor:draft-hydration-failed]", e);
  } finally {
    hydratingRestoredDraft = false;
    if (shouldRefreshPreview) scheduleSqlPreviewRefresh();
  }
}

function markDraftHydratedAndSync() {
  draftHydrated = true;
  syncDraftToParent();
}

function hasPendingCheckChanges(): boolean {
  if (!tableMetadataCapabilities.value.checks) return false;
  if (isCreateMode.value) return checks.value.length > 0;
  return checks.value.some(checkConstraintChanged);
}

function hasPendingOpenGaussOptionsChanges(): boolean {
  if (!tableMetadataCapabilities.value.options) return false;
  if (isCreateMode.value) return hasCreateModeOpenGaussOptionsChanges(openGaussOptions.value);
  return openGaussOptionsChanged(openGaussOptions.value, originalOpenGaussOptions.value, Boolean(originalOpenGaussPartitions.value));
}

function hasPendingOpenGaussPartitionChanges(): boolean {
  if (!tableMetadataCapabilities.value.partitions) return false;
  if (isCreateMode.value) return hasCreateModeOpenGaussPartitionChanges(openGaussPartitions.value);
  return openGaussPartitions.value.pendingOps.length > 0;
}

function hasPendingStructureChanges(): boolean {
  if (isCreateMode.value) {
    return !!newTableName.value.trim() || !!tableComment.value.trim() || columns.value.length > 0 || indexes.value.length > 0 || foreignKeys.value.length > 0 || triggers.value.length > 0 || hasPendingCheckChanges() || hasPendingOpenGaussOptionsChanges() || hasPendingOpenGaussPartitionChanges();
  }
  const scope = captureStructureRefreshScope();
  return scope.columns || scope.indexes || scope.foreignKeys || scope.triggers || scope.tableComment || hasPendingCheckChanges() || hasPendingOpenGaussOptionsChanges() || hasPendingOpenGaussPartitionChanges();
}

function clearSqlPreviewState() {
  if (sqlPreviewDebounceTimer) {
    clearTimeout(sqlPreviewDebounceTimer);
    sqlPreviewDebounceTimer = undefined;
  }
  sqlPreviewRequestId++;
  deferredSqlPreviewRefresh = false;
  sqlPreviewLoading.value = false;
  pendingStatements.value = [];
  warnings.value = [];
}

function dataTypeOptionsCacheKey(connectionId: string, database: string) {
  return `${connectionId}\u0000${database}`;
}

function mergeDataTypeOptions(primary: readonly string[], fallback: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const option of [...primary, ...fallback]) {
    const trimmed = option.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function postgresDataTypeTooltip(option: string): string | undefined {
  if (databaseType.value !== "postgres" && databaseType.value !== "opengauss") return undefined;
  const help = getPostgresDataTypeHelp(option);
  return help ? t(`structureEditor.postgresDataTypeHelp.${help.key}`) : undefined;
}

function dataTypeTooltip(option: string): string | undefined {
  return databaseType.value === "postgres" || databaseType.value === "opengauss" ? postgresDataTypeTooltip(option) : undefined;
}

async function loadDynamicDataTypeOptions() {
  const requestId = ++dataTypeOptionsRequestId;
  const connectionId = props.connectionId;
  const database = props.database;
  if (!connectionId || !database) {
    dynamicDataTypeOptions.value = [];
    return;
  }
  const cacheKey = dataTypeOptionsCacheKey(connectionId, database);
  const cached = dynamicDataTypeOptionsCache.get(cacheKey);
  if (cached) {
    dynamicDataTypeOptions.value = cached;
    return;
  }
  dynamicDataTypeOptions.value = [];
  try {
    await store.ensureConnected(connectionId);
    const options = await api.listDataTypes(connectionId, database);
    if (requestId !== dataTypeOptionsRequestId) return;
    const normalized = mergeDataTypeOptions(options, []);
    if (normalized.length > 0) {
      dynamicDataTypeOptionsCache.set(cacheKey, normalized);
      dynamicDataTypeOptions.value = normalized;
    } else {
      dynamicDataTypeOptions.value = [];
    }
  } catch {
    if (requestId === dataTypeOptionsRequestId) {
      dynamicDataTypeOptions.value = [];
    }
  }
}

function scheduleSqlPreviewRefresh() {
  if (sqlPreviewDebounceTimer) {
    clearTimeout(sqlPreviewDebounceTimer);
    sqlPreviewDebounceTimer = undefined;
  }
  sqlPreviewRequestId++;
  deferredSqlPreviewRefresh = false;
  pendingStatements.value = [];
  warnings.value = [];
  if (!hasPendingStructureChanges()) {
    sqlPreviewLoading.value = false;
    return;
  }
  sqlPreviewLoading.value = true;
  if (hydratingRestoredDraft || needsColumnDraftMetadataHydration()) return;
  if (!isCreateMode.value && secondaryMetadataLoading.value) {
    deferredSqlPreviewRefresh = true;
    return;
  }
  sqlPreviewDebounceTimer = setTimeout(() => {
    sqlPreviewDebounceTimer = undefined;
    void refreshSqlPreview();
  }, 80);
}

function structureChangeOptions(): BuildTableStructureChangeSqlOptions {
  return {
    databaseType: databaseType.value,
    schema: props.schema,
    tableName: isCreateMode.value ? newTableName.value.trim() : props.tableName || "",
    columns: columns.value,
    indexes: sanitizeStructureIndexesForCapabilities(indexes.value, structureCapabilities.value),
    foreignKeys: foreignKeys.value,
    triggers: triggers.value,
    tableComment: tableComment.value,
    originalTableComment: isCreateMode.value ? undefined : originalTableComment.value,
  };
}

const openGaussValidationMessages = computed<OpenGaussValidationMessages>(() => ({
  checkNameRequired: t("structureEditor.opengauss.warnCheckNameRequired", "CHECK 约束名称不能为空"),
  checkExpressionRequired: t("structureEditor.opengauss.warnCheckExpressionRequired", "CHECK 约束表达式不能为空"),
  duplicateCheckName: (name) => `${t("structureEditor.opengauss.warnDuplicateCheckName", "CHECK 约束名称重复")}: ${name}`,
  columnUstoreIncompatible: t("structureEditor.opengauss.warnColumnUstoreIncompatible", "openGauss 列存表 (orientation = column) 不支持 USTORE 存储引擎，请切换为行存或 ASTORE"),
  columnFillfactorIncompatible: t("structureEditor.opengauss.warnColumnFillfactorIncompatible", "openGauss 列存表 (orientation = column) 不支持设置填充因子 (fillfactor)"),
  invalidFillfactor: t("structureEditor.opengauss.warnInvalidFillfactor", "填充因子 (fillfactor) 必须是 10 到 100 之间的整数"),
  rowCompressionLevelIncompatible: t("structureEditor.opengauss.warnRowCompressionLevelIncompatible", "行存表压缩仅支持 no 或 yes；low / middle / high 压缩级别仅适用于列存表"),
  partitionKeyRequired: t("structureEditor.opengauss.warnPartitionKeyRequired", "启用分区表时必须至少选择一个分区键列"),
  partitionKeyUnknown: (col) => `${t("structureEditor.opengauss.warnPartitionKeyUnknown", "分区键列不存在于当前字段列表中")}: ${col}`,
  columnPartitionStrategyIncompatible: t("structureEditor.opengauss.warnColumnPartitionStrategyIncompatible", "openGauss 列存表仅支持普通 RANGE 分区（不支持 LIST / HASH / INTERVAL 分区）"),
  intervalSingleKeyRequired: t("structureEditor.opengauss.warnIntervalSingleKeyRequired", "openGauss INTERVAL 自动间隔分区仅支持单列分区键"),
  intervalMaxvalueIncompatible: t("structureEditor.opengauss.warnIntervalMaxvalueIncompatible", "openGauss INTERVAL 自动间隔分区不支持 MAXVALUE 分区边界"),
  initialPartitionRequired: t("structureEditor.opengauss.warnInitialPartitionRequired", "启用分区表时必须至少定义一个初始分区"),
  partitionNameRequired: t("structureEditor.opengauss.warnPartitionNameRequired", "分区名称不能为空"),
  partitionBoundaryRequired: (name) => `${t("structureEditor.opengauss.warnPartitionBoundaryRequired", "分区边界值不能为空")}: ${name}`,
  duplicatePartitionName: (name) => `${t("structureEditor.opengauss.warnDuplicatePartitionName", "分区名称已存在或重复")}: ${name}`,
  invalidHashPartitionCount: t("structureEditor.opengauss.warnInvalidHashPartitionCount", "HASH 分区数量必须是大于等于 1 的整数，或手动添加命名分区"),
  addPartitionUnsupportedStrategy: (strategy) => `${t("structureEditor.opengauss.warnAddPartitionUnsupportedStrategy", "openGauss 不支持对该策略分区表手动执行 ADD PARTITION")}: ${strategy.toUpperCase()}`,
  splitPartitionUnsupported: t("structureEditor.opengauss.warnSplitPartitionUnsupported", "openGauss SPLIT PARTITION 仅支持行存 RANGE / INTERVAL 分区表"),
  splitPartitionIncomplete: (name) => `${t("structureEditor.opengauss.warnSplitPartitionIncomplete", "拆分分区需要完整填写拆分点 (AT) 及两个目标分区名称")}: ${name}`,
  splitPartitionSameTargetName: (name) => `${t("structureEditor.opengauss.warnSplitPartitionSameTargetName", "拆分分区的两个目标分区名称不能相同")}: ${name}`,
  renamePartitionRequired: (name) => `${t("structureEditor.opengauss.warnRenamePartitionRequired", "重命名分区的新名称不能为空")}: ${name}`,
  renamePartitionUnchanged: (name) => `${t("structureEditor.opengauss.warnRenamePartitionUnchanged", "分区的新名称不能与原名称相同")}: ${name}`,
  dropLastPartitionForbidden: (name) => `${t("structureEditor.opengauss.warnDropLastPartitionForbidden", "不能删除最后一个分区（openGauss 要求分区表至少保留一个分区）")}: ${name}`,
}));

async function refreshSqlPreview() {
  const requestId = ++sqlPreviewRequestId;
  if (!hasPendingStructureChanges()) {
    pendingStatements.value = [];
    warnings.value = [];
    sqlPreviewLoading.value = false;
    return;
  }
  sqlPreviewLoading.value = true;
  const options = structureChangeOptions();
  try {
    if (isCreateMode.value) {
      const baseResult = await api.buildCreateTableSql(options);
      if (requestId !== sqlPreviewRequestId) return;
      if (tableMetadataCapabilities.value.checks || isOpenGaussStructure.value) {
        const augmented = augmentCreateTableSqlWithOpenGauss({
          baseStatements: baseResult.statements,
          baseWarnings: baseResult.warnings,
          databaseType: effectiveMetadataDbType.value,
          schema: props.schema,
          tableName: options.tableName,
          availableColumns: availableColumnNames.value,
          checks: tableMetadataCapabilities.value.checks ? checks.value : undefined,
          storageOptions: isOpenGaussStructure.value ? openGaussOptions.value : undefined,
          partitionDraft: isOpenGaussStructure.value ? openGaussPartitions.value : undefined,
          messages: openGaussValidationMessages.value,
        });
        pendingStatements.value = augmented.statements;
        warnings.value = augmented.warnings;
      } else {
        pendingStatements.value = baseResult.statements;
        warnings.value = baseResult.warnings;
      }
    } else {
      const baseScope = captureStructureRefreshScope();
      const hasBaseChanges = baseScope.columns || baseScope.indexes || baseScope.foreignKeys || baseScope.triggers || baseScope.tableComment;
      const baseResult = hasBaseChanges ? await api.buildTableStructureChangeSql(options) : { statements: [], warnings: [] };
      if (requestId !== sqlPreviewRequestId) return;
      if (tableMetadataCapabilities.value.checks || isOpenGaussStructure.value) {
        const extraResult = buildOpenGaussAlterTableStatements({
          databaseType: effectiveMetadataDbType.value,
          schema: props.schema,
          tableName: options.tableName,
          checks: tableMetadataCapabilities.value.checks ? checks.value : undefined,
          storageOptions: isOpenGaussStructure.value ? openGaussOptions.value : undefined,
          originalStorageOptions: isOpenGaussStructure.value ? originalOpenGaussOptions.value : undefined,
          partitionMetadata: isOpenGaussStructure.value ? originalOpenGaussPartitions.value : null,
          partitionEditDraft: isOpenGaussStructure.value ? openGaussPartitions.value : undefined,
          messages: openGaussValidationMessages.value,
        });
        pendingStatements.value = [...baseResult.statements, ...extraResult.statements];
        warnings.value = [...baseResult.warnings, ...extraResult.warnings];
      } else {
        pendingStatements.value = baseResult.statements;
        warnings.value = baseResult.warnings;
      }
    }
  } catch (e: any) {
    if (requestId !== sqlPreviewRequestId) return;
    pendingStatements.value = [];
    warnings.value = [e?.message || String(e)];
  } finally {
    if (requestId === sqlPreviewRequestId) sqlPreviewLoading.value = false;
  }
}

const canApply = computed(
  () => !loading.value && !saving.value && !postSaveRefreshing.value && !secondaryMetadataLoading.value && !sqlPreviewLoading.value && pendingStatements.value.length > 0 && warnings.value.length === 0 && !!props.connectionId && (isCreateMode.value ? !!newTableName.value.trim() : !!props.tableName),
);

function clearDraft() {
  draftHydrated = false;
  emit("update:draft", undefined);
}

function resetState() {
  loading.value = false;
  saving.value = false;
  postSaveRefreshing.value = false;
  sqlPreviewLoading.value = false;
  indexesLoading.value = false;
  foreignKeysLoading.value = false;
  triggersLoading.value = false;
  checksLoading.value = false;
  openGaussOptionsLoading.value = false;
  openGaussPartitionsLoading.value = false;
  errorMessage.value = "";
  columns.value = [];
  indexes.value = [];
  pendingStatements.value = [];
  warnings.value = [];
  foreignKeys.value = [];
  triggers.value = [];
  triggersLoaded.value = false;
  checks.value = [];
  checksLoaded.value = false;
  openGaussOptions.value = createDefaultOpenGaussTableOptions();
  originalOpenGaussOptions.value = undefined;
  openGaussOptionsLoaded.value = false;
  openGaussPartitions.value = createDefaultOpenGaussPartitionDraft();
  originalOpenGaussPartitions.value = null;
  openGaussPartitionsLoaded.value = false;
  selectedColumnId.value = null;
  ddlContent.value = "";
  ddlFetched.value = false;
  loadedMetadataFacets.clear();
  newTableName.value = "";
  tableComment.value = "";
  originalTableComment.value = "";
  columnSearchText.value = "";
  highlightedColumnId.value = null;
  indexSearchText.value = "";
  highlightedIndexId.value = null;
  appliedInitialTargetSearchKey = "";
  appliedInitialTargetScrollKey = "";
  localColumnOrderNoticeShown.value = false;
}

async function runStructureMetadataQuery(sql: string) {
  await store.ensureConnected(props.connectionId);
  return api.executeQuery(props.connectionId, props.database, sql, metadataSchema.value);
}

async function loadChecksMetadata(force = false) {
  if (isCreateMode.value || !props.connectionId || !props.database || !props.tableName || !tableMetadataCapabilities.value.checks) return;
  if (!force && (checksLoaded.value || checksLoading.value)) return;
  const targetConn = props.connectionId;
  const targetDb = props.database;
  const targetSchema = metadataSchema.value;
  const targetTable = props.tableName;
  checksLoading.value = true;
  try {
    const items = await fetchTableCheckConstraints(runStructureMetadataQuery, targetSchema, targetTable);
    if (props.connectionId !== targetConn || props.database !== targetDb || metadataSchema.value !== targetSchema || props.tableName !== targetTable) return;
    checks.value = createCheckConstraintDrafts(items, uuid);
    checksLoaded.value = true;
  } catch (e) {
    console.warn("[ogdeveloper][structure-editor:checks-load-failed]", e);
  } finally {
    checksLoading.value = false;
  }
}

async function loadOpenGaussOptionsAndPartitionsMetadata(force = false) {
  if (isCreateMode.value || !props.connectionId || !props.database || !props.tableName || !isOpenGaussStructure.value) return;
  const needOptions = tableMetadataCapabilities.value.options && (force || !openGaussOptionsLoaded.value);
  const needPartitions = tableMetadataCapabilities.value.partitions && (force || !openGaussPartitionsLoaded.value);
  if (!needOptions && !needPartitions) return;

  const targetConn = props.connectionId;
  const targetDb = props.database;
  const targetSchema = metadataSchema.value;
  const targetTable = props.tableName;

  if (needOptions) openGaussOptionsLoading.value = true;
  if (needPartitions) openGaussPartitionsLoading.value = true;
  try {
    const [optsRes, partsRes] = await Promise.all([
      needOptions ? fetchOpenGaussTableOptions(runStructureMetadataQuery, targetSchema, targetTable) : Promise.resolve(undefined),
      needPartitions ? fetchOpenGaussTablePartitions(runStructureMetadataQuery, targetSchema, targetTable) : Promise.resolve(undefined),
    ]);
    if (props.connectionId !== targetConn || props.database !== targetDb || metadataSchema.value !== targetSchema || props.tableName !== targetTable) return;

    if (partsRes !== undefined) {
      originalOpenGaussPartitions.value = partsRes;
      openGaussPartitions.value = {
        ...createDefaultOpenGaussPartitionDraft(),
        enableRowMovement: partsRes?.enableRowMovement ?? false,
        updateGlobalIndex: true,
        pendingOps: [],
      };
      openGaussPartitionsLoaded.value = true;
    }

    if (optsRes !== undefined) {
      const effectiveRowMove = originalOpenGaussPartitions.value ? originalOpenGaussPartitions.value.enableRowMovement || optsRes.enableRowMovement : optsRes.enableRowMovement;
      const snapshot: OpenGaussTableOptionsSnapshot = {
        ...optsRes,
        enableRowMovement: effectiveRowMove,
        isPartitioned: Boolean(originalOpenGaussPartitions.value),
      };
      originalOpenGaussOptions.value = snapshot;
      openGaussOptions.value = {
        orientation: snapshot.orientation,
        storageType: snapshot.storageType,
        compression: snapshot.compression,
        fillfactor: snapshot.fillfactor,
        tablespace: snapshot.tablespace,
        enableRowMovement: snapshot.enableRowMovement,
      };
      openGaussOptionsLoaded.value = true;
    } else if (partsRes !== undefined && originalOpenGaussOptions.value) {
      originalOpenGaussOptions.value = {
        ...originalOpenGaussOptions.value,
        isPartitioned: Boolean(partsRes),
      };
    }
  } catch (e) {
    console.warn("[ogdeveloper][structure-editor:opengauss-metadata-load-failed]", e);
  } finally {
    if (needOptions) openGaussOptionsLoading.value = false;
    if (needPartitions) openGaussPartitionsLoading.value = false;
  }
}

async function reloadStructureFromDatabase() {
  if (isCreateMode.value) return;
  draftHydrated = false;
  if (activeTab.value !== "triggers") {
    triggers.value = [];
    triggersLoaded.value = false;
  }
  checks.value = [];
  checksLoaded.value = false;
  openGaussOptions.value = createDefaultOpenGaussTableOptions();
  originalOpenGaussOptions.value = undefined;
  openGaussOptionsLoaded.value = false;
  openGaussPartitions.value = createDefaultOpenGaussPartitionDraft();
  originalOpenGaussPartitions.value = null;
  openGaussPartitionsLoaded.value = false;
  const refreshDdl = activeTab.value === "ddl";
  const metadataMatch = { connectionId: props.connectionId, database: props.database, schema: metadataSchema.value, tableName: props.tableName };
  invalidateTableMetadataCache(metadataMatch);
  await invalidateObjectDdl(ddlRequest());
  loadedMetadataFacets.clear();
  if (refreshDdl) {
    ddlFetched.value = false;
    await fetchDdl(true);
  } else {
    await loadStructure(false, visibleTableStructureRefreshScope(baseStructureRefreshTab(activeTab.value)), true, { blockSecondaryMetadata: true, forceMetadata: true });
    if (activeTab.value === "checks") {
      await loadChecksMetadata(true);
      markDraftHydratedAndSync();
    } else if (activeTab.value === "partitions" || activeTab.value === "options") {
      await loadOpenGaussOptionsAndPartitionsMetadata(true);
      markDraftHydratedAndSync();
    }
  }
}

function setSecondaryMetadataLoading(scope: TableStructureRefreshScope, value: boolean) {
  if (scope.indexes && tableMetadataCapabilities.value.indexes) indexesLoading.value = value;
  if (scope.foreignKeys && tableMetadataCapabilities.value.foreignKeys) foreignKeysLoading.value = value;
  if (scope.triggers && tableMetadataCapabilities.value.triggers) triggersLoading.value = value;
}

async function fetchTableCommentValue(connectionId: string, database: string, schema: string, tableName: string, catalog?: string): Promise<string | undefined> {
  try {
    return (await api.getTableComment(connectionId, database, schema, tableName, catalog)) || "";
  } catch {
    try {
      const tables = await api.listTables(connectionId, database, schema, undefined, undefined, undefined, undefined, catalog);
      const table = tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase() && t.table_type !== "VIEW");
      return table?.comment || "";
    } catch {
      return undefined;
    }
  }
}

function loadCachedTableComment(request: ReturnType<typeof ddlRequest>, force = false): Promise<{ value: string | undefined; cacheStatus: "disk" | "remote" }> {
  return loadObjectMetadataFacet(request, "comment", () => fetchTableCommentValue(request.connectionId, request.database, request.schema, request.tableName, request.catalog), { force });
}

async function loadStructure(silent = false, scope: TableStructureRefreshScope = visibleTableStructureRefreshScope(baseStructureRefreshTab(activeTab.value)), showErrors = true, options: { blockSecondaryMetadata?: boolean; preserveDraft?: boolean; forceMetadata?: boolean } = {}) {
  const connectionId = props.connectionId;
  const database = props.database;
  const catalog = props.catalog;
  const schema = metadataSchema.value;
  const tableName = props.tableName;
  if (!connectionId || !database || !tableName) return;
  const requestId = ++structureLoadRequestId;
  if (!silent) loading.value = true;
  setSecondaryMetadataLoading(scope, true);
  errorMessage.value = "";
  let secondaryMetadataScheduled = false;
  let loadedSuccessfully = false;
  try {
    await store.ensureConnected(connectionId);

    const metadataRequest = ddlRequest();
    const forceMetadata = options.forceMetadata === true;
    const columnsLoader = () =>
      api.getColumns(connectionId, database, schema, tableName, catalog).then(async (nextColumns) => {
        // A missing relation returns an empty pg_attribute/JDBC metadata row
        // set. Verify the object before caching or hydrating that empty result,
        // otherwise a right-clicked nonexistent table opens a blank editor.
        if (nextColumns.length > 0 || !shouldCheckEmptyColumnsObjectExistence(connection.value)) return nextColumns;
        await loadObjectDdl(metadataRequest, { force: forceMetadata });
        return nextColumns;
      });
    const columnsPromise = scope.columns ? loadObjectMetadataFacet(metadataRequest, "columns", columnsLoader, { force: forceMetadata }).then((result) => result.value) : Promise.resolve(undefined);
    const indexesPromise = scope.indexes
      ? tableMetadataCapabilities.value.indexes
        ? loadObjectMetadataFacet(metadataRequest, "indexes", () => api.listIndexes(connectionId, database, schema, tableName, catalog).catch(() => []), { force: forceMetadata }).then((result) => result.value)
        : Promise.resolve([])
      : Promise.resolve(undefined);
    const foreignKeysPromise = scope.foreignKeys
      ? tableMetadataCapabilities.value.foreignKeys
        ? loadObjectMetadataFacet(metadataRequest, "foreign-keys", () => api.listForeignKeys(connectionId, database, schema, tableName, catalog).catch(() => []), { force: forceMetadata }).then((result) => result.value)
        : Promise.resolve([])
      : Promise.resolve(undefined);
    const triggersPromise = scope.triggers
      ? tableMetadataCapabilities.value.triggers
        ? loadObjectMetadataFacet(metadataRequest, "triggers", () => api.listTriggers(connectionId, database, schema, tableName, catalog).catch(() => []), { force: forceMetadata }).then((result) => result.value)
        : Promise.resolve([])
      : Promise.resolve(undefined);
    const tableCommentPromise = scope.tableComment && structureCapabilities.value.comment ? loadCachedTableComment(metadataRequest, forceMetadata).then((result) => result.value) : Promise.resolve(undefined);

    const nextColumns = await columnsPromise;
    if (nextColumns) {
      const nextColumnDrafts = createColumnDrafts(nextColumns, databaseType.value);
      columns.value = applyStoredLocalColumnOrder(nextColumnDrafts);
      loadedMetadataFacets.add("columns");
      if (!options.preserveDraft) selectedColumnId.value = null;
    }

    const nextTableComment = await tableCommentPromise;
    if (nextTableComment !== undefined) {
      originalTableComment.value = nextTableComment;
      tableComment.value = nextTableComment;
      loadedMetadataFacets.add("comment");
    }
    const applySecondaryMetadata = async () => {
      const [nextIndexes, nextForeignKeys, nextTriggers] = await Promise.all([indexesPromise, foreignKeysPromise, triggersPromise]);
      if (requestId !== structureLoadRequestId) return;
      if (nextIndexes) {
        indexes.value = createIndexDrafts(nextIndexes);
        loadedMetadataFacets.add("indexes");
      }
      if (nextForeignKeys) {
        foreignKeys.value = createForeignKeyDrafts(nextForeignKeys);
        loadedMetadataFacets.add("foreign-keys");
      }
      if (nextTriggers) {
        triggers.value = createTriggerDrafts(nextTriggers);
        triggersLoaded.value = true;
        loadedMetadataFacets.add("triggers");
      }
    };

    secondaryMetadataScheduled = true;
    const secondaryMetadataPromise = applySecondaryMetadata()
      .catch((error) => {
        console.warn("[ogdeveloper][structure-editor:secondary-metadata-failed]", error);
      })
      .finally(() => {
        if (requestId === structureLoadRequestId) setSecondaryMetadataLoading(scope, false);
      });
    if (options.blockSecondaryMetadata) {
      await secondaryMetadataPromise;
    }
    loadedSuccessfully = true;
  } catch (e: any) {
    if (showErrors) {
      errorMessage.value = e?.message || String(e);
    } else {
      console.warn("[ogdeveloper][structure-editor:refresh-failed]", e);
    }
  } finally {
    if (!secondaryMetadataScheduled && requestId === structureLoadRequestId) {
      setSecondaryMetadataLoading(scope, false);
    }
    if (!silent) loading.value = false;
    if (!options.preserveDraft && loadedSuccessfully && requestId === structureLoadRequestId) {
      markDraftHydratedAndSync();
    }
  }
}

interface ExtraStructureRefreshScope {
  checks: boolean;
  options: boolean;
  partitions: boolean;
}

async function refreshStructureAfterSave(scope: TableStructureRefreshScope, extraScope?: ExtraStructureRefreshScope) {
  try {
    await loadStructure(true, scope, false, { blockSecondaryMetadata: true });
    if (extraScope?.checks || activeTab.value === "checks") {
      await loadChecksMetadata(true);
    }
    if (extraScope?.options || extraScope?.partitions || activeTab.value === "options" || activeTab.value === "partitions") {
      await loadOpenGaussOptionsAndPartitionsMetadata(true);
    }
    markDraftHydratedAndSync();
  } catch (e) {
    console.warn("[ogdeveloper][structure-editor:post-save-refresh-failed]", e);
  } finally {
    postSaveRefreshing.value = false;
    if (activeTab.value === "ddl") void fetchDdl(true);
  }
}

async function focusColumnNameInput(columnId: string) {
  await nextTick();
  const row = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-column-row-index]") ?? []).find((element) => element.dataset.columnId === columnId);
  const input = row?.querySelector<HTMLInputElement>("[data-column-name-input]");
  row?.scrollIntoView({ block: "nearest" });
  input?.focus();
  input?.select();
}

function onColumnRowActivate(column: EditableStructureColumn) {
  if (column.markedForDrop || !columns.value.some((item) => item.id === column.id)) return;
  selectedColumnId.value = column.id;
}

async function addColumn() {
  if (!canAddColumn.value) return;
  activeTab.value = "columns";
  const dataType = defaultNewColumnDataType(databaseType.value, dataTypeOptions.value);
  const column: EditableStructureColumn = {
    id: `new:${uuid()}`,
    name: "",
    dataType,
    enumValues: [],
    isNullable: true,
    defaultValue: "",
    comment: "",
    isPrimaryKey: false,
    characterSet: "",
    collation: "",
    extra: {},
    markedForDrop: false,
  };
  const insertAt = resolveInsertColumnIndex(columns.value, selectedColumnId.value);
  columns.value.splice(insertAt, 0, column);
  selectedColumnId.value = column.id;
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder();
  await focusColumnNameInput(column.id);
}

function applyColumnTemplate(templateId: string) {
  if (!canAddColumn.value) return;
  activeTab.value = "columns";
  const templateColumns = createTableColumnTemplateDrafts({
    templateId,
    databaseType: databaseType.value,
    columnNames: settingsStore.editorSettings.tableColumnTemplateFields,
    existingColumnNames: columns.value.map((column) => column.name),
    createId: uuid,
  });
  if (!templateColumns.length) return;
  const insertAt = resolveInsertColumnIndex(columns.value, selectedColumnId.value);
  columns.value.splice(insertAt, 0, ...templateColumns);
  selectedColumnId.value = templateColumns[templateColumns.length - 1]?.id ?? selectedColumnId.value;
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder();
}

function removeNewColumn(column: EditableStructureColumn) {
  columns.value = columns.value.filter((item) => item.id !== column.id);
  if (selectedColumnId.value === column.id) selectedColumnId.value = null;
}

type ColumnDragState = {
  columnId: string;
  sourceIndex: number;
  insertionIndex: number | null;
};

const columnDragState = ref<ColumnDragState | null>(null);
const localColumnOrderNoticeShown = ref(false);
let columnDragPreviousBodyUserSelect = "";
let columnDragPreviousBodyCursor = "";
let columnDragTracking = false;

function canDragColumn(index: number): boolean {
  if (loading.value || saving.value) return false;
  if (!Number.isInteger(index) || index < 0 || index >= columns.value.length) return false;
  const column = columns.value[index];
  if (!column || column.markedForDrop) return false;
  return canShowColumnDragControls.value;
}

function canDropColumnAt(sourceIndex: number, insertionIndex: number): boolean {
  if (!canDragColumn(sourceIndex)) return false;
  if (!Number.isInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > columns.value.length) return false;
  if (insertionIndex === sourceIndex || insertionIndex === sourceIndex + 1) return false;
  const sourceColumn = columns.value[sourceIndex];
  if (!sourceColumn) return false;
  const crossedColumns = insertionIndex < sourceIndex ? columns.value.slice(insertionIndex, sourceIndex) : columns.value.slice(sourceIndex + 1, insertionIndex);
  if (crossedColumns.some((column) => column.markedForDrop)) return false;
  if (canShowColumnDragControls.value) return true;
  if (sourceColumn.original) return false;
  return crossedColumns.every((column) => !column.original);
}

const usesLocalTableColumnOrder = computed(() => !isCreateMode.value && supportsLocalTableColumnReorder(databaseType.value, connection.value?.db_type));
const canShowColumnDragControls = computed(() => isCreateMode.value || structureCapabilities.value.reorderColumn || usesLocalTableColumnOrder.value);

function localTableColumnOrderScopeKey(): string {
  return tableDataGridColumnOrderScopeKey({
    connectionId: props.connectionId,
    database: props.database,
    schema: props.schema,
    tableName: props.tableName,
  });
}

function localColumnOrderKeys(items: readonly EditableStructureColumn[]): string[] {
  return uniqueDataGridColumnOrderKeys(items.map((column) => column.name));
}

const hasLocalColumnOrderChange = computed(() => {
  if (!usesLocalTableColumnOrder.value) return false;
  return hasLocalTableColumnOrderChange(columns.value);
});

function applyStoredLocalColumnOrder(items: EditableStructureColumn[]): EditableStructureColumn[] {
  if (!usesLocalTableColumnOrder.value) return items;
  const orderedKeys = loadTableDataGridColumnOrder(localTableColumnOrderScopeKey());
  if (!orderedKeys.length) return items;
  const columnKeys = uniqueDataGridColumnOrderKeys(items.map((column) => column.name));
  const indexes = orderedColumnIndexes({
    availableIndexes: items.map((_, index) => index),
    columnKeys,
    orderedKeys,
  });
  return indexes.map((index) => items[index]).filter((column): column is EditableStructureColumn => !!column);
}

function persistLocalColumnOrder(showNotice = true) {
  if (!usesLocalTableColumnOrder.value) return;
  const scopeKey = localTableColumnOrderScopeKey();
  if (hasLocalColumnOrderChange.value) {
    saveTableDataGridColumnOrder(scopeKey, localColumnOrderKeys(columns.value));
  } else {
    removeTableDataGridColumnOrder(scopeKey);
  }
  notifyTableDataGridColumnOrderChanged(scopeKey);
  if (!showNotice || localColumnOrderNoticeShown.value) return;
  localColumnOrderNoticeShown.value = true;
  toast(t("structureEditor.localColumnOrderNotice"), 4000);
}

function updateColumnDataType(column: EditableStructureColumn, baseType: string) {
  column.dataType = combineDataTypeForDatabase(databaseType.value, baseType, getDefaultLengthForType(databaseType.value, baseType));
}

function updateColumnDataTypeLength(column: EditableStructureColumn, value: string | number) {
  const baseType = splitDataType(column.dataType).baseType;
  column.dataType = combineDataTypeForDatabase(databaseType.value, baseType, String(value));
}

function moveColumnTo(index: number, insertionIndex: number) {
  if (!canDropColumnAt(index, insertionIndex)) return;
  const nextColumns = [...columns.value];
  const [column] = nextColumns.splice(index, 1);
  if (!column) return;
  const adjustedInsertionIndex = insertionIndex > index ? insertionIndex - 1 : insertionIndex;
  nextColumns.splice(adjustedInsertionIndex, 0, column);
  columns.value = nextColumns;
  persistLocalColumnOrder();
}

function onColumnDragPointerDown(index: number, event: PointerEvent) {
  if (event.button !== 0 || !canDragColumn(index)) return;
  const column = columns.value[index];
  if (!column) return;
  event.preventDefault();
  event.stopPropagation();
  columnDragState.value = {
    columnId: column.id,
    sourceIndex: index,
    insertionIndex: null,
  };
  columnDragPreviousBodyUserSelect = document.body.style.userSelect;
  columnDragPreviousBodyCursor = document.body.style.cursor;
  columnDragTracking = true;
  document.body.style.userSelect = "none";
  document.body.style.cursor = "grabbing";
  updateColumnDragInsertion(event.clientY);
  window.addEventListener("pointermove", onColumnDragPointerMove, true);
  window.addEventListener("pointerup", onColumnDragPointerUp, true);
  window.addEventListener("pointercancel", onColumnDragPointerCancel, true);
}

function onColumnDragPointerMove(event: PointerEvent) {
  if (!columnDragState.value) return;
  event.preventDefault();
  updateColumnDragInsertion(event.clientY);
}

function onColumnDragPointerUp(event: PointerEvent) {
  event.preventDefault();
  const state = columnDragState.value;
  stopColumnDragTracking();
  if (state && state.insertionIndex !== null && canDropColumnAt(state.sourceIndex, state.insertionIndex)) {
    moveColumnTo(state.sourceIndex, state.insertionIndex);
  }
  columnDragState.value = null;
}

function onColumnDragPointerCancel() {
  stopColumnDragTracking();
  columnDragState.value = null;
}

function stopColumnDragTracking() {
  if (!columnDragTracking) return;
  columnDragTracking = false;
  window.removeEventListener("pointermove", onColumnDragPointerMove, true);
  window.removeEventListener("pointerup", onColumnDragPointerUp, true);
  window.removeEventListener("pointercancel", onColumnDragPointerCancel, true);
  document.body.style.userSelect = columnDragPreviousBodyUserSelect;
  document.body.style.cursor = columnDragPreviousBodyCursor;
}

function updateColumnDragInsertion(clientY: number) {
  const state = columnDragState.value;
  if (!state) return;
  const insertionIndex = columnDragInsertionIndexFromPoint(clientY);
  state.insertionIndex = insertionIndex !== null && canDropColumnAt(state.sourceIndex, insertionIndex) ? insertionIndex : null;
}

function columnDragInsertionIndexFromPoint(clientY: number): number | null {
  const rows = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-column-row-index]") ?? []);
  if (!rows.length) return null;
  const firstRect = rows[0].getBoundingClientRect();
  if (clientY < firstRect.top) return 0;
  for (const row of rows) {
    const rowIndex = Number(row.dataset.columnRowIndex);
    if (!Number.isInteger(rowIndex)) continue;
    const rect = row.getBoundingClientRect();
    if (clientY <= rect.bottom) {
      return clientY > rect.top + rect.height / 2 ? rowIndex + 1 : rowIndex;
    }
  }
  return rows.length;
}

function onColumnDragStart(index: number, event: DragEvent) {
  if (!canDragColumn(index)) {
    event.preventDefault();
    return;
  }
  const column = columns.value[index];
  if (!column) return;
  columnDragState.value = {
    columnId: column.id,
    sourceIndex: index,
    insertionIndex: null,
  };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", column.name || column.id);
  }
}

function onColumnDragOver(index: number, event: DragEvent) {
  const state = columnDragState.value;
  if (!state || columns.value[index]?.markedForDrop) return;
  const insertionIndex = columnDragInsertionIndex(index, event);
  if (!canDropColumnAt(state.sourceIndex, insertionIndex)) return;
  event.preventDefault();
  state.insertionIndex = insertionIndex;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function onColumnDrop(index: number, event: DragEvent) {
  const state = columnDragState.value;
  if (!state) return;
  event.preventDefault();
  moveColumnTo(state.sourceIndex, columnDragInsertionIndex(index, event));
  columnDragState.value = null;
}

function onColumnDragEnd() {
  columnDragState.value = null;
}

function columnRowClass(column: EditableStructureColumn, index: number) {
  const dragState = columnDragState.value;
  const isSearchMatch = filteredColumnRowIds.value.has(column.id);
  const isSelected = selectedColumnId.value === column.id && !column.markedForDrop;
  return {
    "bg-destructive/5 opacity-60": column.markedForDrop,
    "structure-column-search-match": isSearchMatch,
    // Reuse the existing search-current highlight for the active/selected row.
    "structure-column-search-current": highlightedColumnId.value === column.id || isSelected,
    "opacity-55": dragState?.columnId === column.id,
    "bg-primary/5": dragState && (dragState.insertionIndex === index || dragState.insertionIndex === index + 1),
    "[&>td]:border-t-2 [&>td]:border-t-primary": dragState?.insertionIndex === index,
    "[&>td]:border-b-2 [&>td]:border-b-primary": dragState?.insertionIndex === index + 1,
  };
}

function columnMatchesSearch(column: EditableStructureColumn): boolean {
  const query = columnSearchText.value.trim().toLowerCase();
  if (!query) return false;
  return [column.name, column.comment].some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(query),
  );
}

function columnFieldMatchesSearch(value: string | null | undefined): boolean {
  const query = columnSearchText.value.trim().toLowerCase();
  return (
    !!query &&
    String(value ?? "")
      .toLowerCase()
      .includes(query)
  );
}

function columnSearchFieldClass(column: EditableStructureColumn, value: string | null | undefined) {
  const matches = columnFieldMatchesSearch(value);
  return {
    "!border-primary/60 !bg-primary/10": matches,
    "!border-primary !ring-2 !ring-primary/30": matches && highlightedColumnId.value === column.id,
  };
}

function focusColumnSearch() {
  activeTab.value = "columns";
  void nextTick(() => {
    const input = columnSearchInputRef.value?.$el as HTMLInputElement | undefined;
    input?.focus();
    input?.select();
  });
}

function scrollToColumnSearchMatch(direction: 1 | -1 = 1) {
  const query = columnSearchText.value.trim();
  if (!query) {
    focusColumnSearch();
    return;
  }
  const rows = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-column-row-index]") ?? []);
  const matches = columns.value.map((column, index) => ({ column, index })).filter(({ column }) => columnMatchesSearch(column));
  if (!matches.length) return;
  const currentIndex = highlightedColumnId.value ? matches.findIndex(({ column }) => column.id === highlightedColumnId.value) : -1;
  const nextMatch = matches[(currentIndex + direction + matches.length) % matches.length] ?? matches[0];
  highlightedColumnId.value = nextMatch.column.id;
  rows[nextMatch.index]?.scrollIntoView({ block: "center", inline: "nearest" });
  if (columnHighlightTimer) window.clearTimeout(columnHighlightTimer);
  columnHighlightTimer = window.setTimeout(() => {
    highlightedColumnId.value = null;
  }, 1800);
}

function onColumnSearchKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  scrollToColumnSearchMatch(event.shiftKey ? -1 : 1);
}

function indexMatchesSearch(index: EditableStructureIndex, searchQuery = indexSearchText.value.trim().toLowerCase()): boolean {
  if (!searchQuery) return false;
  return [index.name, toColumnNames(index.columns), index.includedColumns.join(", "), index.indexType, index.filter, index.comment].some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(searchQuery),
  );
}

function indexFieldMatchesSearch(value: string | null | undefined): boolean {
  const query = indexSearchText.value.trim().toLowerCase();
  return (
    !!query &&
    String(value ?? "")
      .toLowerCase()
      .includes(query)
  );
}

function indexRowClass(index: EditableStructureIndex) {
  const isSearchMatch = filteredIndexRowIds.value.has(index.id);
  return {
    "bg-destructive/5 opacity-60": index.markedForDrop,
    "structure-column-search-match": isSearchMatch,
    "structure-column-search-current": highlightedIndexId.value === index.id,
  };
}

function indexSearchFieldClass(index: EditableStructureIndex, value: string | null | undefined) {
  const matches = indexFieldMatchesSearch(value);
  return {
    "!border-primary/60 !bg-primary/10": matches,
    "!border-primary !ring-2 !ring-primary/30": matches && highlightedIndexId.value === index.id,
  };
}

function focusIndexSearch() {
  activeTab.value = "indexes";
  void nextTick(() => {
    const input = indexSearchInputRef.value?.$el as HTMLInputElement | undefined;
    input?.focus();
    input?.select();
  });
}

function scrollToIndexSearchMatch(direction: 1 | -1 = 1) {
  const query = indexSearchText.value.trim();
  if (!query) {
    focusIndexSearch();
    return;
  }
  const rows = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-index-row-index]") ?? []);
  const matches = indexes.value.map((index, rowIndex) => ({ index, rowIndex })).filter(({ index }) => indexMatchesSearch(index));
  if (!matches.length) return;
  const currentIndex = highlightedIndexId.value ? matches.findIndex(({ index }) => index.id === highlightedIndexId.value) : -1;
  const nextMatch = matches[(currentIndex + direction + matches.length) % matches.length] ?? matches[0];
  highlightedIndexId.value = nextMatch.index.id;
  rows[nextMatch.rowIndex]?.scrollIntoView({ block: "center", inline: "nearest" });
  if (indexHighlightTimer) window.clearTimeout(indexHighlightTimer);
  indexHighlightTimer = window.setTimeout(() => {
    highlightedIndexId.value = null;
  }, 1800);
}

function onIndexSearchKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  scrollToIndexSearchMatch(event.shiftKey ? -1 : 1);
}

function columnDragInsertionIndex(index: number, event: DragEvent): number {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return index;
  const rect = target.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? index + 1 : index;
}

function toggleDropColumn(column: EditableStructureColumn) {
  if (!canDropColumn(column)) return;
  column.markedForDrop = !column.markedForDrop;
  if (column.markedForDrop && selectedColumnId.value === column.id) {
    selectedColumnId.value = null;
  }
}

function isColumnNameDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || (!!column.original && !structureCapabilities.value.renameColumn);
}

function isColumnTypeDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || (!!column.original && !structureCapabilities.value.alterType);
}

function isColumnLengthDisabled(column: EditableStructureColumn): boolean {
  if (isColumnTypeDisabled(column)) {
    return true;
  }
  const baseType = splitDataType(column.dataType).baseType.trim().toLowerCase();
  return isDataTypeLengthDisabled(databaseType.value, baseType);
}

function isColumnNullableDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || column.isPrimaryKey || (!!column.original && !structureCapabilities.value.alterNullability);
}

function isColumnDefaultDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || (!!column.original && !structureCapabilities.value.alterDefault);
}

function isColumnCommentDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || !structureCapabilities.value.comment;
}

function isPrimaryKeyDisabled(column: EditableStructureColumn): boolean {
  if (column.markedForDrop) return true;
  if (!column.original) return false;
  return !structureCapabilities.value.alterPrimaryKey;
}

function canDropColumn(column: EditableStructureColumn): boolean {
  return !!column.original && !column.isPrimaryKey && structureCapabilities.value.dropColumn;
}

function addIndex() {
  if (!structureCapabilities.value.createIndex || indexesLoading.value) return;
  activeTab.value = "indexes";
  indexes.value.push({
    id: `new:${uuid()}`,
    name: "",
    columns: [],
    nameEdited: false,
    isUnique: false,
    isPrimary: false,
    filter: "",
    indexType: "",
    includedColumns: [],
    comment: "",
    markedForDrop: false,
  });
  void nextTick(() => {
    const indexRows = rootRef.value?.querySelectorAll<HTMLElement>('[data-new-index-row="true"]');
    const row = indexRows?.[indexRows.length - 1];
    const input = row?.querySelector<HTMLInputElement>("[data-index-name-input]");
    row?.scrollIntoView({ block: "nearest" });
    input?.focus();
    input?.select();
  });
}

function structureIndexTableName(): string {
  return (isCreateMode.value ? newTableName.value : props.tableName).trim();
}

function existingIndexNamesForDraft(index: EditableStructureIndex): string[] {
  return indexes.value.filter((item) => item.id !== index.id && !item.markedForDrop).map((item) => item.name);
}

function generatedIndexNameForDraft(index: EditableStructureIndex, columnsForName = index.columns): string {
  return generateUniqueIndexName(structureIndexTableName(), columnsForName, existingIndexNamesForDraft(index));
}

function refreshAutoIndexName(index: EditableStructureIndex, previousColumns = index.columns) {
  if (index.original || index.nameEdited) return;
  const previousName = generateIndexName(structureIndexTableName(), previousColumns);
  const previousUniqueName = generateUniqueIndexName(structureIndexTableName(), previousColumns, existingIndexNamesForDraft(index));
  const currentName = index.name.trim();
  if (currentName && currentName !== previousName && currentName !== previousUniqueName) return;
  index.name = generatedIndexNameForDraft(index);
}

function onIndexNameInput(index: EditableStructureIndex, value: string | number) {
  index.name = String(value ?? "");
  index.nameEdited = true;
}

const availableColumnNames = computed(() =>
  columns.value
    .filter((c) => !c.markedForDrop)
    .map((c) => c.name)
    .filter(Boolean),
);

const colSearch = ref("");

function filteredIndexColumnNames(selectedColumns: readonly string[]): string[] {
  return filterStructureIndexColumnOptions(availableColumnNames.value, selectedColumns, colSearch.value);
}

function toggleIndexColumn(index: EditableStructureIndex, col: string) {
  const previousColumns = [...index.columns];
  const i = index.columns.indexOf(col);
  if (i >= 0) index.columns.splice(i, 1);
  else index.columns.push(col);
  refreshAutoIndexName(index, previousColumns);
}

function toggleIncludedColumn(index: EditableStructureIndex, col: string) {
  if (!structureCapabilities.value.indexInclude) return;
  const i = index.includedColumns.indexOf(col);
  if (i >= 0) index.includedColumns.splice(i, 1);
  else index.includedColumns.push(col);
}

function removeNewIndex(index: EditableStructureIndex) {
  indexes.value = indexes.value.filter((item) => item.id !== index.id);
}

function toggleDropIndex(index: EditableStructureIndex) {
  if (!canDropIndex(index)) return;
  index.markedForDrop = !index.markedForDrop;
}

function canEditIndexDraft(index: EditableStructureIndex): boolean {
  if (indexesLoading.value) return false;
  if (index.markedForDrop || index.isPrimary) return false;
  if (!index.original) return structureCapabilities.value.createIndex;
  return structureCapabilities.value.rebuildIndex && structureCapabilities.value.createIndex && structureCapabilities.value.dropIndex;
}

function canEditIndexFilter(index: EditableStructureIndex): boolean {
  return canEditIndexDraft(index) && structureCapabilities.value.indexFilter;
}

function canEditIndexComment(index: EditableStructureIndex): boolean {
  return canEditIndexDraft(index) && structureCapabilities.value.indexComment;
}

function canDropIndex(index: EditableStructureIndex): boolean {
  if (indexesLoading.value) return false;
  return !!index.original && !index.isPrimary && structureCapabilities.value.dropIndex;
}

const canEditForeignKeys = computed(() => structureCapabilities.value.foreignKey);
const canEditTriggers = computed(() => false);
const isOracleTriggerEditor = computed(() => false);

function generatedForeignKeyName(column = ""): string {
  const table = structureIndexTableName() || "table";
  const suffix = column || "column";
  const base = `fk_${table}_${suffix}`
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const taken = new Set(foreignKeys.value.map((item) => item.name.trim().toLowerCase()).filter(Boolean));
  if (!taken.has(base.toLowerCase())) return base;
  for (let counter = 2; counter < 10_000; counter++) {
    const candidate = `${base}_${counter}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

function addForeignKey() {
  if (!canEditForeignKeys.value || foreignKeysLoading.value) return;
  activeTab.value = "foreignKeys";
  foreignKeys.value.push({
    id: `new:${uuid()}`,
    name: generatedForeignKeyName(),
    column: "",
    refSchema: "",
    refTable: "",
    refColumn: "",
    onUpdate: "",
    onDelete: "",
    markedForDrop: false,
  });
}

function removeNewForeignKey(foreignKey: EditableStructureForeignKey) {
  foreignKeys.value = foreignKeys.value.filter((item) => item.id !== foreignKey.id);
}

function toggleDropForeignKey(foreignKey: EditableStructureForeignKey) {
  if (foreignKeysLoading.value || !foreignKey.original) return;
  foreignKey.markedForDrop = !foreignKey.markedForDrop;
}

function canEditForeignKeyDraft(foreignKey: EditableStructureForeignKey): boolean {
  return !foreignKeysLoading.value && canEditForeignKeys.value && !foreignKey.markedForDrop;
}

function addTrigger() {
  if (!canEditTriggers.value || triggersLoading.value) return;
  activeTab.value = "triggers";
  triggers.value.push({
    id: `new:${uuid()}`,
    name: "",
    timing: isOracleTriggerEditor.value ? "BEFORE EACH ROW" : "BEFORE",
    event: "INSERT",
    statement: isOracleTriggerEditor.value ? "BEGIN\n  NULL;\nEND" : "BEGIN\n  \nEND",
    markedForDrop: false,
  });
}

function removeNewTrigger(trigger: EditableStructureTrigger) {
  triggers.value = triggers.value.filter((item) => item.id !== trigger.id);
}

function toggleDropTrigger(trigger: EditableStructureTrigger) {
  if (triggersLoading.value || !trigger.original) return;
  trigger.markedForDrop = !trigger.markedForDrop;
}

function canEditTriggerDraft(trigger: EditableStructureTrigger): boolean {
  return !triggersLoading.value && canEditTriggers.value && !trigger.markedForDrop && canEditStructuredTriggerDraft(databaseType.value, trigger);
}

// ============================================================================
// Check Constraints & openGauss Storage / Partition UI Helpers
// ============================================================================

function addCheckConstraint() {
  if (!tableMetadataCapabilities.value.checks || checksLoading.value) return;
  activeTab.value = "checks";
  const existingNames = checks.value.filter((c) => !c.markedForDrop).map((c) => c.name);
  checks.value.push({
    id: `new:${uuid()}`,
    name: generateCheckConstraintName(structureIndexTableName(), existingNames),
    expression: "",
    nameEdited: false,
    markedForDrop: false,
  });
}

function removeNewCheckConstraint(check: EditableTableCheckConstraint) {
  checks.value = checks.value.filter((item) => item.id !== check.id);
}

function toggleDropCheckConstraint(check: EditableTableCheckConstraint) {
  if (checksLoading.value || !check.original) return;
  check.markedForDrop = !check.markedForDrop;
}

const openGaussCompressionOptions = computed((): { value: OpenGaussCompression; label: string }[] => {
  const isCol = openGaussOptions.value.orientation === "column";
  const base: { value: OpenGaussCompression; label: string }[] = [
    { value: "no", label: t("structureEditor.opengauss.compressionNo", "NO（不压缩）") },
    { value: "yes", label: t("structureEditor.opengauss.compressionYes", "YES（启用压缩）") },
  ];
  if (isCol) {
    base.push(
      { value: "low", label: t("structureEditor.opengauss.compressionLow", "LOW（低压缩比，列存推荐默认）") },
      { value: "middle", label: t("structureEditor.opengauss.compressionMiddle", "MIDDLE（中压缩比）") },
      { value: "high", label: t("structureEditor.opengauss.compressionHigh", "HIGH（高压缩比）") },
    );
  }
  return base;
});

function onOpenGaussOrientationChange(value: unknown) {
  const next = String(value ?? "row") as OpenGaussOrientation;
  openGaussOptions.value.orientation = next;
  if (next === "column") {
    openGaussOptions.value.storageType = "astore";
    openGaussOptions.value.fillfactor = null;
    if (openGaussPartitions.value.enabled && openGaussPartitions.value.strategy !== "range") {
      openGaussPartitions.value.strategy = "range";
    }
    if (openGaussPartitions.value.enabled && openGaussPartitions.value.interval) {
      openGaussPartitions.value.interval = "";
    }
  } else if (openGaussOptions.value.compression === "low" || openGaussOptions.value.compression === "middle" || openGaussOptions.value.compression === "high") {
    openGaussOptions.value.compression = "yes";
  }
}

function onOpenGaussStorageTypeChange(value: unknown) {
  openGaussOptions.value.storageType = String(value ?? "astore") as OpenGaussStorageType;
}

function onOpenGaussCompressionChange(value: unknown) {
  openGaussOptions.value.compression = String(value ?? "no") as OpenGaussCompression;
}

function onOpenGaussFillfactorInput(value: string | number) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    openGaussOptions.value.fillfactor = null;
    return;
  }
  const num = Number(trimmed);
  openGaussOptions.value.fillfactor = Number.isFinite(num) ? Math.trunc(num) : null;
}

function resetOpenGaussFillfactor() {
  openGaussOptions.value.fillfactor = null;
}

const partKeySearch = ref("");
function filteredPartitionKeyColumns(): string[] {
  return filterStructureIndexColumnOptions(availableColumnNames.value, openGaussPartitions.value.partitionKeys, partKeySearch.value);
}

function toggleCreatePartitionKey(col: string) {
  const idx = openGaussPartitions.value.partitionKeys.indexOf(col);
  if (idx >= 0) openGaussPartitions.value.partitionKeys.splice(idx, 1);
  else openGaussPartitions.value.partitionKeys.push(col);
}

function onToggleCreatePartitionedTable(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  openGaussPartitions.value.enabled = checked;
  if (checked && openGaussPartitions.value.partitions.length === 0 && openGaussPartitions.value.strategy !== "hash") {
    addCreatePartitionItem();
  }
  if (checked && openGaussPartitions.value.partitionKeys.length === 0 && availableColumnNames.value.length > 0) {
    openGaussPartitions.value.partitionKeys = [availableColumnNames.value[0]];
  }
}

function onCreatePartitionStrategyChange(value: unknown) {
  const strategy = String(value ?? "range") as OpenGaussCreatePartitionStrategy;
  openGaussPartitions.value.strategy = strategy;
  if (strategy !== "range") {
    openGaussPartitions.value.interval = "";
  }
  if (strategy === "hash" && openGaussPartitions.value.hashPartitionCount === null) {
    openGaussPartitions.value.hashPartitionCount = 4;
  }
}

function addCreatePartitionItem() {
  activeTab.value = "partitions";
  const nextIndex = openGaussPartitions.value.partitions.length + 1;
  const strategy = openGaussPartitions.value.strategy;
  openGaussPartitions.value.partitions.push({
    id: `new-part:${uuid()}`,
    name: `p_${nextIndex}`,
    boundary: strategy === "range" ? (nextIndex === 1 && !openGaussPartitions.value.interval.trim() ? "MAXVALUE" : "") : strategy === "list" ? "DEFAULT" : "",
    tablespace: "",
  });
}

function removeCreatePartitionItem(id: string) {
  openGaussPartitions.value.partitions = openGaussPartitions.value.partitions.filter((item) => item.id !== id);
}

const canAddOpenGaussPartition = computed(() => {
  const meta = originalOpenGaussPartitions.value;
  if (!meta) return false;
  return meta.strategy === "range" || meta.strategy === "list";
});

const canSplitOpenGaussPartition = computed(() => {
  const meta = originalOpenGaussPartitions.value;
  if (!meta) return false;
  const orientation = originalOpenGaussOptions.value?.orientation ?? "row";
  return (meta.strategy === "range" || meta.strategy === "interval") && orientation === "row";
});

function addPendingPartitionAddOp() {
  if (!canAddOpenGaussPartition.value) return;
  activeTab.value = "partitions";
  const count = (originalOpenGaussPartitions.value?.partitions.length ?? 0) + openGaussPartitions.value.pendingOps.filter((op) => op.type === "add").length + 1;
  openGaussPartitions.value.pendingOps.push({
    id: `op:${uuid()}`,
    type: "add",
    partitionName: `p_${count}`,
    boundary: "",
    tablespace: "",
  });
}

function queueOrFocusRenamePartitionOp(partitionName: string) {
  const existing = openGaussPartitions.value.pendingOps.find((op) => op.type === "rename" && op.partitionName === partitionName);
  if (existing) {
    removePendingPartitionOp(existing.id);
    return;
  }
  openGaussPartitions.value.pendingOps.push({
    id: `op:${uuid()}`,
    type: "rename",
    partitionName,
    newPartitionName: `${partitionName}_new`,
  });
}

function queueOrFocusSplitPartitionOp(partitionName: string) {
  if (!canSplitOpenGaussPartition.value) return;
  const existing = openGaussPartitions.value.pendingOps.find((op) => op.type === "split" && op.partitionName === partitionName);
  if (existing) {
    removePendingPartitionOp(existing.id);
    return;
  }
  openGaussPartitions.value.pendingOps.push({
    id: `op:${uuid()}`,
    type: "split",
    partitionName,
    atValue: "",
    firstPartitionName: `${partitionName}_a`,
    secondPartitionName: `${partitionName}_b`,
  });
}

function toggleTruncatePartitionOp(partitionName: string) {
  const existing = openGaussPartitions.value.pendingOps.find((op) => op.type === "truncate" && op.partitionName === partitionName);
  if (existing) {
    removePendingPartitionOp(existing.id);
    return;
  }
  openGaussPartitions.value.pendingOps.push({
    id: `op:${uuid()}`,
    type: "truncate",
    partitionName,
  });
}

function toggleDropPartitionOp(partitionName: string) {
  const existing = openGaussPartitions.value.pendingOps.find((op) => op.type === "drop" && op.partitionName === partitionName);
  if (existing) {
    removePendingPartitionOp(existing.id);
    return;
  }
  openGaussPartitions.value.pendingOps.push({
    id: `op:${uuid()}`,
    type: "drop",
    partitionName,
  });
}

function removePendingPartitionOp(id: string) {
  openGaussPartitions.value.pendingOps = openGaussPartitions.value.pendingOps.filter((op) => op.id !== id);
}

function clearPendingPartitionOps() {
  openGaussPartitions.value.pendingOps = [];
}

function isPartitionMarkedForDrop(partitionName: string): boolean {
  return openGaussPartitions.value.pendingOps.some((op) => op.type === "drop" && op.partitionName === partitionName);
}

function isPartitionMarkedForTruncate(partitionName: string): boolean {
  return openGaussPartitions.value.pendingOps.some((op) => op.type === "truncate" && op.partitionName === partitionName);
}

function pendingRenameForPartition(partitionName: string): string | undefined {
  const op = openGaussPartitions.value.pendingOps.find((item): item is Extract<OpenGaussPartitionPendingOp, { type: "rename" }> => item.type === "rename" && item.partitionName === partitionName);
  return op?.newPartitionName;
}

function isPartitionMarkedForSplit(partitionName: string): boolean {
  return openGaussPartitions.value.pendingOps.some((op) => op.type === "split" && op.partitionName === partitionName);
}

function primarySqlOperation(sql: string): string {
  const statement = sql
    .split(";")
    .map((part) => part.trim())
    .find(Boolean);
  return statement?.match(/^([a-z]+)/i)?.[1]?.toUpperCase() || "SQL";
}

async function recordStructureHistory(sql: string, start: number, success: boolean, result?: { affected_rows?: number }, error?: string) {
  const connection = store.getConfig(props.connectionId);
  try {
    await historyStore.add({
      connection_id: props.connectionId,
      connection_name: connection?.name || "",
      database: props.database,
      sql,
      execution_time_ms: Date.now() - start,
      success,
      error,
      activity_kind: "schema_change",
      operation: primarySqlOperation(sql),
      target: isCreateMode.value ? newTableName.value.trim() : props.tableName,
      affected_rows: success ? result?.affected_rows : undefined,
    });
  } catch (e) {
    console.warn("[ogdeveloper][structure-history:save-failed]", e);
  }
}

async function copyPreviewSql() {
  if (!previewSqlText.value.trim()) return;
  try {
    await copyToClipboard(previewSqlText.value);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyDdlContent() {
  if (!ddlContent.value.trim()) return;
  try {
    await copyToClipboard(ddlContent.value);
    toast(t("contextMenu.ddlCopied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function toggleSqlPreviewCollapsed() {
  sqlPreviewCollapsed.value = !sqlPreviewCollapsed.value;
  safeLocalStorageSet(STRUCTURE_SQL_PREVIEW_COLLAPSED_STORAGE_KEY, String(sqlPreviewCollapsed.value));
}

async function applyChanges() {
  if (!canApply.value || !props.connectionId || !props.database) return false;
  const sql = previewSqlText.value;
  const connection = store.getConfig(props.connectionId);
  const productionContext = productionContextForDatabase(connection, props.database);
  if (productionContext.active) {
    const confirmed = await productionSafetyStore.requestConfirmation({
      sql,
      connectionName: connection?.name,
      database: props.database,
      productionDatabases: productionContext.databases,
      source: t("production.sourceStructure"),
    });
    if (!confirmed) return false;
  }
  saving.value = true;
  errorMessage.value = "";
  const refreshScope = captureStructureRefreshScope();
  const extraRefreshScope: ExtraStructureRefreshScope = {
    checks: hasPendingCheckChanges(),
    options: hasPendingOpenGaussOptionsChanges(),
    partitions: hasPendingOpenGaussPartitionChanges(),
  };
  const startedAt = Date.now();
  try {
    const result = await api.executeBatch(props.connectionId, props.database, pendingStatements.value, props.schema, queryTimeoutSecsForConnection(connection));
    await recordStructureHistory(sql, startedAt, true, result);
    if (!isCreateMode.value && props.tableName) {
      invalidateTableMetadataCache({ connectionId: props.connectionId, database: props.database, schema: metadataSchema.value, tableName: props.tableName });
      await invalidateObjectDdl(ddlRequest());
      loadedMetadataFacets.clear();
    }
    toast(t("structureEditor.saved"), 2500);
    pendingStatements.value = [];
    warnings.value = [];
    ddlFetched.value = false;
    ddlContent.value = "";
    if (isCreateMode.value) {
      clearDraft();
      emit("saved", tableComment.value !== originalTableComment.value);
      emit("close");
    } else {
      // Refresh persisted keys after successful renames/additions before metadata reloads.
      persistLocalColumnOrder(false);
      saving.value = false;
      postSaveRefreshing.value = true;
      skipNextRefreshVersion = true;
      emit("saved", tableComment.value !== originalTableComment.value);
      await refreshStructureAfterSave(refreshScope, extraRefreshScope);
    }
    return true;
  } catch (e: any) {
    errorMessage.value = e?.message || String(e);
    await recordStructureHistory(sql, startedAt, false, undefined, errorMessage.value);
    return false;
  } finally {
    saving.value = false;
  }
}

defineExpose({ applyChanges });

function addItemForActiveTab(): boolean {
  if (activeTab.value === "columns" && canAddColumn.value) {
    void addColumn();
    return true;
  }
  if (activeTab.value === "indexes" && structureCapabilities.value.createIndex) {
    addIndex();
    return true;
  }
  if (activeTab.value === "foreignKeys" && canEditForeignKeys.value) {
    addForeignKey();
    return true;
  }
  if (activeTab.value === "checks" && tableMetadataCapabilities.value.checks && !checksLoading.value) {
    addCheckConstraint();
    return true;
  }
  if (activeTab.value === "partitions" && tableMetadataCapabilities.value.partitions) {
    if (isCreateMode.value && openGaussPartitions.value.enabled) {
      addCreatePartitionItem();
      return true;
    }
    if (!isCreateMode.value && canAddOpenGaussPartition.value && !openGaussPartitionsLoading.value) {
      addPendingPartitionAddOp();
      return true;
    }
  }
  if (activeTab.value === "triggers" && canEditTriggers.value && !triggersLoading.value) {
    addTrigger();
    return true;
  }
  return false;
}

function onStructureEditorKeydown(event: KeyboardEvent) {
  if (isPlainModShortcut(event, "f")) {
    event.preventDefault();
    event.stopPropagation();
    if (activeTab.value === "columns") focusColumnSearch();
    return;
  }
  if (isPlainModShortcut(event, "s")) {
    event.preventDefault();
    event.stopPropagation();
    void applyChanges();
    return;
  }
  if (isPlainModShortcut(event, "n")) {
    event.preventDefault();
    event.stopPropagation();
    addItemForActiveTab();
  }
}

function registerStructureEditorShortcuts() {
  if (keydownListenerRegistered) return;
  keydownListenerRegistered = true;
  window.addEventListener("keydown", onStructureEditorKeydown);
  document.addEventListener("pointerdown", onStructureDensityDocumentPointerdown, true);
}

function unregisterStructureEditorShortcuts() {
  if (!keydownListenerRegistered) return;
  keydownListenerRegistered = false;
  window.removeEventListener("keydown", onStructureEditorKeydown);
  document.removeEventListener("pointerdown", onStructureDensityDocumentPointerdown, true);
}

onMounted(() => {
  resetState();
  applyInitialStructureTab();
  applyInitialStructureTarget();
  registerStructureEditorShortcuts();
  void loadDynamicDataTypeOptions();
  if (props.draft?.initialized) {
    restoreDraft(props.draft);
    // A restored draft owns its saved tab unless navigation explicitly requested another one.
    applyInitialStructureTab(false);
    applyInitialStructureTarget();
  }
  structureEditorReady = true;
  if (props.draft?.initialized) {
    void hydrateRestoredDraftFromDatabase().then(() => {
      applyInitialStructureTarget();
      void loadActiveTableStructureMetadataIfNeeded();
    });
  } else if (isCreateMode.value) {
    markDraftHydratedAndSync();
  } else if (activeTab.value === "ddl") {
    void fetchDdl();
  } else {
    void loadStructure(false, visibleTableStructureRefreshScope(baseStructureRefreshTab(activeTab.value)), true, { blockSecondaryMetadata: true }).then(() => {
      applyInitialStructureTarget();
      void loadActiveTableStructureMetadataIfNeeded();
    });
  }
});

onActivated(() => {
  registerStructureEditorShortcuts();
  void loadDynamicDataTypeOptions();
  if (props.draft?.initialized && !draftHydrated) {
    restoreDraft(props.draft);
    applyInitialStructureTarget();
    void hydrateRestoredDraftFromDatabase().then(() => {
      applyInitialStructureTarget();
      void loadActiveTableStructureMetadataIfNeeded();
    });
  }
  restoreStructureScrollPosition();
});
onDeactivated(unregisterStructureEditorShortcuts);
onBeforeUnmount(() => {
  stopColumnDragTracking();
  unregisterStructureEditorShortcuts();
  clearSqlPreviewState();
  if (columnHighlightTimer) window.clearTimeout(columnHighlightTimer);
  if (indexHighlightTimer) window.clearTimeout(indexHighlightTimer);
  if (structureScrollFrame) window.cancelAnimationFrame(structureScrollFrame);
  persistStructureDensity();
});

function localFirstStructureMetadataTab(capabilities = tableMetadataCapabilities.value) {
  return firstStructureMetadataTab(capabilities, isCreateMode.value);
}

function localIsStructureMetadataTabSupported(tab: TableInfoTab, capabilities = tableMetadataCapabilities.value) {
  return isStructureMetadataTabSupported(tab, capabilities, isCreateMode.value);
}

function resolveStructureMetadataTab(tab: TableInfoTab | undefined, capabilities = tableMetadataCapabilities.value): TableInfoTab {
  if (tab && localIsStructureMetadataTabSupported(tab, capabilities)) return tab;
  return localFirstStructureMetadataTab(capabilities);
}

function applyInitialStructureTab(useDefault = true) {
  if (props.initialTab) {
    activeTab.value = resolveStructureMetadataTab(props.initialTab);
  } else if (useDefault) {
    activeTab.value = resolveStructureMetadataTab(undefined);
  }
}

function initialTargetKey(target: TableStructureEditorTarget): string {
  return `${props.initialTabRequestId ?? 0}:${target.kind}:${target.name}`;
}

function applyInitialStructureTarget() {
  const target = props.initialTarget;
  const targetName = target?.name.trim();
  if (!target || !targetName) return;

  const key = initialTargetKey(target);
  if (appliedInitialTargetSearchKey !== key) {
    if (target.kind === "column") {
      activeTab.value = resolveStructureMetadataTab("columns");
      columnSearchText.value = targetName;
      highlightedColumnId.value = null;
    } else {
      activeTab.value = resolveStructureMetadataTab("indexes");
      indexSearchText.value = targetName;
      highlightedIndexId.value = null;
    }
    appliedInitialTargetSearchKey = key;
  }

  if (appliedInitialTargetScrollKey === key) return;
  const hasMatch = target.kind === "column" ? columns.value.some((column) => columnMatchesSearch(column)) : indexes.value.some((index) => indexMatchesSearch(index));
  if (!hasMatch) return;
  appliedInitialTargetScrollKey = key;
  void nextTick(() => {
    if (target.kind === "column") {
      scrollToColumnSearchMatch(1);
    } else {
      scrollToIndexSearchMatch(1);
    }
  });
}

watch(tableMetadataCapabilities, (capabilities) => {
  if (!localIsStructureMetadataTabSupported(activeTab.value, capabilities)) activeTab.value = localFirstStructureMetadataTab(capabilities);
});

watch([() => props.initialTab, () => props.initialTabRequestId, () => props.initialTarget], () => {
  if (props.initialTab) applyInitialStructureTab();
  applyInitialStructureTarget();
});

watch([columns, indexes], () => {
  applyInitialStructureTarget();
});

watch([() => props.connectionId, () => props.database, databaseType], () => {
  void loadDynamicDataTypeOptions();
});

watch(
  [isCreateMode, () => props.connectionId, () => props.database, databaseType, () => props.schema, () => props.tableName, newTableName, tableComment, columns, indexes, foreignKeys, triggers, checks, openGaussOptions, openGaussPartitions],
  () => {
    scheduleSqlPreviewRefresh();
    syncDraftToParent();
  },
  { deep: true, immediate: true },
);

watch(activeTab, () => {
  selectedColumnId.value = null;
  highlightedColumnId.value = null;
  highlightedIndexId.value = null;
  restoreStructureScrollPosition();
  syncDraftToParent();
});

watch(
  columns,
  (items) => {
    if (selectedColumnId.value && !items.some((column) => column.id === selectedColumnId.value)) {
      selectedColumnId.value = null;
    }
  },
  { deep: false },
);

watch(secondaryMetadataLoading, (value) => {
  if (value || !deferredSqlPreviewRefresh) return;
  scheduleSqlPreviewRefresh();
});

watch([() => props.tableName, newTableName], () => {
  for (const index of indexes.value) {
    refreshAutoIndexName(index);
  }
});

watch(refreshVersion, (version, previous) => {
  if (version === previous || !version || isCreateMode.value) return;
  if (skipNextRefreshVersion) {
    skipNextRefreshVersion = false;
    return;
  }
  if (activeTab.value !== "triggers") {
    triggers.value = [];
    triggersLoaded.value = false;
  }
  if (activeTab.value !== "checks") {
    checks.value = [];
    checksLoaded.value = false;
  } else {
    void loadChecksMetadata(true);
  }
  if (activeTab.value !== "partitions" && activeTab.value !== "options") {
    openGaussOptionsLoaded.value = false;
    openGaussPartitionsLoaded.value = false;
  } else {
    void loadOpenGaussOptionsAndPartitionsMetadata(true);
  }
  void loadStructure(true, visibleTableStructureRefreshScope(baseStructureRefreshTab(activeTab.value)));
});

async function loadActiveTableStructureMetadataIfNeeded() {
  if (!structureEditorReady || isCreateMode.value) return;
  if (activeTab.value === "ddl") {
    await fetchDdl();
    return;
  }
  if (loading.value || secondaryMetadataLoading.value) return;
  const scope = unloadedTableStructureRefreshScope(baseStructureRefreshTab(activeTab.value), loadedMetadataFacets);
  if (hasTableStructureRefreshWork(scope)) {
    await loadStructure(true, scope, true, { blockSecondaryMetadata: true, preserveDraft: true });
    applyInitialStructureTarget();
  }
  if (activeTab.value === "checks" && tableMetadataCapabilities.value.checks && !checksLoaded.value) {
    await loadChecksMetadata();
    markDraftHydratedAndSync();
    return;
  }
  if ((activeTab.value === "partitions" && tableMetadataCapabilities.value.partitions && !openGaussPartitionsLoaded.value) || (activeTab.value === "options" && tableMetadataCapabilities.value.options && !openGaussOptionsLoaded.value)) {
    await loadOpenGaussOptionsAndPartitionsMetadata();
    markDraftHydratedAndSync();
  }
}

watch([activeTab, loading, secondaryMetadataLoading], () => void loadActiveTableStructureMetadataIfNeeded(), { flush: "sync" });

watch([activeTab, ddlLoading], ([tab, loading]) => {
  if (tab === "ddl" && !loading) {
    void nextTick(() => {
      ddlPreRef.value?.focus();
    });
  }
});
</script>

<template>
  <div ref="rootRef" class="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-[var(--structure-shell-padding)] text-[length:var(--structure-font-size)]" :data-structure-density="localStructureDensity" :style="structureDensityStyle">
    <div class="flex shrink-0 items-center gap-2 rounded-md border bg-muted/20 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]">
      <Database :class="[structureIconClass, 'text-muted-foreground']" />
      <span class="min-w-0 flex-1 truncate font-medium">{{ targetLabel || t("editor.noDatabase") }}</span>
      <Badge variant="outline">{{ connection?.driver_label || databaseType }}</Badge>
      <Button v-if="!isCreateMode" variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="loading || saving || ddlLoading" @click="reloadStructureFromDatabase">
        <RefreshCw :class="structureIconClass" />
        {{ t("structureEditor.refresh") }}
      </Button>
    </div>

    <div v-if="isCreateMode" class="flex shrink-0 items-center gap-2">
      <label class="shrink-0 font-medium text-muted-foreground">{{ t("structureEditor.tableName") }}</label>
      <Input v-model="newTableName" :placeholder="t('contextMenu.duplicateNamePlaceholder')" :class="[structureControlClass, 'max-w-[220px]']" />
    </div>

    <div class="flex shrink-0 items-center gap-2">
      <label class="shrink-0 font-medium text-muted-foreground">{{ t("structureEditor.comment") }}</label>
      <Input v-model="tableComment" :placeholder="t('structureEditor.tableCommentPlaceholder')" :class="[structureControlClass, 'max-w-[320px]']" :disabled="isTableCommentDisabled" />
      <Tooltip v-if="isTableCommentDisabled">
        <TooltipTrigger as-child>
          <Info :class="[structureIconClass, 'shrink-0 text-muted-foreground']" />
        </TooltipTrigger>
        <TooltipContent>{{ t("structureEditor.tableCommentUnsupported") }}</TooltipContent>
      </Tooltip>
    </div>

    <div v-if="loading" class="flex min-h-0 flex-1 items-center justify-center gap-2 text-[length:var(--structure-font-size)] text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      {{ t("common.loading") }}
    </div>

    <div v-else class="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border">
        <Tabs v-model="activeTab" class="flex h-full min-h-0 flex-col">
          <div class="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-[var(--structure-header-py)]">
            <TabsList>
              <TabsTrigger v-if="tableMetadataCapabilities.ddl && !isCreateMode" value="ddl">DDL</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.columns" value="columns">{{ t("structureEditor.columns") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.indexes" value="indexes">{{ t("structureEditor.indexes") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.foreignKeys" value="foreignKeys">{{ t("structureEditor.foreignKeys") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.checks" value="checks">{{ t("structureEditor.opengauss.checksTab", "检查约束") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.partitions" value="partitions">{{ t("structureEditor.opengauss.partitionsTab", "分区") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.options" value="options">{{ t("structureEditor.opengauss.optionsTab", "表选项") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.triggers" value="triggers">{{ t("structureEditor.triggers") }}</TabsTrigger>
            </TabsList>
            <div class="flex shrink-0 items-center gap-1.5">
              <div class="flex items-center gap-1.5">
                <SlidersHorizontal :class="[structureIconClass, 'text-muted-foreground']" />
                <div ref="structureDensityMenuRef" class="relative">
                  <button
                    type="button"
                    class="grid h-[var(--structure-control-height)] min-w-[76px] grid-cols-[1fr_var(--structure-control-height)] items-center rounded-[6px] border bg-background pl-[var(--structure-control-px)] text-[length:var(--structure-font-size)] outline-none hover:bg-muted focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25"
                    :aria-label="t('structureEditor.density')"
                    :aria-expanded="structureDensityMenuOpen"
                    aria-haspopup="listbox"
                    @click="toggleStructureDensityMenu"
                    @keydown="onStructureDensityKeydown"
                  >
                    <span class="min-w-0 text-center truncate">{{ structureDensityOptions.find((option) => option.value === localStructureDensity)?.label }}</span>
                    <span class="flex h-full items-center justify-center">
                      <ChevronDown :class="[structureIconClass, 'shrink-0 opacity-50']" />
                    </span>
                  </button>
                  <div v-if="structureDensityMenuOpen" class="absolute right-0 top-[calc(100%+4px)] z-50 min-w-full rounded-[6px] bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10" role="listbox" :aria-label="t('structureEditor.density')">
                    <button
                      v-for="option in structureDensityOptions"
                      :key="option.value"
                      type="button"
                      class="flex h-7 w-full items-center rounded-[6px] px-1.5 text-left text-[length:var(--structure-font-size)] outline-none hover:bg-accent hover:text-accent-foreground"
                      :class="option.value === localStructureDensity ? 'bg-accent text-accent-foreground' : ''"
                      role="option"
                      :aria-selected="option.value === localStructureDensity"
                      @click="selectStructureDensity(option.value)"
                    >
                      {{ option.label }}
                    </button>
                  </div>
                </div>
              </div>
              <div v-if="activeTab === 'columns'" class="relative flex w-40 shrink-0 items-center">
                <Search :class="[structureIconClass, 'pointer-events-none absolute left-2 text-muted-foreground']" />
                <Input
                  ref="columnSearchInputRef"
                  v-model="columnSearchText"
                  :placeholder="t('structureEditor.searchColumns')"
                  :class="[structureControlClass, 'pl-7 pr-14 text-[length:var(--structure-font-size)] placeholder:text-[length:var(--structure-font-size)]']"
                  @keydown="onColumnSearchKeydown"
                />
                <button
                  v-if="columnSearchText"
                  type="button"
                  class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 text-[length:var(--structure-font-size)] text-muted-foreground hover:bg-muted hover:text-foreground"
                  :title="t('structureEditor.nextColumnMatch')"
                  @click="scrollToColumnSearchMatch(1)"
                >
                  {{ columnSearchMatchCount }}
                </button>
              </div>
              <Button v-if="activeTab === 'columns'" size="sm" :class="structureToolbarButtonClass" :disabled="!canAddColumn" @click="addColumn">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addColumn") }}
              </Button>
              <Button v-if="isCreateMode && activeTab === 'columns'" size="sm" variant="outline" :class="structureToolbarButtonClass" :disabled="!canAddColumn" @click="applyColumnTemplate(PRESET_FIELDS_TEMPLATE_ID)">
                <Copy :class="structureIconClass" />
                {{ t("structureEditor.columnTemplates") }}
              </Button>
              <Tooltip v-if="isCreateMode && activeTab === 'columns'">
                <TooltipTrigger as-child>
                  <Button size="sm" variant="ghost" :class="structureToolbarButtonClass" :disabled="!canAddColumn" :aria-label="t('structureEditor.configureColumnTemplates')" @click="emit('openSettings', 'data', 'tableColumnTemplates')">
                    <Settings :class="structureIconClass" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{{ t("structureEditor.configureColumnTemplates") }}</TooltipContent>
              </Tooltip>
              <div v-if="activeTab === 'indexes'" class="relative flex w-40 shrink-0 items-center">
                <Search :class="[structureIconClass, 'pointer-events-none absolute left-2 text-muted-foreground']" />
                <Input ref="indexSearchInputRef" v-model="indexSearchText" :placeholder="t('structureEditor.searchIndexes')" :class="[structureControlClass, 'pl-7 pr-14 text-[length:var(--structure-font-size)] placeholder:text-[length:var(--structure-font-size)]']" @keydown="onIndexSearchKeydown" />
                <button
                  v-if="indexSearchText"
                  type="button"
                  class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 text-[length:var(--structure-font-size)] text-muted-foreground hover:bg-muted hover:text-foreground"
                  :title="t('structureEditor.nextIndexMatch')"
                  @click="scrollToIndexSearchMatch(1)"
                >
                  {{ indexSearchMatchCount }}
                </button>
              </div>
              <Button v-if="activeTab === 'indexes'" size="sm" :class="structureToolbarButtonClass" :disabled="!structureCapabilities.createIndex || indexesLoading" @click="addIndex">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addIndex") }}
              </Button>
              <Button v-if="activeTab === 'foreignKeys'" size="sm" :class="structureToolbarButtonClass" :disabled="!canEditForeignKeys || foreignKeysLoading" @click="addForeignKey">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addForeignKey") }}
              </Button>
              <Button v-if="activeTab === 'checks'" size="sm" :class="structureToolbarButtonClass" :disabled="checksLoading" @click="addCheckConstraint">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.opengauss.addCheck", "新增检查约束") }}
              </Button>
              <Button v-if="isCreateMode && activeTab === 'partitions' && openGaussPartitions.enabled" size="sm" :class="structureToolbarButtonClass" @click="addCreatePartitionItem">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.opengauss.addPartition", "新增分区") }}
              </Button>
              <Tooltip v-if="!isCreateMode && activeTab === 'partitions' && originalOpenGaussPartitions">
                <TooltipTrigger as-child>
                  <span class="inline-flex">
                    <Button size="sm" :class="structureToolbarButtonClass" :disabled="!canAddOpenGaussPartition || openGaussPartitionsLoading" @click="addPendingPartitionAddOp">
                      <Plus :class="structureIconClass" />
                      {{ t("structureEditor.opengauss.addPartition", "新增分区") }}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent v-if="!canAddOpenGaussPartition">
                  {{ t("structureEditor.opengauss.addPartitionUnsupportedTooltip", "openGauss 不支持对 HASH 或 INTERVAL 分区表手动新增分区") }}
                </TooltipContent>
              </Tooltip>
              <Button v-if="activeTab === 'triggers'" size="sm" :class="structureToolbarButtonClass" :disabled="!canEditTriggers || triggersLoading" @click="addTrigger">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addTrigger") }}
              </Button>
            </div>
          </div>

          <TabsContent ref="columnsScrollerRef" v-if="tableMetadataCapabilities.columns" value="columns" class="m-0 min-h-0 flex-1 overflow-auto p-0" @scroll.passive="onStructureContentScroll('columns', $event)">
            <table class="border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]" :style="{ minWidth: visibleColWidths.reduce((a, w) => a + w, 0) + 'px' }">
              <thead class="sticky top-0 z-10 bg-background">
                <tr>
                  <th
                    v-for="(columnLabel, i) in colLabels"
                    :key="columnLabel.key"
                    :class="[structureHeaderCellClass, { 'text-center': columnLabel.key === 'primaryKey' }]"
                    :style="{
                      width: visibleColWidths[i] + 'px',
                      minWidth: visibleColWidths[i] + 'px',
                    }"
                  >
                    {{ columnLabel.label }}
                    <div v-if="i < colLabels.length - 1" class="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30" :class="colResizing?.col === columnWidthIndex(i) ? 'bg-primary/30' : ''" @mousedown="onColResize($event, i)" />
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(column, index) in columns"
                  :key="column.id"
                  :class="columnRowClass(column, index)"
                  :data-new-column-row="!column.original ? 'true' : undefined"
                  :data-column-row-index="index"
                  :data-column-id="column.id"
                  @click="onColumnRowActivate(column)"
                  @focusin="onColumnRowActivate(column)"
                  @dragover="onColumnDragOver(index, $event)"
                  @drop="onColumnDrop(index, $event)"
                >
                  <td :class="[structureCellClass, 'text-muted-foreground']">
                    <div class="flex items-center gap-1">
                      <span>{{ index + 1 }}</span>
                      <KeyRound v-if="column.isPrimaryKey" :class="[structureIconClass, 'text-amber-500']" />
                    </div>
                  </td>
                  <td :class="structureCellClass">
                    <Input v-model="column.name" :class="[structureControlClass, columnSearchFieldClass(column, column.name)]" :disabled="isColumnNameDisabled(column)" data-column-name-input />
                  </td>
                  <td :class="structureCellClass">
                    <SearchableSelect
                      v-if="!isColumnTypeDisabled(column)"
                      :model-value="splitDataType(column.dataType).baseType"
                      :options="dataTypeOptions"
                      :placeholder="t('structureEditor.typePlaceholder')"
                      :search-placeholder="t('structureEditor.typePlaceholder')"
                      :empty-text="t('structureEditor.noMatchingType')"
                      :loading-text="t('common.loading')"
                      :allow-custom="true"
                      :option-tooltip="dataTypeTooltip"
                      :trigger-class="[structureMonoControlClass, 'w-full']"
                      @update:model-value="(v: string) => updateColumnDataType(column, v)"
                    />
                    <Input v-else :model-value="splitDataType(column.dataType).baseType" :class="[structureMonoControlClass, 'w-full']" disabled />
                  </td>
                  <td v-if="columnEditorControls.length" :class="structureCellClass">
                    <Input :model-value="dataTypeLengthInputValue(databaseType, column.dataType)" :class="[structureMonoControlClass, 'w-full']" :disabled="isColumnLengthDisabled(column)" @update:model-value="updateColumnDataTypeLength(column, $event)" />
                  </td>
                  <td v-if="columnEditorControls.nullable" :class="structureCellClass">
                    <label class="flex items-center gap-1.5">
                      <input v-model="column.isNullable" type="checkbox" :class="structureCheckboxClass" :disabled="isColumnNullableDisabled(column)" />
                      <span>{{ column.isNullable ? t("structureEditor.yes") : t("structureEditor.no") }}</span>
                    </label>
                  </td>
                  <td v-if="columnEditorControls.primaryKey" :class="[structureCellClass, 'text-center']">
                    <input
                      v-model="column.isPrimaryKey"
                      type="checkbox"
                      :class="structureCheckboxClass"
                      :disabled="isPrimaryKeyDisabled(column)"
                      @change="
                        () => {
                          if (column.isPrimaryKey) column.isNullable = false;
                        }
                      "
                    />
                  </td>
                  <td v-if="columnEditorControls.defaultValue" :class="structureCellClass">
                    <div class="flex min-w-0 items-center gap-1">
                      <Input v-model="column.defaultValue" :class="[structureMonoControlClass, 'flex-1']" :disabled="isColumnDefaultDisabled(column)" />
                      <DropdownMenu>
                        <DropdownMenuTrigger as-child>
                          <Button variant="ghost" size="icon" :class="[structureIconButtonClass, 'shrink-0']" :disabled="isColumnDefaultDisabled(column)" :aria-label="t('structureEditor.defaultValuePresets')" :title="t('structureEditor.defaultValuePresets')">
                            <ChevronDown :class="structureIconClass" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" class="max-h-56 min-w-36 overflow-y-auto">
                          <DropdownMenuItem v-for="preset in defaultValuePresets" :key="preset.value" @click="column.defaultValue = preset.value">
                            <code class="font-mono text-[length:var(--structure-font-size)]">{{ preset.label }}</code>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                  <td v-if="columnEditorControls.comment" :class="structureCellClass">
                    <div class="flex min-w-0 items-center gap-1">
                      <Input v-model="column.comment" :class="[structureControlClass, 'flex-1', columnSearchFieldClass(column, column.comment)]" :disabled="isColumnCommentDisabled(column)" />
                      <Popover>
                        <PopoverTrigger as-child>
                          <Button variant="ghost" size="icon" :class="[structureIconButtonClass, 'shrink-0']" :disabled="isColumnCommentDisabled(column)" :aria-label="t('structureEditor.editComment')" :title="t('structureEditor.editComment')">
                            <Maximize2 :class="structureIconClass" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" class="w-[420px] p-2.5">
                          <div class="mb-2 flex items-center justify-between gap-2">
                            <span class="min-w-0 truncate text-xs font-medium">
                              {{ t("structureEditor.editComment") }}
                            </span>
                            <span class="max-w-44 truncate font-mono text-[length:var(--structure-font-size)] text-muted-foreground">
                              {{ column.name || t("structureEditor.columnName") }}
                            </span>
                          </div>
                          <textarea
                            v-model="column.comment"
                            class="min-h-36 w-full resize-y rounded-[6px] border bg-background px-[var(--structure-control-px)] py-[var(--structure-cell-py)] text-[length:var(--structure-font-size)] leading-5 outline-none focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
                            :placeholder="t('structureEditor.commentPlaceholder')"
                            :disabled="isColumnCommentDisabled(column)"
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </td>
                  <td v-if="showExtendedProperties" :class="structureCellClass">
                    <div :class="structurePropertyListClass">
                      <!-- PostgreSQL/openGauss: IDENTITY -->
                      <template v-if="structureDialect === 'postgres'">
                        <Select
                          :model-value="column.extra.identity?.generation ?? 'none'"
                          @update:model-value="
                            (value: any) => {
                              const generation = String(value ?? '');
                              if (generation && generation !== 'none') {
                                column.extra.identity = {
                                  ...column.extra.identity,
                                  generation: generation as 'BY DEFAULT' | 'ALWAYS',
                                };
                              } else {
                                column.extra.identity = undefined;
                              }
                            }
                          "
                        >
                          <SelectTrigger class="h-[var(--structure-control-height)] w-28 rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">{{ t("structureEditor.no") }}</SelectItem>
                            <SelectItem value="BY DEFAULT">BY DEFAULT</SelectItem>
                            <SelectItem value="ALWAYS">ALWAYS</SelectItem>
                          </SelectContent>
                        </Select>
                        <template v-if="column.extra.identity?.generation">
                          <Input
                            :model-value="column.extra.identity.seed?.toString() ?? ''"
                            type="number"
                            :class="[structureControlClass, 'w-14']"
                            :placeholder="t('structureEditor.identitySeed')"
                            @update:model-value="
                              (v) => {
                                if (column.extra.identity) {
                                  column.extra.identity.seed = v ? Number(v) : undefined;
                                }
                              }
                            "
                          />
                          <Input
                            :model-value="column.extra.identity.increment?.toString() ?? ''"
                            type="number"
                            :class="[structureControlClass, 'w-14']"
                            :placeholder="t('structureEditor.identityIncrement')"
                            @update:model-value="
                              (v) => {
                                if (column.extra.identity) {
                                  column.extra.identity.increment = v ? Number(v) : undefined;
                                }
                              }
                            "
                          />
                        </template>
                      </template>
                    </div>
                  </td>
                  <td :class="structureLastCellClass">
                    <div class="flex min-w-0 items-center justify-start gap-0.5">
                      <Button
                        v-if="canShowColumnDragControls"
                        type="button"
                        variant="ghost"
                        size="icon"
                        :class="[structureActionButtonClass, canDragColumn(index) ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed', hasLocalColumnOrderChange ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary' : '']"
                        :disabled="!canDragColumn(index)"
                        :title="t('structureEditor.dragColumn')"
                        :aria-label="t('structureEditor.dragColumn')"
                        :draggable="canDragColumn(index)"
                        @pointerdown="onColumnDragPointerDown(index, $event)"
                        @dragstart="onColumnDragStart(index, $event)"
                        @dragend="onColumnDragEnd"
                      >
                        <ListChevronsUpDown :class="structureIconClass" />
                      </Button>
                      <Button
                        v-if="column.original"
                        variant="ghost"
                        size="icon"
                        :class="structureActionButtonClass"
                        :disabled="!canDropColumn(column)"
                        :title="column.markedForDrop ? t('structureEditor.restore') : t('structureEditor.drop')"
                        :aria-label="column.markedForDrop ? t('structureEditor.restore') : t('structureEditor.drop')"
                        @click.stop="toggleDropColumn(column)"
                      >
                        <RefreshCw v-if="column.markedForDrop" :class="structureIconClass" />
                        <Trash2 v-else :class="structureIconClass" />
                      </Button>
                      <Button v-else variant="ghost" size="icon" :class="structureActionButtonClass" :title="t('structureEditor.remove')" :aria-label="t('structureEditor.remove')" @click.stop="removeNewColumn(column)">
                        <X :class="structureIconClass" />
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </TabsContent>

          <TabsContent ref="indexesScrollerRef" v-if="tableMetadataCapabilities.indexes" value="indexes" class="m-0 min-h-0 flex-1 overflow-auto p-0" @scroll.passive="onStructureContentScroll('indexes', $event)">
            <div v-if="indexesLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <table v-else class="border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]" :style="{ minWidth: indexColWidths.reduce((a, w) => a + w, 0) + 'px' }">
              <thead class="sticky top-0 z-10 bg-background">
                <tr>
                  <th
                    v-for="(label, i) in indexColLabels"
                    :key="i"
                    :class="structureHeaderCellClass"
                    :style="{
                      width: indexColWidths[i] + 'px',
                      minWidth: indexColWidths[i] + 'px',
                    }"
                  >
                    {{ label }}
                    <div v-if="i < indexColLabels.length - 1" class="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30" :class="resizing?.col === i ? 'bg-primary/30' : ''" @mousedown="onIndexColResize($event, i)" />
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(index, rowIndex) in indexes" :key="index.id" :class="indexRowClass(index)" :data-new-index-row="!index.original ? 'true' : undefined" :data-index-row-index="rowIndex">
                  <td :class="structureCellClass">
                    <Input :model-value="index.name" :class="[structureControlClass, indexSearchFieldClass(index, index.name)]" :disabled="!canEditIndexDraft(index)" data-index-name-input @update:model-value="(value: string | number) => onIndexNameInput(index, value)" />
                  </td>
                  <td :class="[structureCellClass, 'overflow-hidden']">
                    <DropdownMenu v-if="canEditIndexDraft(index)">
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" :class="[structureMonoControlClass, 'w-full justify-between']">
                          <span class="truncate">{{ toColumnNames(index.columns) || t("structureEditor.indexColumnsPlaceholder") }}</span>
                          <ChevronDown :class="[structureIconClass, 'ml-1 shrink-0 opacity-50']" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent class="max-h-56 min-w-44 overflow-y-auto" side="bottom" :side-offset="2" :avoid-collisions="false" @interactOutside="colSearch = ''">
                        <div class="px-[var(--structure-cell-px)] pb-1 pt-0.5">
                          <Input v-model="colSearch" :class="structureControlClass" :placeholder="t('grid.search')" @click.stop />
                        </div>
                        <DropdownMenuCheckboxItem v-for="col in filteredIndexColumnNames(index.columns)" :key="col" :checked="index.columns.includes(col)" :class="index.columns.includes(col) ? 'bg-primary/10' : ''" @select.prevent @click="toggleIndexColumn(index, col)">
                          {{ col }}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <span v-else class="font-mono text-[length:var(--structure-font-size)] text-muted-foreground">{{ toColumnNames(index.columns) }}</span>
                  </td>
                  <td :class="structureCellClass">
                    <label class="flex items-center gap-1.5">
                      <input v-model="index.isUnique" type="checkbox" :class="structureCheckboxClass" :disabled="!canEditIndexDraft(index)" />
                      <span>{{ index.isUnique ? t("structureEditor.yes") : t("structureEditor.no") }}</span>
                    </label>
                  </td>
                  <td :class="structureCellClass">
                    <Select v-if="indexTypeOptions.length > 0" :model-value="index.indexType || 'BTREE'" :disabled="!canEditIndexDraft(index)" @update:model-value="(v: any) => (index.indexType = String(v ?? ''))">
                      <SelectTrigger class="h-[var(--structure-control-height)] w-full rounded-[6px] px-[var(--structure-control-px)] font-mono text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="opt in indexTypeOptions" :key="opt" :value="opt">{{ opt }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input v-else v-model="index.indexType" :class="structureMonoControlClass" placeholder="BTREE" :disabled="!canEditIndexDraft(index) || !structureCapabilities.indexType" />
                  </td>
                  <td :class="[structureCellClass, 'overflow-hidden']">
                    <DropdownMenu v-if="canEditIndexDraft(index) && structureCapabilities.indexInclude">
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" :class="[structureMonoControlClass, 'w-full justify-between']">
                          <span class="truncate">{{ index.includedColumns.join(", ") || t("structureEditor.includedColumnsPlaceholder") }}</span>
                          <ChevronDown :class="[structureIconClass, 'ml-1 shrink-0 opacity-50']" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent class="max-h-56 min-w-44 overflow-y-auto" side="bottom" :side-offset="2" :avoid-collisions="false" @interactOutside="colSearch = ''">
                        <div class="px-[var(--structure-cell-px)] pb-1 pt-0.5">
                          <Input v-model="colSearch" :class="structureControlClass" :placeholder="t('grid.search')" @click.stop />
                        </div>
                        <DropdownMenuCheckboxItem v-for="col in filteredIndexColumnNames(index.includedColumns)" :key="col" :checked="index.includedColumns.includes(col)" :class="index.includedColumns.includes(col) ? 'bg-primary/10' : ''" @select.prevent @click="toggleIncludedColumn(index, col)">
                          {{ col }}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <span v-else class="text-[length:var(--structure-font-size)] text-muted-foreground">{{ index.includedColumns.join(", ") }}</span>
                  </td>
                  <td :class="structureCellClass">
                    <Input v-model="index.filter" :class="[structureMonoControlClass, indexSearchFieldClass(index, index.filter)]" :placeholder="index.original?.filter || ''" :disabled="!canEditIndexFilter(index)" />
                  </td>
                  <td :class="structureCellClass">
                    <Input v-model="index.comment" :class="[structureControlClass, indexSearchFieldClass(index, index.comment)]" :disabled="!canEditIndexComment(index)" />
                  </td>
                  <td :class="structureLastCellClass">
                    <Badge v-if="index.isPrimary" variant="outline">{{ t("structureEditor.primary") }}</Badge>
                    <Button v-else-if="index.original" variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="!canDropIndex(index)" @click="toggleDropIndex(index)">
                      <Trash2 :class="structureIconClass" />
                      {{ index.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop") }}
                    </Button>
                    <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="removeNewIndex(index)">
                      <X :class="structureIconClass" />
                      {{ t("structureEditor.remove") }}
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </TabsContent>

          <TabsContent ref="foreignKeysScrollerRef" v-if="tableMetadataCapabilities.foreignKeys" value="foreignKeys" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('foreignKeys', $event)">
            <div v-if="foreignKeysLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="foreignKeys.length === 0" class="py-10 text-center text-muted-foreground">
              {{ t("structureEditor.emptyReadonly") }}
            </div>
            <div v-else class="space-y-1.5">
              <div v-for="fk in foreignKeys" :key="fk.id" class="rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]" :class="fk.markedForDrop ? 'bg-destructive/5 opacity-60' : ''">
                <div class="grid grid-cols-[minmax(110px,1fr)_minmax(110px,1fr)_minmax(110px,1fr)_minmax(90px,0.8fr)_minmax(90px,0.8fr)_auto] gap-1.5">
                  <Input v-model="fk.name" :class="structureControlClass" :placeholder="t('structureEditor.foreignKeyName')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-model="fk.column" :class="structureControlClass" :placeholder="t('structureEditor.columnName')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-model="fk.refTable" :class="structureControlClass" :placeholder="t('structureEditor.referencedTable')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-model="fk.refColumn" :class="structureControlClass" :placeholder="t('structureEditor.referencedColumn')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-model="fk.refSchema" :class="structureControlClass" :placeholder="t('structureEditor.referencedSchema')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <div class="flex items-center justify-end gap-1">
                    <Button v-if="fk.original" variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="toggleDropForeignKey(fk)">
                      <Trash2 :class="structureIconClass" />
                      {{ fk.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop") }}
                    </Button>
                    <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="removeNewForeignKey(fk)">
                      <X :class="structureIconClass" />
                      {{ t("structureEditor.remove") }}
                    </Button>
                  </div>
                </div>
                <div class="mt-1.5 grid grid-cols-[minmax(110px,0.5fr)_minmax(110px,0.5fr)_1fr] gap-1.5">
                  <Select :model-value="fk.onDelete || '__default'" :disabled="!canEditForeignKeyDraft(fk)" @update:model-value="(v: any) => (fk.onDelete = String(v === '__default' ? '' : (v ?? '')))">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                      <SelectValue :placeholder="t('structureEditor.onDelete')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="action in foreignKeyActionOptions" :key="`delete-${action || 'default'}`" :value="action || '__default'">{{ action || t("structureEditor.defaultAction") }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select :model-value="fk.onUpdate || '__default'" :disabled="!canEditForeignKeyDraft(fk)" @update:model-value="(v: any) => (fk.onUpdate = String(v === '__default' ? '' : (v ?? '')))">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                      <SelectValue :placeholder="t('structureEditor.onUpdate')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="action in foreignKeyActionOptions" :key="`update-${action || 'default'}`" :value="action || '__default'">{{ action || t("structureEditor.defaultAction") }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <div class="truncate font-mono text-muted-foreground">{{ fk.column }} -> {{ fk.refSchema ? `${fk.refSchema}.` : "" }}{{ fk.refTable }}.{{ fk.refColumn }}</div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent ref="checksScrollerRef" v-if="tableMetadataCapabilities.checks" value="checks" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('checks', $event)">
            <div v-if="checksLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="checks.length === 0" class="py-10 text-center text-muted-foreground">
              {{ t("structureEditor.opengauss.checksEmpty", "暂无 CHECK 检查约束，可点击右上角按钮新增") }}
            </div>
            <div v-else class="space-y-1.5">
              <div v-for="check in checks" :key="check.id" class="rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]" :class="check.markedForDrop ? 'bg-destructive/5 opacity-60' : ''">
                <div class="grid grid-cols-[minmax(160px,0.7fr)_auto_minmax(220px,1.6fr)_auto] items-center gap-1.5">
                  <Input v-model="check.name" :class="structureControlClass" :placeholder="t('structureEditor.opengauss.checkNamePlaceholder', '约束名称，如 chk_age_positive')" :disabled="check.markedForDrop || checksLoading" />
                  <Badge variant="outline" class="font-mono">CHECK</Badge>
                  <Input v-model="check.expression" :class="structureMonoControlClass" :placeholder="t('structureEditor.opengauss.checkExpressionPlaceholder', '布尔表达式，如 age >= 0 AND status IN (1, 2)')" :disabled="check.markedForDrop || checksLoading" />
                  <div class="flex items-center justify-end gap-1">
                    <Button v-if="check.original" variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="checksLoading" @click="toggleDropCheckConstraint(check)">
                      <RefreshCw v-if="check.markedForDrop" :class="structureIconClass" />
                      <Trash2 v-else :class="structureIconClass" />
                      {{ check.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop") }}
                    </Button>
                    <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="removeNewCheckConstraint(check)">
                      <X :class="structureIconClass" />
                      {{ t("structureEditor.remove") }}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent ref="partitionsScrollerRef" v-if="tableMetadataCapabilities.partitions" value="partitions" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('partitions', $event)">
            <div v-if="openGaussPartitionsLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>

            <!-- Create Mode: Partitioned Table Builder -->
            <div v-else-if="isCreateMode" class="space-y-2.5">
              <div class="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/15 px-[var(--structure-cell-px)] py-[var(--structure-header-py)]">
                <label class="flex cursor-pointer items-center gap-2 font-medium">
                  <input :checked="openGaussPartitions.enabled" type="checkbox" :class="structureCheckboxClass" @change="onToggleCreatePartitionedTable" />
                  <span>{{ t("structureEditor.opengauss.enablePartitionedTable", "启用分区表 (Partitioned Table)") }}</span>
                </label>
                <label v-if="openGaussPartitions.enabled" class="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
                  <input v-model="openGaussPartitions.enableRowMovement" type="checkbox" :class="structureCheckboxClass" />
                  <span>{{ t("structureEditor.opengauss.enableRowMovement", "允许跨分区行迁移 (ENABLE ROW MOVEMENT)") }}</span>
                </label>
              </div>

              <template v-if="openGaussPartitions.enabled">
                <div class="grid grid-cols-1 gap-2 rounded-md border p-[var(--structure-cell-px)] md:grid-cols-3">
                  <div class="space-y-1">
                    <label class="block font-medium text-muted-foreground">{{ t("structureEditor.opengauss.partitionStrategy", "分区策略") }}</label>
                    <Select :model-value="openGaussPartitions.strategy" @update:model-value="onCreatePartitionStrategyChange">
                      <SelectTrigger class="h-[var(--structure-control-height)] w-full rounded-[6px] px-[var(--structure-control-px)] font-mono text-[length:var(--structure-font-size)]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="range">RANGE</SelectItem>
                        <SelectItem value="list" :disabled="openGaussOptions.orientation === 'column'">LIST</SelectItem>
                        <SelectItem value="hash" :disabled="openGaussOptions.orientation === 'column'">HASH</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div class="space-y-1">
                    <label class="block font-medium text-muted-foreground">{{ t("structureEditor.opengauss.partitionKeyColumns", "分区键列") }}</label>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" :class="[structureMonoControlClass, 'w-full justify-between']">
                          <span class="truncate">{{ openGaussPartitions.partitionKeys.join(", ") || t("structureEditor.opengauss.selectPartitionKeys", "选择分区键列...") }}</span>
                          <ChevronDown :class="[structureIconClass, 'ml-1 shrink-0 opacity-50']" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent class="max-h-56 min-w-44 overflow-y-auto" side="bottom" :side-offset="2" :avoid-collisions="false" @interactOutside="partKeySearch = ''">
                        <div class="px-[var(--structure-cell-px)] pb-1 pt-0.5">
                          <Input v-model="partKeySearch" :class="structureControlClass" :placeholder="t('grid.search')" @click.stop />
                        </div>
                        <DropdownMenuCheckboxItem v-for="col in filteredPartitionKeyColumns()" :key="col" :checked="openGaussPartitions.partitionKeys.includes(col)" :class="openGaussPartitions.partitionKeys.includes(col) ? 'bg-primary/10' : ''" @select.prevent @click="toggleCreatePartitionKey(col)">
                          {{ col }}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div v-if="openGaussPartitions.strategy === 'range'" class="space-y-1">
                    <label class="block font-medium text-muted-foreground">{{ t("structureEditor.opengauss.intervalExpr", "自动间隔 (INTERVAL，可选)") }}</label>
                    <Input v-model="openGaussPartitions.interval" :class="structureMonoControlClass" :disabled="openGaussOptions.orientation === 'column'" :placeholder="t('structureEditor.opengauss.intervalPlaceholder', '如 1 month 或 1 day')" />
                  </div>

                  <div v-else-if="openGaussPartitions.strategy === 'hash' && openGaussPartitions.partitions.length === 0" class="space-y-1">
                    <label class="block font-medium text-muted-foreground">{{ t("structureEditor.opengauss.hashPartitionCount", "HASH 分区数量 (PARTITIONS)") }}</label>
                    <Input :model-value="openGaussPartitions.hashPartitionCount?.toString() ?? '4'" type="number" min="1" :class="structureMonoControlClass" @update:model-value="(v: string | number) => (openGaussPartitions.hashPartitionCount = v ? Math.max(1, Math.trunc(Number(v))) : null)" />
                  </div>
                </div>

                <div class="rounded-md border">
                  <div class="flex items-center justify-between border-b bg-muted/15 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] font-medium">
                    <span>{{ t("structureEditor.opengauss.initialPartitions", "初始分区定义") }}</span>
                    <span v-if="openGaussPartitions.strategy === 'hash' && openGaussPartitions.partitions.length === 0" class="text-muted-foreground">
                      {{ t("structureEditor.opengauss.hashCountModeHint", "当前按 PARTITIONS 数量自动生成，也可点击右上角「新增分区」自定义分区名") }}
                    </span>
                  </div>
                  <div v-if="openGaussPartitions.partitions.length === 0" class="py-6 text-center text-muted-foreground">
                    {{
                      openGaussPartitions.strategy === "hash" ? `${t("structureEditor.opengauss.hashAutoGeneratedSummary", "将自动创建 HASH 分区数")}: ${openGaussPartitions.hashPartitionCount ?? 4}` : t("structureEditor.opengauss.noInitialPartitions", "请点击右上角「新增分区」定义至少一个初始分区")
                    }}
                  </div>
                  <div v-else class="divide-y">
                    <div
                      v-for="(part, idx) in openGaussPartitions.partitions"
                      :key="part.id"
                      class="grid items-center gap-1.5 px-[var(--structure-cell-px)] py-[var(--structure-cell-py)]"
                      :class="openGaussPartitions.strategy === 'hash' ? 'grid-cols-[28px_minmax(140px,1fr)_minmax(140px,0.8fr)_auto]' : 'grid-cols-[28px_minmax(140px,0.8fr)_minmax(200px,1.4fr)_minmax(130px,0.7fr)_auto]'"
                    >
                      <span class="text-muted-foreground">{{ idx + 1 }}</span>
                      <Input v-model="part.name" :class="structureMonoControlClass" :placeholder="t('structureEditor.opengauss.partitionNamePlaceholder', '分区名，如 p_2026_01')" />
                      <Input
                        v-if="openGaussPartitions.strategy !== 'hash'"
                        v-model="part.boundary"
                        :class="structureMonoControlClass"
                        :placeholder="openGaussPartitions.strategy === 'range' ? t('structureEditor.opengauss.rangeBoundaryPlaceholder', 'VALUES LESS THAN，如 \'2026-01-01\' 或 MAXVALUE') : t('structureEditor.opengauss.listBoundaryPlaceholder', 'VALUES，如 \'BJ\', \'SH\' 或 DEFAULT')"
                      />
                      <Input v-model="part.tablespace" :class="structureMonoControlClass" :placeholder="t('structureEditor.opengauss.tablespaceOptionalPlaceholder', '表空间（可选）')" />
                      <Button variant="ghost" size="icon" :class="structureActionButtonClass" :title="t('structureEditor.remove')" @click="removeCreatePartitionItem(part.id)">
                        <X :class="structureIconClass" />
                      </Button>
                    </div>
                  </div>
                </div>
              </template>
            </div>

            <!-- Edit Mode: Non-partitioned Table Empty State -->
            <div v-else-if="!originalOpenGaussPartitions" class="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
              <Info class="h-5 w-5 opacity-60" />
              <p class="max-w-lg">{{ t("structureEditor.opengauss.nonPartitionedTableEmpty", "当前表为普通非分区表。openGauss 需要在建表 (CREATE TABLE) 时指定分区策略，已有普通表不支持直接原地转换为分区表。") }}</p>
            </div>

            <!-- Edit Mode: Existing Partitioned Table Manager -->
            <div v-else class="space-y-2.5">
              <div class="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/15 px-[var(--structure-cell-px)] py-[var(--structure-header-py)]">
                <div class="flex flex-wrap items-center gap-1.5">
                  <Badge>{{ originalOpenGaussPartitions.strategy.toUpperCase() }}</Badge>
                  <Badge variant="secondary" class="font-mono"> {{ t("structureEditor.opengauss.partitionKeyBadge", "分区键") }}: ({{ originalOpenGaussPartitions.partitionKeys.join(", ") }}) </Badge>
                  <Badge v-if="originalOpenGaussPartitions.interval" variant="outline" class="font-mono"> INTERVAL ({{ originalOpenGaussPartitions.interval }}) </Badge>
                  <Badge v-if="originalOpenGaussPartitions.subpartitionCount > 0" variant="outline"> {{ t("structureEditor.opengauss.subpartitionsCount", "二级分区") }}: {{ originalOpenGaussPartitions.subpartitionCount }} </Badge>
                </div>

                <Tooltip>
                  <TooltipTrigger as-child>
                    <label class="flex cursor-pointer items-center gap-1.5">
                      <input v-model="openGaussPartitions.updateGlobalIndex" type="checkbox" :class="structureCheckboxClass" />
                      <span class="font-medium">{{ t("structureEditor.opengauss.updateGlobalIndex", "UPDATE GLOBAL INDEX") }}</span>
                    </label>
                  </TooltipTrigger>
                  <TooltipContent>
                    {{ t("structureEditor.opengauss.updateGlobalIndexTooltip", "执行 DROP / TRUNCATE / SPLIT PARTITION 时同步维护全局分区索引，避免全局索引失效") }}
                  </TooltipContent>
                </Tooltip>
              </div>

              <div class="overflow-x-auto rounded-md border">
                <table class="w-full border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]">
                  <thead class="bg-muted/20">
                    <tr>
                      <th :class="[structureHeaderCellClass, 'w-9']">#</th>
                      <th :class="structureHeaderCellClass">{{ t("structureEditor.opengauss.partitionNameCol", "分区名称") }}</th>
                      <th :class="structureHeaderCellClass">{{ t("structureEditor.opengauss.partitionBoundaryCol", "分区边界") }}</th>
                      <th :class="structureHeaderCellClass">{{ t("structureEditor.opengauss.tablespaceCol", "表空间") }}</th>
                      <th :class="[structureHeaderCellClass, 'text-right']">{{ t("structureEditor.opengauss.estimatedRowsCol", "预估行数") }}</th>
                      <th :class="[structureHeaderCellClass, 'text-right']">{{ t("structureEditor.opengauss.partitionSizeCol", "大小") }}</th>
                      <th v-if="originalOpenGaussPartitions.subpartitionCount > 0" :class="[structureHeaderCellClass, 'text-right']">
                        {{ t("structureEditor.opengauss.subpartitionsCount", "二级分区") }}
                      </th>
                      <th :class="[structureHeaderCellClass, 'border-r-0 text-right']">{{ t("structureEditor.actions") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(part, idx) in originalOpenGaussPartitions.partitions" :key="part.oid || part.name" :class="isPartitionMarkedForDrop(part.name) ? 'bg-destructive/5 opacity-60' : ''">
                      <td :class="[structureCellClass, 'text-muted-foreground']">{{ idx + 1 }}</td>
                      <td :class="structureCellClass">
                        <div class="flex flex-wrap items-center gap-1">
                          <span class="font-mono font-medium">{{ part.name }}</span>
                          <Badge v-if="pendingRenameForPartition(part.name)" variant="secondary" class="font-mono"> -> {{ pendingRenameForPartition(part.name) }} </Badge>
                          <Badge v-if="isPartitionMarkedForSplit(part.name)" variant="outline">
                            {{ t("structureEditor.opengauss.pendingSplitBadge", "待拆分") }}
                          </Badge>
                          <Badge v-if="isPartitionMarkedForTruncate(part.name)" variant="outline">
                            {{ t("structureEditor.opengauss.pendingTruncateBadge", "待清空") }}
                          </Badge>
                          <Badge v-if="isPartitionMarkedForDrop(part.name)" variant="destructive">
                            {{ t("structureEditor.opengauss.pendingDropBadge", "待删除") }}
                          </Badge>
                        </div>
                      </td>
                      <td :class="[structureCellClass, 'font-mono text-muted-foreground']">{{ part.boundaryDisplay }}</td>
                      <td :class="[structureCellClass, 'font-mono text-muted-foreground']">{{ part.tablespace || "pg_default" }}</td>
                      <td :class="[structureCellClass, 'text-right font-mono text-muted-foreground']">
                        {{ part.estimatedRows !== null ? part.estimatedRows.toLocaleString() : "—" }}
                      </td>
                      <td :class="[structureCellClass, 'text-right font-mono text-muted-foreground']">
                        {{ formatByteSize(part.sizeBytes) }}
                      </td>
                      <td v-if="originalOpenGaussPartitions.subpartitionCount > 0" :class="[structureCellClass, 'text-right font-mono text-muted-foreground']">
                        {{ part.subpartitionCount }}
                      </td>
                      <td :class="[structureLastCellClass, 'text-right']">
                        <div class="inline-flex items-center justify-end gap-0.5">
                          <Button variant="ghost" size="sm" :class="structureToolbarButtonClass" :title="t('structureEditor.opengauss.renamePartition', '重命名分区')" @click="queueOrFocusRenamePartitionOp(part.name)">
                            <Pencil :class="structureIconClass" />
                            {{ t("structureEditor.opengauss.renameShort", "重命名") }}
                          </Button>

                          <Tooltip>
                            <TooltipTrigger as-child>
                              <span class="inline-flex">
                                <Button variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="!canSplitOpenGaussPartition" :title="t('structureEditor.opengauss.splitPartition', '拆分分区')" @click="queueOrFocusSplitPartitionOp(part.name)">
                                  <Split :class="structureIconClass" />
                                  {{ t("structureEditor.opengauss.splitShort", "拆分") }}
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent v-if="!canSplitOpenGaussPartition">
                              {{ t("structureEditor.opengauss.splitUnsupportedTooltip", "SPLIT PARTITION 仅支持行存 RANGE / INTERVAL 分区表") }}
                            </TooltipContent>
                          </Tooltip>

                          <Button variant="ghost" size="sm" :class="structureToolbarButtonClass" :title="t('structureEditor.opengauss.truncatePartition', '清空分区数据')" @click="toggleTruncatePartitionOp(part.name)">
                            <Eraser :class="structureIconClass" />
                            {{ isPartitionMarkedForTruncate(part.name) ? t("structureEditor.restore") : t("structureEditor.opengauss.truncateShort", "清空") }}
                          </Button>

                          <Button variant="ghost" size="sm" :class="structureToolbarButtonClass" :title="t('structureEditor.opengauss.dropPartition', '删除分区')" @click="toggleDropPartitionOp(part.name)">
                            <RefreshCw v-if="isPartitionMarkedForDrop(part.name)" :class="structureIconClass" />
                            <Trash2 v-else :class="structureIconClass" />
                            {{ isPartitionMarkedForDrop(part.name) ? t("structureEditor.restore") : t("structureEditor.drop") }}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Pending Partition Operations Queue -->
              <div v-if="openGaussPartitions.pendingOps.length > 0" class="rounded-md border">
                <div class="flex items-center justify-between border-b bg-muted/20 px-[var(--structure-cell-px)] py-[var(--structure-header-py)]">
                  <div class="flex items-center gap-1.5 font-medium">
                    <span>{{ t("structureEditor.opengauss.pendingPartitionOps", "待执行的分区变更操作") }}</span>
                    <Badge variant="secondary">{{ openGaussPartitions.pendingOps.length }}</Badge>
                  </div>
                  <Button variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="clearPendingPartitionOps">
                    <X :class="structureIconClass" />
                    {{ t("structureEditor.opengauss.clearPendingOps", "清空队列") }}
                  </Button>
                </div>

                <div class="divide-y">
                  <div v-for="op in openGaussPartitions.pendingOps" :key="op.id" class="flex flex-wrap items-center gap-1.5 px-[var(--structure-cell-px)] py-[var(--structure-cell-py)]">
                    <Badge variant="outline" class="font-mono uppercase">{{ op.type }}</Badge>

                    <template v-if="op.type === 'add'">
                      <Input v-model="op.partitionName" :class="[structureMonoControlClass, 'w-40']" :placeholder="t('structureEditor.opengauss.partitionNamePlaceholder', '分区名')" />
                      <Input
                        v-model="op.boundary"
                        :class="[structureMonoControlClass, 'min-w-[200px] flex-1']"
                        :placeholder="originalOpenGaussPartitions.strategy === 'list' ? t('structureEditor.opengauss.listBoundaryPlaceholder', 'VALUES，如 \'BJ\', \'SH\' 或 DEFAULT') : t('structureEditor.opengauss.rangeBoundaryPlaceholder', 'VALUES LESS THAN，如 \'2027-01-01\' 或 MAXVALUE')"
                      />
                      <Input v-model="op.tablespace" :class="[structureMonoControlClass, 'w-36']" :placeholder="t('structureEditor.opengauss.tablespaceOptionalPlaceholder', '表空间（可选）')" />
                    </template>

                    <template v-else-if="op.type === 'split'">
                      <span class="font-mono text-muted-foreground">{{ op.partitionName }}</span>
                      <span class="text-muted-foreground">AT</span>
                      <Input v-model="op.atValue" :class="[structureMonoControlClass, 'w-40']" :placeholder="t('structureEditor.opengauss.splitAtPlaceholder', '拆分点，如 \'2026-07-01\'')" />
                      <span class="text-muted-foreground">INTO</span>
                      <Input v-model="op.firstPartitionName" :class="[structureMonoControlClass, 'w-36']" :placeholder="t('structureEditor.opengauss.splitPart1Placeholder', '子分区 1')" />
                      <Input v-model="op.secondPartitionName" :class="[structureMonoControlClass, 'w-36']" :placeholder="t('structureEditor.opengauss.splitPart2Placeholder', '子分区 2')" />
                    </template>

                    <template v-else-if="op.type === 'rename'">
                      <span class="font-mono text-muted-foreground">{{ op.partitionName }}</span>
                      <span class="text-muted-foreground">TO</span>
                      <Input v-model="op.newPartitionName" :class="[structureMonoControlClass, 'w-48']" :placeholder="t('structureEditor.opengauss.newPartitionNamePlaceholder', '新分区名')" />
                    </template>

                    <template v-else-if="op.type === 'truncate'">
                      <span class="font-mono">{{ op.partitionName }}</span>
                      <span class="text-muted-foreground">({{ t("structureEditor.opengauss.truncatePartitionDesc", "清空该分区全部数据，保留分区结构") }})</span>
                    </template>

                    <template v-else-if="op.type === 'drop'">
                      <span class="font-mono text-destructive">{{ op.partitionName }}</span>
                      <span class="text-muted-foreground">({{ t("structureEditor.opengauss.dropPartitionDesc", "删除该分区及其全部数据") }})</span>
                    </template>

                    <div class="ml-auto">
                      <Button variant="ghost" size="icon" :class="structureActionButtonClass" :title="t('structureEditor.remove')" @click="removePendingPartitionOp(op.id)">
                        <X :class="structureIconClass" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent ref="optionsScrollerRef" v-if="tableMetadataCapabilities.options" value="options" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('options', $event)">
            <div v-if="openGaussOptionsLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>

            <!-- Create Mode: Full openGauss Storage & Engine Options -->
            <div v-else-if="isCreateMode" class="grid max-w-3xl grid-cols-1 gap-3 md:grid-cols-2">
              <div class="space-y-1 rounded-md border p-[var(--structure-cell-px)]">
                <label class="block font-medium">{{ t("structureEditor.opengauss.orientationLabel", "存储方向 (ORIENTATION)") }}</label>
                <Select :model-value="openGaussOptions.orientation" @update:model-value="onOpenGaussOrientationChange">
                  <SelectTrigger class="h-[var(--structure-control-height)] w-full rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="row">{{ t("structureEditor.opengauss.orientationRow", "ROW（行存表，适合 OLTP 点查与事务）") }}</SelectItem>
                    <SelectItem value="column">{{ t("structureEditor.opengauss.orientationColumn", "COLUMN（列存表，适合 OLAP 批量分析）") }}</SelectItem>
                  </SelectContent>
                </Select>
                <p class="text-xs text-muted-foreground">{{ t("structureEditor.opengauss.orientationHint", "行列存方式仅可在建表时指定，建表后不可修改。") }}</p>
              </div>

              <div class="space-y-1 rounded-md border p-[var(--structure-cell-px)]">
                <label class="block font-medium">{{ t("structureEditor.opengauss.storageTypeLabel", "存储引擎 (STORAGE_TYPE)") }}</label>
                <Select :model-value="openGaussOptions.storageType" :disabled="openGaussOptions.orientation === 'column'" @update:model-value="onOpenGaussStorageTypeChange">
                  <SelectTrigger class="h-[var(--structure-control-height)] w-full rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="astore">{{ t("structureEditor.opengauss.storageTypeAstore", "ASTORE（追加写存储引擎，默认）") }}</SelectItem>
                    <SelectItem value="ustore">{{ t("structureEditor.opengauss.storageTypeUstore", "USTORE（原位更新存储引擎，适合高频更新）") }}</SelectItem>
                  </SelectContent>
                </Select>
                <p class="text-xs text-muted-foreground">{{ t("structureEditor.opengauss.storageTypeHint", "USTORE 原位更新引擎仅支持行存表 (orientation = row)。") }}</p>
              </div>

              <div class="space-y-1 rounded-md border p-[var(--structure-cell-px)]">
                <label class="block font-medium">{{ t("structureEditor.opengauss.compressionLabel", "数据压缩 (COMPRESSION)") }}</label>
                <Select :model-value="openGaussOptions.compression" @update:model-value="onOpenGaussCompressionChange">
                  <SelectTrigger class="h-[var(--structure-control-height)] w-full rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="opt in openGaussCompressionOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</SelectItem>
                  </SelectContent>
                </Select>
                <p class="text-xs text-muted-foreground">{{ t("structureEditor.opengauss.compressionHint", "列存表支持 low / middle / high 多级压缩；行存表支持 no / yes。") }}</p>
              </div>

              <div class="space-y-1 rounded-md border p-[var(--structure-cell-px)]">
                <div class="flex items-center justify-between">
                  <label class="block font-medium">{{ t("structureEditor.opengauss.fillfactorLabel", "填充因子 (FILLFACTOR)") }}</label>
                  <Button v-if="openGaussOptions.fillfactor !== null" variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="resetOpenGaussFillfactor">
                    {{ t("structureEditor.opengauss.resetFillfactor", "重置默认") }}
                  </Button>
                </div>
                <Input
                  :model-value="openGaussOptions.fillfactor?.toString() ?? ''"
                  type="number"
                  min="10"
                  max="100"
                  :class="structureMonoControlClass"
                  :disabled="openGaussOptions.orientation === 'column'"
                  :placeholder="t('structureEditor.opengauss.fillfactorPlaceholder', '默认 (100)，范围 10-100')"
                  @update:model-value="onOpenGaussFillfactorInput"
                />
                <p class="text-xs text-muted-foreground">{{ t("structureEditor.opengauss.fillfactorHint", "预留页面空间比例以减少 UPDATE 跨页迁移，仅对行存表生效。") }}</p>
              </div>

              <div class="space-y-1 rounded-md border p-[var(--structure-cell-px)] md:col-span-2">
                <label class="block font-medium">{{ t("structureEditor.opengauss.tablespaceLabel", "表空间 (TABLESPACE)") }}</label>
                <Input v-model="openGaussOptions.tablespace" :class="structureMonoControlClass" :placeholder="t('structureEditor.opengauss.tablespacePlaceholder', '留空使用默认表空间 (pg_default)')" />
              </div>
            </div>

            <!-- Edit Mode: Read-only Engine Badges + Mutable Fillfactor & Row Movement -->
            <div v-else class="max-w-3xl space-y-3">
              <div class="space-y-2 rounded-md border bg-muted/15 p-[var(--structure-cell-px)]">
                <div class="flex flex-wrap items-center gap-1.5">
                  <Badge>{{ (originalOpenGaussOptions?.orientation ?? "row").toUpperCase() }}</Badge>
                  <Badge v-if="(originalOpenGaussOptions?.orientation ?? 'row') === 'row'" variant="secondary">
                    {{ (originalOpenGaussOptions?.storageType ?? "astore").toUpperCase() }}
                  </Badge>
                  <Badge variant="outline" class="font-mono"> COMPRESSION={{ (originalOpenGaussOptions?.compression ?? "no").toUpperCase() }} </Badge>
                  <Badge v-if="originalOpenGaussOptions?.tablespace" variant="outline" class="font-mono"> TABLESPACE={{ originalOpenGaussOptions.tablespace }} </Badge>
                </div>
                <div class="flex items-start gap-1.5 text-muted-foreground">
                  <Info :class="[structureIconClass, 'mt-0.5 shrink-0']" />
                  <span>{{ t("structureEditor.opengauss.immutableStorageHint", "openGauss 的行列存方向 (ORIENTATION)、存储引擎 (ASTORE/USTORE) 与压缩级别需在建表 (CREATE TABLE) 时指定，建表后不支持原地修改。") }}</span>
                </div>
              </div>

              <div class="space-y-1.5 rounded-md border p-[var(--structure-cell-px)]">
                <div class="flex items-center justify-between gap-2">
                  <label class="font-medium">{{ t("structureEditor.opengauss.fillfactorLabel", "填充因子 (FILLFACTOR)") }}</label>
                  <Button v-if="openGaussOptions.fillfactor !== null" variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="resetOpenGaussFillfactor">
                    {{ t("structureEditor.opengauss.resetFillfactor", "重置默认 (RESET)") }}
                  </Button>
                </div>
                <Input
                  :model-value="openGaussOptions.fillfactor?.toString() ?? ''"
                  type="number"
                  min="10"
                  max="100"
                  :class="[structureMonoControlClass, 'max-w-xs']"
                  :disabled="originalOpenGaussOptions?.orientation === 'column'"
                  :placeholder="t('structureEditor.opengauss.fillfactorPlaceholder', '默认 (100)，范围 10-100')"
                  @update:model-value="onOpenGaussFillfactorInput"
                />
                <p class="text-xs text-muted-foreground">{{ t("structureEditor.opengauss.fillfactorEditHint", "修改后将生成 ALTER TABLE ... SET (fillfactor = ...) 或 RESET (fillfactor)。") }}</p>
              </div>

              <div v-if="originalOpenGaussPartitions" class="space-y-1 rounded-md border p-[var(--structure-cell-px)]">
                <label class="flex cursor-pointer items-center gap-2 font-medium">
                  <input v-model="openGaussOptions.enableRowMovement" type="checkbox" :class="structureCheckboxClass" />
                  <span>{{ t("structureEditor.opengauss.enableRowMovement", "允许跨分区行迁移 (ENABLE ROW MOVEMENT)") }}</span>
                </label>
                <p class="text-xs text-muted-foreground">
                  {{ t("structureEditor.opengauss.enableRowMovementHint", "开启后更新分区键导致数据跨越分区边界时，openGauss 将自动把行迁移至目标分区。") }}
                </p>
              </div>
            </div>
          </TabsContent>

          <TabsContent ref="triggersScrollerRef" v-if="tableMetadataCapabilities.triggers" value="triggers" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('triggers', $event)">
            <div v-if="triggersLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="triggers.length === 0" class="py-10 text-center text-muted-foreground">
              {{ t("structureEditor.emptyReadonly") }}
            </div>
            <div v-else class="space-y-1.5">
              <div v-for="trigger in triggers" :key="trigger.id" class="rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]" :class="trigger.markedForDrop ? 'bg-destructive/5 opacity-60' : ''">
                <div class="grid grid-cols-[minmax(140px,1fr)_minmax(130px,180px)_minmax(140px,1fr)_auto] gap-1.5">
                  <Input v-model="trigger.name" :class="structureControlClass" :placeholder="t('structureEditor.triggerName')" :disabled="!canEditTriggerDraft(trigger)" />
                  <Input v-if="isOracleTriggerEditor" v-model="trigger.timing" :class="structureControlClass" :disabled="!canEditTriggerDraft(trigger)" />
                  <Select v-else v-model="trigger.timing" :disabled="!canEditTriggerDraft(trigger)">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="timing in triggerTimingOptions" :key="timing" :value="timing">{{ timing }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input v-if="isOracleTriggerEditor" v-model="trigger.event" :class="structureControlClass" :disabled="!canEditTriggerDraft(trigger)" />
                  <Select v-else v-model="trigger.event" :disabled="!canEditTriggerDraft(trigger)">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="event in triggerEventOptions" :key="event" :value="event">{{ event }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <div class="flex items-center justify-end gap-1">
                    <Button v-if="trigger.original" variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="toggleDropTrigger(trigger)">
                      <Trash2 :class="structureIconClass" />
                      {{ trigger.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop") }}
                    </Button>
                    <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="removeNewTrigger(trigger)">
                      <X :class="structureIconClass" />
                      {{ t("structureEditor.remove") }}
                    </Button>
                  </div>
                </div>
                <textarea
                  v-model="trigger.statement"
                  class="mt-1.5 min-h-28 w-full resize-y rounded-[6px] border bg-background px-[var(--structure-control-px)] py-[var(--structure-cell-py)] font-mono text-[length:var(--structure-font-size)] leading-5 outline-none focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
                  :placeholder="t('structureEditor.triggerStatement')"
                  :disabled="!canEditTriggerDraft(trigger)"
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent ref="ddlScrollerRef" v-if="tableMetadataCapabilities.ddl" value="ddl" class="relative m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('ddl', $event)">
            <div v-if="ddlLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <template v-else>
              <Button v-if="ddlContent" variant="outline" size="sm" class="absolute right-3 top-3 z-10 h-7 gap-1 px-2" :title="t('grid.copyDdl')" @click="copyDdlContent">
                <Copy class="h-3.5 w-3.5" />
                {{ t("grid.copyDdl") }}
              </Button>
              <pre ref="ddlPreRef" tabindex="0" class="m-0 min-h-0 flex-1 whitespace-pre p-3 font-mono text-xs leading-5 select-text outline-none" v-html="ddlContent ? (sqlHighlighter?.(ddlContent) ?? ddlContent) : t('structureEditor.emptyReadonly')" @keydown="onDdlKeydown"></pre>
            </template>
          </TabsContent>
        </Tabs>
      </div>

      <div :class="['flex min-w-0 shrink-0 flex-col overflow-hidden rounded-md border', sqlPreviewCollapsed ? '' : 'h-[28%] min-h-40 max-h-64']">
        <div class="flex shrink-0 items-center justify-between border-b px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)] font-medium">
          <div class="flex items-center gap-1.5">
            <span>{{ t("structureEditor.sqlPreview") }}</span>
            <Badge v-if="!saving && pendingStatements.length && warnings.length === 0" variant="outline" class="h-4 px-1 text-[10px]">
              <Check class="h-3 w-3" />
              {{ t("structureEditor.ready") }}
            </Badge>
          </div>
          <div class="flex items-center gap-1.5">
            <Button
              variant="ghost"
              :class="structureIconButtonClass"
              :aria-label="sqlPreviewCollapsed ? t('structureEditor.expandSqlPreview') : t('structureEditor.collapseSqlPreview')"
              :title="sqlPreviewCollapsed ? t('structureEditor.expandSqlPreview') : t('structureEditor.collapseSqlPreview')"
              @click="toggleSqlPreviewCollapsed"
            >
              <ChevronUp v-if="sqlPreviewCollapsed" :class="structureIconClass" />
              <ChevronDown v-else :class="structureIconClass" />
            </Button>
            <Button variant="ghost" :class="structureToolbarButtonClass" :disabled="!previewSqlText.trim()" @click="copyPreviewSql">
              <Copy :class="[structureIconClass, 'mr-1']" />
              {{ t("structureEditor.copySql") }}
            </Button>
            <Badge variant="secondary">
              <Loader2 v-if="sqlPreviewLoading" class="h-3 w-3 animate-spin" />
              <span v-else>{{ pendingStatements.length }}</span>
            </Badge>
          </div>
        </div>
        <div v-if="!sqlPreviewCollapsed" class="min-h-0 flex-1 overflow-auto p-2.5">
          <div v-if="warnings.length" class="mb-2 space-y-1">
            <div v-for="warning in warnings" :key="warning" class="flex gap-1.5 rounded-md border border-yellow-300/40 bg-yellow-500/10 px-[var(--structure-cell-px)] py-[var(--structure-cell-py)] text-[length:var(--structure-font-size)] text-yellow-700 dark:text-yellow-300">
              <AlertTriangle :class="[structureIconClass, 'mt-0.5 shrink-0']" />
              <span>{{ warning }}</span>
            </div>
          </div>
          <pre v-if="pendingStatements.length" class="select-text whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2.5 font-mono text-[calc(var(--structure-font-size)+1px)] leading-5" v-html="highlightedSql" />
          <div v-else class="flex h-full items-center justify-center text-[length:var(--structure-font-size)] text-muted-foreground">
            {{ t("structureEditor.noChanges") }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="errorMessage" class="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)] text-destructive">
      {{ errorMessage }}
    </div>

    <div class="flex shrink-0 items-center justify-end gap-2">
      <Button :class="structureToolbarButtonClass" :disabled="!canApply" @click="applyChanges">
        <Loader2 v-if="saving" :class="[structureIconClass, 'mr-1.5 animate-spin']" />
        <Save v-else :class="[structureIconClass, 'mr-1.5']" />
        {{ t("structureEditor.apply") }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* --primary is rgb/oklch; use color-mix like DataGrid, not channel-based hsl wrappers. */
.structure-column-search-match > td:first-child {
  box-shadow: inset 3px 0 0 color-mix(in oklab, var(--primary) 55%, transparent);
}

.structure-column-search-current > td {
  background-color: color-mix(in oklab, var(--primary) 8%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, var(--primary) 55%, transparent),
    inset 0 -1px 0 color-mix(in oklab, var(--primary) 55%, transparent);
}

.structure-column-search-current > td:first-child {
  box-shadow:
    inset 3px 0 0 var(--primary),
    inset 0 1px 0 color-mix(in oklab, var(--primary) 55%, transparent),
    inset 0 -1px 0 color-mix(in oklab, var(--primary) 55%, transparent);
}

/* Inputs are bg-transparent; give them a solid surface on the selected row so fields stay readable. */
.structure-column-search-current :is(input, button, [role="combobox"], [data-slot="select-trigger"]) {
  background-color: var(--background);
}
</style>
