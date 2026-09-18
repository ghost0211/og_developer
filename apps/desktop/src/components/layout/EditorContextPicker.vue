<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ChevronDown, Database, Layers, Search, Star, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import TruncatedTextTooltip from "@/components/ui/TruncatedTextTooltip.vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import ProductionContextBadge from "@/components/common/ProductionContextBadge.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { useSchemaOptions } from "@/composables/useSchemaOptions";
import { connectionIconType } from "@/lib/connection/connectionPresentation";
import { formatDatabaseLabel, isDefaultDatabase } from "@/lib/database/defaultDatabase";
import { connectionDisplayName } from "@/lib/tabs/tabPresentation";
import { useConnectionGroupLabel } from "@/composables/useConnectionGroupLabel";
import { isSingleDatabase, supportsClearableQuerySchema } from "@/lib/database/databaseCapabilities";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { filterDatabaseOptions } from "@/lib/database/databaseOptionSearch";
import { cn } from "@/lib/common/utils";
import type { QueryTab, ConnectionConfig } from "@/types/database";

type RowKind = "database" | "schema" | "connection";
interface PickerRow {
  kind: RowKind;
  value: string;
  label: string;
}

const props = defineProps<{
  activeTab: QueryTab;
  activeConnection?: ConnectionConfig;
  databaseRequiredSignal?: number;
}>();

const emit = defineEmits<{
  changeConnection: [connectionId: string];
  changeDatabase: [database: string];
  changeSchema: [schema: string | undefined];
  setDefaultDatabase: [];
  clearDefaultDatabase: [];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const { databaseOptions, loadingDatabaseOptions, loadDatabaseOptions } = useDatabaseOptions();
const { loadSchemaOptions, getSchemaOptionsForDb, isLoadingSchemas, isSchemaAware } = useSchemaOptions();
const { connectionGroupLabel } = useConnectionGroupLabel();

const open = ref(false);
const searchText = ref("");
const searchInput = ref<InstanceType<typeof Input>>();
const listContainer = ref<HTMLDivElement>();
const highlightIndex = ref(-1);

const activeConnectionValue = computed(() => props.activeConnection?.id || "");
const activeDatabaseValue = computed(() => props.activeTab.database || "");
const activeSchemaValue = computed(() => props.activeTab.schema || "");
const isSingleDb = computed(() => isSingleDatabase(props.activeConnection?.db_type));

const activeDatabaseOptions = computed(() => {
  const connection = props.activeConnection;
  if (!connection) return [];
  return databaseOptions.value[connection.id] ?? [];
});
const loadingActiveDatabaseOptions = computed(() => {
  const connection = props.activeConnection;
  if (!connection) return false;
  return loadingDatabaseOptions.value[connection.id] ?? false;
});

const hasDefaultDatabaseOption = computed(() => activeDatabaseOptions.value.includes(""));
const schemaDatabaseKey = computed(() => props.activeTab.database || (isSingleDb.value ? "_" : ""));
const showSchemaSection = computed(() => {
  const connection = props.activeConnection;
  return !!connection && isSchemaAware(connection.id) && (!!props.activeTab.database || isSingleDb.value || hasDefaultDatabaseOption.value);
});
const activeSchemaOptions = computed(() => {
  const connection = props.activeConnection;
  if (!connection) return [];
  return getSchemaOptionsForDb(connection.id, schemaDatabaseKey.value);
});
const schemaSectionLoading = computed(() => {
  const connection = props.activeConnection;
  return !!connection && isLoadingSchemas(connection.id, schemaDatabaseKey.value);
});
const schemaClearable = computed(() => supportsClearableQuerySchema(props.activeConnection?.db_type));

const activeProductionContext = computed(() => productionContextForDatabase(props.activeConnection, props.activeTab.database));
const showConnectionProductionBadge = computed(() => activeProductionContext.value.reason === "connection");
const showDatabaseProductionBadge = computed(() => activeProductionContext.value.reason === "database");
const isActiveDatabaseDefault = computed(() => isDefaultDatabase(props.activeConnection, activeDatabaseValue.value));

function databaseDisplayName(database: string): string {
  return formatDatabaseLabel(props.activeConnection, database, {
    defaultDatabase: t("editor.defaultDatabase"),
    noDatabase: t("editor.noDatabase"),
  });
}

function connectionById(connectionId: string): ConnectionConfig | undefined {
  return connectionStore.getConfig(connectionId);
}

function databaseOptionIsProduction(database: string): boolean {
  if (!database || props.activeConnection?.is_production) return false;
  return productionContextForDatabase(props.activeConnection, database).reason === "database";
}

const databaseRows = computed<PickerRow[]>(() => {
  if (!props.activeConnection || isSingleDb.value) return [];
  const options = activeDatabaseOptions.value.length ? activeDatabaseOptions.value : activeDatabaseValue.value ? [activeDatabaseValue.value] : [];
  return filterDatabaseOptions(options, searchText.value, databaseDisplayName).map((value) => ({
    kind: "database",
    value,
    label: databaseDisplayName(value),
  }));
});

const schemaRows = computed<PickerRow[]>(() => {
  if (!showSchemaSection.value) return [];
  const options = activeSchemaOptions.value.length ? activeSchemaOptions.value : activeSchemaValue.value ? [activeSchemaValue.value] : [];
  return filterDatabaseOptions(options, searchText.value, (value) => value).map((value) => ({ kind: "schema", value, label: value }));
});

const connectionRows = computed<PickerRow[]>(() =>
  filterDatabaseOptions(
    connectionStore.connections.map((connection) => connection.id),
    searchText.value,
    connectionDisplayName,
  ).map((value) => ({ kind: "connection", value, label: connectionDisplayName(value) })),
);

const flatRows = computed<PickerRow[]>(() => [...databaseRows.value, ...schemaRows.value, ...connectionRows.value]);

const showFooter = computed(() => !!props.activeConnection && !isSingleDb.value && !!activeDatabaseValue.value);

const triggerTitle = computed(() => {
  const parts = [props.activeConnection ? connectionDisplayName(props.activeConnection.id) : t("editor.selectConnection")];
  if (activeDatabaseValue.value) parts.push(databaseDisplayName(activeDatabaseValue.value));
  if (activeSchemaValue.value) parts.push(activeSchemaValue.value);
  return parts.join(" / ");
});

function rowIsCurrent(row: PickerRow): boolean {
  if (row.kind === "connection") return row.value === activeConnectionValue.value;
  if (row.kind === "database") return row.value === activeDatabaseValue.value;
  return row.value === activeSchemaValue.value;
}

function pick(row: PickerRow) {
  if (row.kind === "connection") {
    if (row.value !== activeConnectionValue.value) emit("changeConnection", row.value);
  } else if (row.kind === "database") {
    if (row.value !== activeDatabaseValue.value) emit("changeDatabase", row.value);
  } else if (row.value === activeSchemaValue.value && schemaClearable.value) {
    emit("changeSchema", undefined);
  } else if (row.value !== activeSchemaValue.value) {
    emit("changeSchema", row.value);
  }
  open.value = false;
}

function clearDatabaseSelection() {
  emit("changeDatabase", "");
}

function toggleDefaultDatabase() {
  if (isActiveDatabaseDefault.value) {
    emit("clearDefaultDatabase");
  } else {
    emit("setDefaultDatabase");
  }
}

const databaseRequiredVisible = ref(false);
watch(
  () => props.databaseRequiredSignal,
  (signal) => {
    if (!signal) return;
    databaseRequiredVisible.value = false;
    requestAnimationFrame(() => {
      databaseRequiredVisible.value = true;
    });
  },
);
watch(activeDatabaseValue, (database) => {
  if (database) databaseRequiredVisible.value = false;
});

watch(open, async (value) => {
  if (!value) {
    searchText.value = "";
    highlightIndex.value = -1;
    return;
  }
  const connection = props.activeConnection;
  if (connection) {
    if (!isSingleDb.value) loadDatabaseOptions(connection.id).catch(() => {});
    if (showSchemaSection.value) loadSchemaOptions(connection.id, schemaDatabaseKey.value).catch(() => {});
  }
  await nextTick();
  const input = searchInput.value?.$el as HTMLInputElement | undefined;
  input?.focus();
  const currentIndex = flatRows.value.findIndex(rowIsCurrent);
  highlightIndex.value = currentIndex >= 0 ? currentIndex : flatRows.value.length ? 0 : -1;
  await nextTick();
  scrollHighlightedRowIntoView();
});

watch(searchText, () => {
  highlightIndex.value = flatRows.value.length ? 0 : -1;
});

watch([highlightIndex, flatRows], () => {
  void scrollHighlightedRowIntoView();
});

async function scrollHighlightedRowIntoView() {
  await nextTick();
  const container = listContainer.value;
  if (!container || highlightIndex.value < 0) return;
  const buttons = container.querySelectorAll("button[data-picker-row]");
  buttons[highlightIndex.value]?.scrollIntoView({ block: "nearest" });
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    const total = flatRows.value.length;
    if (total === 0) return;
    highlightIndex.value = highlightIndex.value < total - 1 ? highlightIndex.value + 1 : 0;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    const total = flatRows.value.length;
    if (total === 0) return;
    highlightIndex.value = highlightIndex.value > 0 ? highlightIndex.value - 1 : total - 1;
  } else if (event.key === "Enter") {
    if (highlightIndex.value < 0 || highlightIndex.value >= flatRows.value.length) return;
    event.preventDefault();
    pick(flatRows.value[highlightIndex.value]);
  } else if (event.key === "Escape") {
    open.value = false;
  }
}
</script>

<template>
  <div :class="{ 'context-picker-required-prompt': databaseRequiredVisible }">
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <Button type="button" variant="ghost" :title="triggerTitle" class="h-6 w-auto max-w-80 min-w-0 justify-between gap-1 border-0 bg-transparent px-1 text-xs font-normal shadow-none hover:bg-muted/50 focus-visible:ring-0">
          <span v-if="activeConnection?.color" class="h-4 w-1 shrink-0 rounded-full" :style="{ backgroundColor: activeConnection.color }" />
          <template v-if="activeConnection">
            <DatabaseIcon :db-type="connectionIconType(activeConnection)" class="h-3.5 w-3.5 shrink-0" />
            <span class="max-w-40 truncate font-medium text-foreground">{{ connectionDisplayName(activeConnection.id) }}</span>
            <ProductionContextBadge v-if="showConnectionProductionBadge" compact />
            <template v-if="activeDatabaseValue">
              <span class="shrink-0 text-muted-foreground/60">/</span>
              <Database class="h-3 w-3 shrink-0 text-muted-foreground" />
              <span class="max-w-28 truncate text-muted-foreground">{{ databaseDisplayName(activeDatabaseValue) }}</span>
              <ProductionContextBadge v-if="showDatabaseProductionBadge" compact />
            </template>
            <template v-if="activeSchemaValue">
              <span class="shrink-0 text-muted-foreground/60">/</span>
              <Layers class="h-3 w-3 shrink-0 text-muted-foreground" />
              <span class="max-w-24 truncate text-muted-foreground">{{ activeSchemaValue }}</span>
            </template>
          </template>
          <span v-else class="truncate text-muted-foreground">{{ t("editor.selectConnection") }}</span>
          <ChevronDown class="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" class="w-auto max-w-[calc(100vw-1rem)] border-0 bg-transparent p-0 shadow-none ring-0">
        <div class="w-80 shrink-0 rounded-md border bg-popover p-1.5 shadow-md">
          <div class="relative rounded-md border bg-background">
            <Search class="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <span v-if="!searchText" class="pointer-events-none absolute left-[25px] top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{{ t("editor.searchContext") }}</span>
            <Input ref="searchInput" :model-value="searchText" class="h-6 border-0 pl-6 pr-2 text-sm caret-foreground shadow-none focus-visible:ring-0" @update:model-value="(value) => (searchText = String(value))" @keydown="handleKeydown" />
          </div>
          <div ref="listContainer" class="ogdeveloper-context-picker-list max-h-72 overflow-y-auto py-1">
            <template v-if="databaseRows.length || loadingActiveDatabaseOptions">
              <div class="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{{ t("editor.contextDatabases") }}</div>
              <div v-if="loadingActiveDatabaseOptions" class="px-2 py-1.5 text-sm text-muted-foreground">{{ t("common.loading") }}</div>
              <template v-else>
                <button
                  v-for="row in databaseRows"
                  :key="`db:${row.value}`"
                  type="button"
                  data-picker-row
                  :title="row.label"
                  :class="cn('group flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none', rowIsCurrent(row) && 'font-medium')"
                  @click="pick(row)"
                >
                  <Check :class="cn('h-3.5 w-3.5 shrink-0', rowIsCurrent(row) ? 'opacity-100' : 'opacity-0')" />
                  <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
                  <ProductionContextBadge v-if="databaseOptionIsProduction(row.value)" compact />
                </button>
              </template>
            </template>
            <template v-if="schemaRows.length || schemaSectionLoading">
              <div class="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{{ t("editor.contextSchemas") }}</div>
              <div v-if="schemaSectionLoading" class="px-2 py-1.5 text-sm text-muted-foreground">{{ t("common.loading") }}</div>
              <template v-else>
                <button
                  v-for="row in schemaRows"
                  :key="`schema:${row.value}`"
                  type="button"
                  data-picker-row
                  :title="row.label"
                  :class="cn('group flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none', rowIsCurrent(row) && 'font-medium')"
                  @click="pick(row)"
                >
                  <span class="relative h-3.5 w-3.5 shrink-0">
                    <Check :class="cn('absolute inset-0 h-3.5 w-3.5', rowIsCurrent(row) ? (schemaClearable ? 'opacity-100 group-hover:opacity-0' : 'opacity-100') : 'opacity-0')" />
                    <X v-if="schemaClearable && rowIsCurrent(row)" class="absolute inset-0 h-3.5 w-3.5 opacity-0 group-hover:opacity-100" />
                  </span>
                  <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
                </button>
              </template>
            </template>
            <template v-if="connectionRows.length">
              <div class="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{{ t("editor.contextConnections") }}</div>
              <button
                v-for="row in connectionRows"
                :key="`conn:${row.value}`"
                type="button"
                data-picker-row
                :title="row.label"
                :class="cn('group flex min-h-9 h-auto w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none', rowIsCurrent(row) && 'font-medium')"
                @click="pick(row)"
              >
                <Check :class="cn('h-3.5 w-3.5 shrink-0 self-start mt-0.5', rowIsCurrent(row) ? 'opacity-100' : 'opacity-0')" />
                <DatabaseIcon :db-type="connectionIconType(connectionById(row.value))" class="h-3.5 w-3.5 shrink-0 self-start mt-0.5" />
                <div class="flex min-w-0 flex-1 items-center gap-2">
                  <span class="block min-w-0 max-w-48 shrink-0 whitespace-normal break-words rounded-sm bg-muted/70 px-1.5 py-0.5 text-[11px] leading-tight text-muted-foreground">
                    {{ connectionGroupLabel(row.value) }}
                  </span>
                  <TruncatedTextTooltip :text="row.label" class="block min-w-[7rem] flex-1 text-sm font-medium" side="left" :side-offset="8" />
                </div>
              </button>
            </template>
            <div v-if="!flatRows.length" class="px-2 py-2 text-sm text-muted-foreground">
              {{ t("grid.noSearchResults") }}
            </div>
          </div>
          <div v-if="showFooter" class="mt-1 flex items-center gap-1 border-t border-border/60 px-1 pt-1">
            <Button variant="ghost" size="sm" class="h-6 px-2 text-[11px]" @click="toggleDefaultDatabase">
              <Star class="h-3 w-3" :class="isActiveDatabaseDefault ? 'fill-amber-400 text-amber-500' : ''" />
              {{ isActiveDatabaseDefault ? t("editor.defaultDatabase") : t("editor.setDefaultDatabase") }}
            </Button>
            <Button variant="ghost" size="sm" class="ml-auto h-6 px-2 text-[11px] text-muted-foreground" @click="clearDatabaseSelection">
              <X class="h-3 w-3" />
              {{ t("editor.clearDatabase") }}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>

<style scoped>
.context-picker-required-prompt {
  color: var(--destructive);
  animation: context-picker-required-shake 420ms ease;
}

.context-picker-required-prompt :deep(button) {
  color: var(--destructive);
  border-color: color-mix(in oklch, var(--destructive) 55%, transparent);
  background: color-mix(in oklch, var(--destructive) 10%, transparent);
}

@keyframes context-picker-required-shake {
  0%,
  100% {
    transform: translateX(0);
  }
  12%,
  36%,
  60% {
    transform: translateX(-3px);
  }
  24%,
  48%,
  72% {
    transform: translateX(3px);
  }
}

.ogdeveloper-context-picker-list {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in oklch, var(--foreground) 30%, transparent) transparent;
}

.ogdeveloper-context-picker-list::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.ogdeveloper-context-picker-list::-webkit-scrollbar-track {
  background: transparent;
}

.ogdeveloper-context-picker-list::-webkit-scrollbar-thumb {
  border: 1px solid transparent;
  border-radius: 999px;
  background: color-mix(in oklch, var(--foreground) 30%, transparent);
  background-clip: padding-box;
}

.ogdeveloper-context-picker-list:hover::-webkit-scrollbar-thumb {
  border: 0;
  background: color-mix(in oklch, var(--foreground) 48%, transparent);
}
</style>
