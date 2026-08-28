<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronRight, Database, FileCode, FolderOpen, FolderSearch, Loader2, Search, TableProperties, X } from "@lucide/vue";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { supportsDatabaseSearch } from "@/lib/database/databaseFeatureSupport";
import { highlightMenuSearchText, menuSearchTextMatches } from "@/lib/search/menuSearchMatching";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { useQueryStore } from "@/stores/queryStore";
import type { ConnectionConfig, DatabaseType, TreeNode } from "@/types/database";

export type MenuSearchMode = "files" | "metadata" | "objects" | "data";
type MetadataTypeFilter = "ALL" | "TABLE" | "VIEW" | "ROUTINE" | "PACKAGE" | "COLUMN";
type SearchObjectTarget = { connectionId: string; database: string; schema: string; objectType: string; name: string; signature?: string };
type DataSearchTarget = { keyword: string; connectionId: string; database: string };
type SearchScopeTarget = { key: string; connection: ConnectionConfig; database: string };

const props = defineProps<{ open: boolean; mode: MenuSearchMode; preferredConnectionId?: string; preferredDatabase?: string }>();
const emit = defineEmits<{
  "update:open": [value: boolean];
  "open-file": [path: string];
  "open-object": [hit: SearchObjectTarget];
  "open-data-search": [target: DataSearchTarget];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const projectStore = useProjectStore();
const queryStore = useQueryStore();
const isDesktop = isTauriRuntime();
const dialogOpen = computed({ get: () => props.open, set: (value) => emit("update:open", value) });
const activeMode = ref<MenuSearchMode>(props.mode);
const query = ref("");
const root = ref("");
const searching = ref(false);
const error = ref("");
const caseSensitive = ref(false);
const wholeWord = ref(false);
const metadataTypeFilter = ref<MetadataTypeFilter>("ALL");
const selectedTargetKeys = ref<string[]>([]);
const runtimeSearchTargets = ref<Awaited<ReturnType<typeof api.listDatabaseSearchScopeTargets>>>([]);
const fileHits = ref<Awaited<ReturnType<typeof api.searchFiles>>>([]);
const metadataHits = ref<Awaited<ReturnType<typeof api.searchMetadata>>>([]);
const objectHits = ref<Awaited<ReturnType<typeof api.searchObjectDefinitions>>>([]);
const selectedIndex = ref(-1);
const searchInputRef = ref<HTMLInputElement | null>(null);
const resultsRef = ref<HTMLElement | null>(null);
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let searchRequestId = 0;
let scopeRequestId = 0;
let selectionRevision = 0;

const POSTGRES_SEARCH_TYPES = new Set<DatabaseType>(["postgres", "opengauss"]);

function connectionDatabase(connection: ConnectionConfig): string {
  return resolveDefaultDatabase(connection, []);
}

function searchTargetKey(connectionId: string, database: string): string {
  return `${connectionId}\u0000${database}`;
}

function collectTreeDatabases(nodes: TreeNode[], connectionId: string, databases: Set<string>) {
  for (const node of nodes) {
    if (node.connectionId === connectionId && node.type === "database" && node.database) databases.add(node.database);
    if (node.children?.length) collectTreeDatabases(node.children, connectionId, databases);
  }
}

const scopeTargets = computed<SearchScopeTarget[]>(() => {
  const targets: SearchScopeTarget[] = [];
  for (const connection of connectionStore.connections) {
    if (activeMode.value === "data" ? !supportsDatabaseSearch(connection.db_type) : !POSTGRES_SEARCH_TYPES.has(connection.db_type)) continue;
    const databases = new Set<string>();
    for (const target of runtimeSearchTargets.value) {
      if (target.connectionId === connection.id && target.database) databases.add(target.database);
    }
    collectTreeDatabases(connectionStore.treeNodes, connection.id, databases);
    const configuredDatabase = connectionDatabase(connection);
    if (configuredDatabase) databases.add(configuredDatabase);
    for (const tab of queryStore.tabs) {
      if (tab.connectionId === connection.id && tab.database) databases.add(tab.database);
    }
    if (props.preferredConnectionId === connection.id && props.preferredDatabase) databases.add(props.preferredDatabase);
    if (databases.size === 0 && activeMode.value !== "data") databases.add("");
    for (const database of databases) {
      targets.push({ key: searchTargetKey(connection.id, database), connection, database });
    }
  }
  return targets;
});
const selectedScopeTargets = computed(() => scopeTargets.value.filter((target) => selectedTargetKeys.value.includes(target.key)));
const selectedScopeSummary = computed(() => {
  if (selectedScopeTargets.value.length === 0) return t("searchCenter.selectConnections");
  if (selectedScopeTargets.value.length > 1) return t("searchCenter.selectedConnections", { count: selectedScopeTargets.value.length });
  const target = selectedScopeTargets.value[0]!;
  return `${target.connection.name} · ${target.database || t("searchCenter.allConnectedDatabases")} · ${target.connection.username || "—"}`;
});
const matchOptions = computed(() => ({ caseSensitive: caseSensitive.value, wholeWord: wholeWord.value }));
const filteredFileHits = computed(() => fileHits.value.filter((hit) => menuSearchTextMatches(`${hit.relative}\n${hit.path}`, query.value, matchOptions.value)));
const filteredObjectHits = computed(() => objectHits.value.filter((hit) => menuSearchTextMatches(`${hit.schema}.${hit.name}\n${hit.snippet}`, query.value, matchOptions.value)));
const filteredMetadataHits = computed(() =>
  metadataHits.value.filter((hit) => {
    const objectType = hit.object_type.toUpperCase();
    const typeMatches =
      metadataTypeFilter.value === "ALL" ||
      (metadataTypeFilter.value === "ROUTINE" && (objectType.includes("PROCEDURE") || objectType.includes("FUNCTION"))) ||
      (metadataTypeFilter.value === "PACKAGE" && objectType.includes("PACKAGE")) ||
      (metadataTypeFilter.value !== "ROUTINE" && metadataTypeFilter.value !== "PACKAGE" && objectType.includes(metadataTypeFilter.value));
    return typeMatches && menuSearchTextMatches(`${hit.schema}.${hit.name}\n${hit.object_type}`, query.value, matchOptions.value);
  }),
);
const totalHitsCount = computed(() => {
  if (activeMode.value === "files") return filteredFileHits.value.length;
  if (activeMode.value === "metadata") return filteredMetadataHits.value.length;
  if (activeMode.value === "objects") return filteredObjectHits.value.length;
  return 0;
});
const canSubmit = computed(() => Boolean(query.value.trim()) && !searching.value && (activeMode.value === "files" ? Boolean(root.value) : selectedTargetKeys.value.length > 0));

function clearDebounce() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = undefined;
}

function resetResults() {
  fileHits.value = [];
  metadataHits.value = [];
  objectHits.value = [];
  selectedIndex.value = -1;
}

function resetConnectionSelection() {
  const preferredKey = props.preferredConnectionId ? searchTargetKey(props.preferredConnectionId, props.preferredDatabase || "") : "";
  const activeConnectionTarget = scopeTargets.value.find((target) => target.connection.id === connectionStore.activeConnectionId);
  const target = scopeTargets.value.find((candidate) => candidate.key === preferredKey) || activeConnectionTarget || scopeTargets.value[0];
  selectedTargetKeys.value = target ? [target.key] : [];
}

function toggleConnection(targetKey: string) {
  selectionRevision += 1;
  if (activeMode.value === "data") {
    selectedTargetKeys.value = [targetKey];
    return;
  }
  const selected = new Set(selectedTargetKeys.value);
  if (selected.has(targetKey)) selected.delete(targetKey);
  else selected.add(targetKey);
  selectedTargetKeys.value = [...selected];
}

function selectAllConnections() {
  selectionRevision += 1;
  selectedTargetKeys.value = scopeTargets.value.map((target) => target.key);
}

function clearConnectionSelection() {
  selectionRevision += 1;
  selectedTargetKeys.value = [];
}

async function refreshRuntimeSearchTargets() {
  const requestId = ++scopeRequestId;
  const initialSelectionRevision = selectionRevision;
  try {
    const targets = await api.listDatabaseSearchScopeTargets();
    if (!props.open || requestId !== scopeRequestId) return;
    runtimeSearchTargets.value = targets;
    if (initialSelectionRevision === selectionRevision) resetConnectionSelection();
  } catch {
    if (props.open && requestId === scopeRequestId) runtimeSearchTargets.value = [];
  }
}

watch(
  () => props.open,
  (open) => {
    searchRequestId += 1;
    scopeRequestId += 1;
    clearDebounce();
    if (!open) return;
    activeMode.value = props.mode;
    query.value = "";
    root.value = projectStore.defaultSearchRoot() ?? "";
    error.value = "";
    caseSensitive.value = false;
    wholeWord.value = false;
    metadataTypeFilter.value = "ALL";
    searching.value = false;
    resetConnectionSelection();
    resetResults();
    void refreshRuntimeSearchTargets();
    void nextTick(() => searchInputRef.value?.focus());
  },
  { immediate: true },
);

watch(
  () => props.mode,
  (mode) => {
    if (props.open) activeMode.value = mode;
  },
);

watch(activeMode, (mode, previousMode) => {
  if (!props.open || mode === previousMode) return;
  const sharesMultiTargetScope = (mode === "objects" || mode === "metadata") && (previousMode === "objects" || previousMode === "metadata");
  if (sharesMultiTargetScope) {
    const availableKeys = new Set(scopeTargets.value.map((target) => target.key));
    selectedTargetKeys.value = selectedTargetKeys.value.filter((key) => availableKeys.has(key));
    if (selectedTargetKeys.value.length === 0) resetConnectionSelection();
  } else {
    resetConnectionSelection();
  }
  resetResults();
});

watch(
  () => selectedTargetKeys.value.join("\u0001"),
  () => resetResults(),
);

watch([query, activeMode, root, () => selectedTargetKeys.value.join("\u0001")], () => {
  selectedIndex.value = -1;
  clearDebounce();
  if (!props.open || activeMode.value === "data" || !query.value.trim()) {
    if (!query.value.trim()) resetResults();
    return;
  }
  if (activeMode.value === "files" && !root.value) return;
  debounceTimer = setTimeout(() => void runSearch(), 250);
});

watch([caseSensitive, wholeWord, metadataTypeFilter], () => {
  selectedIndex.value = -1;
});

onUnmounted(() => {
  searchRequestId += 1;
  scopeRequestId += 1;
  clearDebounce();
});

async function pickDirectory() {
  if (!isDesktop) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") root.value = selected;
  } catch (cause: any) {
    error.value = cause?.message || String(cause);
  }
}

async function runSearch() {
  const needle = query.value.trim();
  const mode = activeMode.value;
  const searchRoot = root.value;
  const searchTargets = selectedScopeTargets.value.map((target) => ({ connectionId: target.connection.id, database: target.database }));
  const targetKeys = [...selectedTargetKeys.value];
  if (!needle || mode === "data") return;
  if (mode === "files" && !searchRoot) {
    error.value = t("searchCenter.projectRequired");
    return;
  }
  if (mode !== "files" && searchTargets.length === 0) {
    error.value = t("searchCenter.connectionRequired");
    return;
  }

  clearDebounce();
  const requestId = ++searchRequestId;
  searching.value = true;
  error.value = "";
  try {
    if (mode === "files") {
      const hits = await api.searchFiles(searchRoot, needle, 500);
      if (requestId === searchRequestId && mode === activeMode.value && needle === query.value.trim()) fileHits.value = hits;
    } else {
      const connectionIds = [...new Set(searchTargets.map((target) => target.connectionId))];
      const connectionResults = await Promise.allSettled(connectionIds.map((connectionId) => connectionStore.ensureConnected(connectionId, { activate: false })));
      const searchableConnectionIds = new Set(connectionIds.filter((_, index) => connectionResults[index]?.status === "fulfilled"));
      const searchableTargets = searchTargets.filter((target) => searchableConnectionIds.has(target.connectionId));
      if (searchableTargets.length === 0) {
        const firstFailure = connectionResults.find((result) => result.status === "rejected");
        throw firstFailure?.status === "rejected" ? firstFailure.reason : new Error(t("searchCenter.connectionRequired"));
      }
      if (searchableConnectionIds.size < connectionIds.length) {
        error.value = t("searchCenter.partialConnectionFailure", { count: connectionIds.length - searchableConnectionIds.size });
      }
      const selectionIsCurrent = () => targetKeys.join("\u0001") === selectedTargetKeys.value.join("\u0001");
      if (mode === "metadata") {
        const hits = await api.searchMetadata(needle, 500, searchableTargets);
        if (requestId === searchRequestId && mode === activeMode.value && needle === query.value.trim() && selectionIsCurrent()) metadataHits.value = hits;
      } else {
        const hits = await api.searchObjectDefinitions(needle, 300, searchableTargets);
        if (requestId === searchRequestId && mode === activeMode.value && needle === query.value.trim() && selectionIsCurrent()) objectHits.value = hits;
      }
    }
  } catch (cause: any) {
    if (requestId === searchRequestId) error.value = cause?.message || String(cause);
  } finally {
    if (requestId === searchRequestId) searching.value = false;
  }
}

function submitCurrentMode() {
  if (activeMode.value === "data") triggerDataSearch();
  else void runSearch();
}

function selectMode(mode: MenuSearchMode) {
  activeMode.value = mode;
  selectedIndex.value = -1;
  void nextTick(() => searchInputRef.value?.focus());
}

function clearQuery() {
  query.value = "";
  error.value = "";
  resetResults();
  searchInputRef.value?.focus();
}

function openFile(path: string) {
  emit("open-file", path);
  dialogOpen.value = false;
}

function objectTarget(hit: { connection_id: string; database: string; schema: string; object_type: string; name: string; signature?: string | null }): SearchObjectTarget {
  return {
    connectionId: hit.connection_id,
    database: hit.database,
    schema: hit.schema,
    objectType: hit.object_type,
    name: hit.name,
    signature: hit.signature || undefined,
  };
}

function openMetadata(hit: Awaited<ReturnType<typeof api.searchMetadata>>[number]) {
  emit("open-object", objectTarget(hit));
  dialogOpen.value = false;
}

function openDefinition(hit: Awaited<ReturnType<typeof api.searchObjectDefinitions>>[number]) {
  emit("open-object", objectTarget(hit));
  dialogOpen.value = false;
}

function triggerDataSearch() {
  const keyword = query.value.trim();
  const target = selectedScopeTargets.value[0];
  if (!keyword || !target || !target.database) {
    error.value = t("searchCenter.connectionRequired");
    return;
  }
  const connection = target.connection;
  const database = target.database;
  emit("open-data-search", { keyword, connectionId: connection.id, database });
  dialogOpen.value = false;
}

function scrollSelectionIntoView() {
  void nextTick(() => resultsRef.value?.querySelector<HTMLElement>(`[data-search-result-index="${selectedIndex.value}"]`)?.scrollIntoView({ block: "nearest" }));
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("button")) return;
  if (event.key === "ArrowDown" && totalHitsCount.value > 0) {
    event.preventDefault();
    selectedIndex.value = (selectedIndex.value + 1) % totalHitsCount.value;
    scrollSelectionIntoView();
  } else if (event.key === "ArrowUp" && totalHitsCount.value > 0) {
    event.preventDefault();
    selectedIndex.value = (selectedIndex.value - 1 + totalHitsCount.value) % totalHitsCount.value;
    scrollSelectionIntoView();
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (selectedIndex.value >= 0) executeSelection(selectedIndex.value);
    else submitCurrentMode();
  }
}

function executeSelection(index: number) {
  if (activeMode.value === "files" && filteredFileHits.value[index]) openFile(filteredFileHits.value[index].path);
  else if (activeMode.value === "metadata" && filteredMetadataHits.value[index]) openMetadata(filteredMetadataHits.value[index]);
  else if (activeMode.value === "objects" && filteredObjectHits.value[index]) openDefinition(filteredObjectHits.value[index]);
}

function highlightMatch(text: string): string {
  return highlightMenuSearchText(text || "", query.value, matchOptions.value);
}

function objectTypeBadgeVariant(objectType: string): "default" | "secondary" | "outline" {
  const upper = objectType.toUpperCase();
  if (upper.includes("TABLE")) return "default";
  if (upper.includes("VIEW")) return "secondary";
  return "outline";
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const metadataFilterChips = computed<Array<{ key: MetadataTypeFilter; label: string }>>(() => [
  { key: "ALL", label: t("searchCenter.filters.all") },
  { key: "TABLE", label: t("searchCenter.filters.table") },
  { key: "VIEW", label: t("searchCenter.filters.view") },
  { key: "ROUTINE", label: t("searchCenter.filters.routine") },
  { key: "PACKAGE", label: t("searchCenter.filters.package") },
  { key: "COLUMN", label: t("searchCenter.filters.column") },
]);
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[780px] h-[80vh] max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden border bg-background text-foreground shadow-2xl" @keydown="handleKeydown">
      <div class="space-y-2 border-b bg-muted/30 px-4 pb-2 pt-3 pr-12 shrink-0 select-none">
        <div class="flex items-center gap-2">
          <Search class="h-4 w-4 text-primary" />
          <span class="text-sm font-semibold">{{ t("searchCenter.title") }}</span>
        </div>

        <div class="grid grid-cols-4 gap-1 rounded-md border bg-muted/60 p-0.5 text-xs">
          <button type="button" class="flex items-center justify-center gap-1.5 rounded px-2 py-1 font-medium transition-all" :class="activeMode === 'objects' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="selectMode('objects')">
            <FileCode class="h-3.5 w-3.5 text-blue-500" />{{ t("searchCenter.modes.source") }}
          </button>
          <button type="button" class="flex items-center justify-center gap-1.5 rounded px-2 py-1 font-medium transition-all" :class="activeMode === 'metadata' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="selectMode('metadata')">
            <TableProperties class="h-3.5 w-3.5 text-purple-500" />{{ t("searchCenter.modes.metadata") }}
          </button>
          <button type="button" class="flex items-center justify-center gap-1.5 rounded px-2 py-1 font-medium transition-all" :class="activeMode === 'files' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="selectMode('files')">
            <FolderOpen class="h-3.5 w-3.5 text-amber-500" />{{ t("searchCenter.modes.files") }}
          </button>
          <button type="button" class="flex items-center justify-center gap-1.5 rounded px-2 py-1 font-medium transition-all" :class="activeMode === 'data' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="selectMode('data')">
            <Database class="h-3.5 w-3.5 text-emerald-500" />{{ t("searchCenter.modes.data") }}
          </button>
        </div>

        <div v-if="activeMode !== 'files'" class="flex items-center gap-2 text-xs">
          <span class="shrink-0 text-muted-foreground">{{ t("searchCenter.connectionScope") }}</span>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="sm" class="h-7 min-w-0 flex-1 justify-between gap-2 px-2 font-normal">
                <span class="min-w-0 truncate font-mono text-[11px]">{{ selectedScopeSummary }}</span>
                <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-[480px] max-w-[calc(100vw-3rem)]">
              <div class="flex items-center justify-between px-2 py-1.5 text-[11px] text-muted-foreground">
                <span>{{ activeMode === "data" ? t("searchCenter.singleConnectionHint") : t("searchCenter.multipleConnectionHint") }}</span>
                <div v-if="activeMode !== 'data'" class="flex items-center gap-1">
                  <button type="button" class="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" @click.stop="selectAllConnections">{{ t("searchCenter.selectAll") }}</button>
                  <span>·</span>
                  <button type="button" class="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" @click.stop="clearConnectionSelection">{{ t("searchCenter.clearSelection") }}</button>
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem v-for="target in scopeTargets" :key="target.key" :model-value="selectedTargetKeys.includes(target.key)" class="gap-2" @select.prevent @click="toggleConnection(target.key)">
                <Database class="h-3.5 w-3.5 shrink-0 text-primary" />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-xs font-medium">{{ target.connection.name }} · {{ target.database || t("searchCenter.allConnectedDatabases") }}</div>
                  <div class="truncate font-mono text-[10px] text-muted-foreground">{{ target.connection.username || "—" }}@{{ target.connection.host || "—" }}</div>
                </div>
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem v-if="scopeTargets.length === 0" disabled>{{ t("searchCenter.noSearchableConnections") }}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div class="flex items-center gap-2">
          <div class="relative flex-1">
            <Search class="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <input ref="searchInputRef" v-model="query" type="text" :placeholder="t(`searchCenter.placeholders.${activeMode}`)" class="h-8 w-full rounded-md border bg-background pl-8 pr-8 font-mono text-xs shadow-sm outline-none focus:border-ring" />
            <button v-if="query" type="button" class="absolute right-2 top-2 rounded p-0.5 text-muted-foreground hover:text-foreground" :aria-label="t('searchCenter.clear')" @click="clearQuery">
              <X class="h-3.5 w-3.5" />
            </button>
          </div>

          <div class="flex items-center gap-1 text-xs">
            <template v-if="activeMode !== 'data'">
              <Button variant="ghost" size="sm" class="h-8 px-2 font-mono text-xs" :class="{ 'bg-primary/10 font-bold text-primary': caseSensitive }" :title="t('searchCenter.matchCase')" @click="caseSensitive = !caseSensitive">Aa</Button>
              <Button variant="ghost" size="sm" class="h-8 px-2 font-mono text-xs" :class="{ 'bg-primary/10 font-bold text-primary': wholeWord }" :title="t('searchCenter.wholeWord')" @click="wholeWord = !wholeWord">\b</Button>
            </template>
            <Button size="sm" class="h-8 gap-1.5 px-3 text-xs" :class="activeMode === 'data' ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-primary'" :disabled="!canSubmit" @click="submitCurrentMode">
              <Loader2 v-if="searching" class="h-3.5 w-3.5 animate-spin" />
              <Search v-else class="h-3.5 w-3.5" />
              <span>{{ activeMode === "data" ? t("searchCenter.launch") : t("searchCenter.search") }}</span>
            </Button>
          </div>
        </div>

        <div v-if="activeMode === 'files'" class="flex items-center gap-2 text-xs">
          <span class="shrink-0 text-muted-foreground">{{ t("searchCenter.searchDirectory") }}</span>
          <span class="min-w-0 flex-1 truncate rounded border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground" :title="root || t('searchCenter.noActiveProject')">
            {{ root || t("searchCenter.noActiveProject") }}
          </span>
          <Button v-if="isDesktop" type="button" variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px]" @click="pickDirectory"> <FolderOpen class="h-3 w-3" />{{ t("searchCenter.chooseDirectory") }} </Button>
        </div>

        <div v-if="activeMode === 'metadata'" class="flex items-center gap-1 pt-0.5 text-xs">
          <span class="mr-1 text-[11px] text-muted-foreground">{{ t("searchCenter.objectType") }}</span>
          <button
            v-for="chip in metadataFilterChips"
            :key="chip.key"
            type="button"
            class="rounded px-2 py-0.5 text-[11px] font-medium transition-colors"
            :class="metadataTypeFilter === chip.key ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:bg-muted'"
            @click="metadataTypeFilter = chip.key"
          >
            {{ chip.label }}
          </button>
        </div>
      </div>

      <div v-if="error" class="flex items-center justify-between border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
        <span>{{ error }}</span>
        <Button variant="ghost" size="sm" class="h-5 w-5 p-0" @click="error = ''"><X class="h-3 w-3" /></Button>
      </div>

      <div ref="resultsRef" :role="activeMode === 'data' ? undefined : 'listbox'" class="flex-1 min-h-0 space-y-1.5 overflow-y-auto bg-muted/10 p-3 select-text">
        <div v-if="query.trim() && !searching && totalHitsCount > 0" class="flex items-center justify-between px-1 text-[11px] text-muted-foreground select-none">
          <span>{{ t("searchCenter.matchCount", { count: totalHitsCount }) }}</span>
        </div>

        <template v-if="activeMode === 'objects'">
          <div v-if="searching" class="flex items-center justify-center gap-2 p-12 text-xs text-muted-foreground select-none"><Loader2 class="h-4 w-4 animate-spin text-primary" />{{ t("searchCenter.loadingSource") }}</div>
          <div v-else-if="!query.trim()" class="flex flex-col items-center justify-center gap-2 p-12 text-xs text-muted-foreground select-none"><FileCode class="h-8 w-8 text-muted-foreground/40" />{{ t("searchCenter.sourceHint") }}</div>
          <div v-else-if="filteredObjectHits.length === 0" class="p-12 text-center text-xs text-muted-foreground select-none">{{ t("searchCenter.noSourceResults", { query }) }}</div>
          <div
            v-for="(hit, index) in filteredObjectHits"
            :key="`${hit.connection_id}:${hit.database}:${hit.schema}:${hit.object_type}:${hit.name}:${hit.signature || ''}:${index}`"
            :data-search-result-index="index"
            role="option"
            :aria-selected="selectedIndex === index"
            class="cursor-pointer rounded-md border bg-background p-2.5 transition-all hover:border-primary/60 hover:shadow-sm"
            :class="selectedIndex === index ? 'border-primary bg-primary/5 ring-2 ring-primary' : ''"
            @click="openDefinition(hit)"
          >
            <div class="mb-1.5 flex items-center justify-between gap-2 select-none">
              <div class="flex min-w-0 items-center gap-2">
                <Badge :variant="objectTypeBadgeVariant(hit.object_type)" class="px-1.5 py-0 font-mono text-[10px]">{{ hit.object_type }}</Badge>
                <span class="truncate font-mono text-xs font-bold text-foreground" v-html="highlightMatch(`${hit.schema}.${hit.name}${hit.signature ? `(${hit.signature})` : ''}`)" />
              </div>
              <div class="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <span class="text-[10px]">{{ hit.connection_name }} @ {{ hit.database }}</span
                ><ChevronRight class="h-3.5 w-3.5 text-muted-foreground/60" />
              </div>
            </div>
            <pre class="whitespace-pre-wrap break-all rounded border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground" v-html="highlightMatch(hit.snippet)" />
          </div>
        </template>

        <template v-else-if="activeMode === 'metadata'">
          <div v-if="searching" class="flex items-center justify-center gap-2 p-12 text-xs text-muted-foreground select-none"><Loader2 class="h-4 w-4 animate-spin text-primary" />{{ t("searchCenter.loadingMetadata") }}</div>
          <div v-else-if="!query.trim()" class="flex flex-col items-center justify-center gap-2 p-12 text-xs text-muted-foreground select-none"><TableProperties class="h-8 w-8 text-muted-foreground/40" />{{ t("searchCenter.metadataHint") }}</div>
          <div v-else-if="filteredMetadataHits.length === 0" class="p-12 text-center text-xs text-muted-foreground select-none">{{ t("searchCenter.noMetadataResults") }}</div>
          <div
            v-for="(hit, index) in filteredMetadataHits"
            :key="`${hit.connection_id}:${hit.database}:${hit.schema}:${hit.object_type}:${hit.name}:${hit.signature || ''}:${index}`"
            :data-search-result-index="index"
            role="option"
            :aria-selected="selectedIndex === index"
            class="flex cursor-pointer items-center justify-between gap-2 rounded-md border bg-background p-2 transition-colors hover:bg-muted/40"
            :class="selectedIndex === index ? 'border-primary bg-primary/5 ring-2 ring-primary' : ''"
            @click="openMetadata(hit)"
          >
            <div class="flex min-w-0 items-center gap-2">
              <Badge :variant="objectTypeBadgeVariant(hit.object_type)" class="shrink-0 px-1.5 py-0 font-mono text-[10px]">{{ hit.object_type }}</Badge>
              <span class="truncate font-mono text-xs font-medium text-foreground" v-html="highlightMatch(`${hit.schema}.${hit.name}${hit.signature ? `(${hit.signature})` : ''}`)" />
            </div>
            <div class="flex shrink-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
              <span>{{ hit.connection_name }} ({{ hit.database }})</span><ChevronRight class="h-3 w-3" />
            </div>
          </div>
        </template>

        <template v-else-if="activeMode === 'files'">
          <div v-if="!root" class="flex flex-col items-center justify-center gap-2 p-12 text-center text-xs text-muted-foreground select-none"><FolderSearch class="h-8 w-8 text-muted-foreground/40" />{{ t("searchCenter.projectRequired") }}</div>
          <div v-else-if="searching" class="flex items-center justify-center gap-2 p-12 text-xs text-muted-foreground select-none"><Loader2 class="h-4 w-4 animate-spin text-primary" />{{ t("searchCenter.loadingFiles") }}</div>
          <div v-else-if="!query.trim()" class="flex flex-col items-center justify-center gap-2 p-12 text-xs text-muted-foreground select-none"><FolderSearch class="h-8 w-8 text-muted-foreground/40" />{{ t("searchCenter.filesHint") }}</div>
          <div v-else-if="filteredFileHits.length === 0" class="p-12 text-center text-xs text-muted-foreground select-none">{{ t("searchCenter.noFileResults") }}</div>
          <div
            v-for="(hit, index) in filteredFileHits"
            :key="hit.path"
            :data-search-result-index="index"
            role="option"
            :aria-selected="selectedIndex === index"
            class="flex cursor-pointer items-center justify-between gap-2 rounded-md border bg-background p-2 transition-colors hover:bg-muted/40"
            :class="selectedIndex === index ? 'border-primary bg-primary/5 ring-2 ring-primary' : ''"
            @click="openFile(hit.path)"
          >
            <div class="flex min-w-0 items-center gap-2"><FileCode class="h-4 w-4 shrink-0 text-primary" /><span class="truncate font-mono text-xs text-foreground" v-html="highlightMatch(hit.relative || hit.path)" /></div>
            <div class="shrink-0 font-mono text-[10px] text-muted-foreground">{{ formatFileSize(hit.size) }}</div>
          </div>
        </template>

        <template v-else>
          <div class="flex flex-col items-center justify-center gap-4 p-6 text-center">
            <Database class="h-10 w-10 text-emerald-500" />
            <div>
              <h4 class="text-sm font-semibold">{{ t("searchCenter.dataTitle") }}</h4>
              <p class="mt-1 max-w-md text-xs text-muted-foreground">{{ t("searchCenter.dataDescription", { query: query || "…" }) }}</p>
            </div>
            <Button size="sm" class="h-8 gap-1.5 bg-emerald-600 px-4 text-xs text-white hover:bg-emerald-700" :disabled="!query.trim()" @click="triggerDataSearch"><Search class="h-3.5 w-3.5" />{{ t("searchCenter.launchDataSearch") }}</Button>
          </div>
        </template>
      </div>

      <div class="flex shrink-0 items-center justify-between border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground select-none">
        <div class="flex items-center gap-3 text-[11px]">
          <span><kbd class="rounded border bg-muted px-1">↑</kbd> <kbd class="rounded border bg-muted px-1">↓</kbd> {{ t("searchCenter.navigate") }}</span
          ><span><kbd class="rounded border bg-muted px-1">↵</kbd> {{ t("searchCenter.open") }}</span
          ><span><kbd class="rounded border bg-muted px-1">Esc</kbd> {{ t("searchCenter.close") }}</span>
        </div>
        <Button variant="outline" size="sm" class="h-6 px-3 text-xs" @click="dialogOpen = false">{{ t("searchCenter.close") }}</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
