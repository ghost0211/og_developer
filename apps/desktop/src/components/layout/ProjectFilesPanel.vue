<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FolderOpen, FileCode, FolderClosed, ChevronRight, ChevronDown, X, RefreshCw, FolderSearch, Copy, Play, File, FolderPlus, ChevronsUpDown, ChevronsDownUp } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { useGitStore } from "@/stores/gitStore";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { translateBackendError } from "@/i18n/backend-errors";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { copyToClipboard } from "@/lib/common/clipboard";
import { resolveExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";
import { externalSqlFileOpenErrorMessage, formatSqlFileSize, isExternalSqlFileTooLargeError } from "@/lib/sql/sqlFileOpen";
import { getFileGitColorClass, getFileGitStatus } from "@/lib/git/gitUtils";
import type { GitChangeStatus } from "@/types/git";
import * as api from "@/lib/backend/api";
import type { SqlFileEntry } from "@/lib/backend/api";

const emit = defineEmits<{
  close: [];
  "create-project": [];
}>();

const { t } = useI18n();
const queryStore = useQueryStore();
const connectionStore = useConnectionStore();
const projectStore = useProjectStore();
const gitStore = useGitStore();
const { toast } = useToast();

const entries = ref<SqlFileEntry[]>([]);
const expanded = ref<Set<string>>(new Set());
const loadedDirectories = ref<Set<string>>(new Set());
const loadingDirectories = ref<Set<string>>(new Set());
const loading = ref(false);
const loadFailed = ref(false);
const selectedPath = ref<string | null>(null);
let loadRequestId = 0;

type ContextTarget = { kind: "panel" } | { kind: "dir"; entry: SqlFileEntry } | { kind: "file"; entry: SqlFileEntry };
const contextTarget = ref<ContextTarget | null>(null);

const activeProject = computed(() => projectStore.activeProject.value);

function isSqlFile(path: string): boolean {
  return path.toLowerCase().endsWith(".sql");
}

function entryGitStatus(entry: SqlFileEntry): GitChangeStatus | undefined {
  if (entry.is_dir || !gitStore.isRepo || !activeProject.value?.path) return undefined;
  return getFileGitStatus(entry.path, activeProject.value.path, gitStore.entries);
}

function entryGitColorClass(entry: SqlFileEntry): string {
  const status = entryGitStatus(entry);
  return getFileGitColorClass(status);
}

async function loadEntries() {
  const requestId = ++loadRequestId;
  const project = activeProject.value;
  if (!project) {
    entries.value = [];
    expanded.value = new Set();
    loadedDirectories.value = new Set();
    loadingDirectories.value = new Set();
    loadFailed.value = false;
    loading.value = false;
    return;
  }
  loading.value = true;
  loadFailed.value = false;
  expanded.value = new Set();
  loadedDirectories.value = new Set();
  loadingDirectories.value = new Set();
  try {
    const next = await api.listFilesInFolder(project.path);
    if (requestId !== loadRequestId || activeProject.value?.path !== project.path) return;
    entries.value = next;
    loadedDirectories.value = new Set([project.path]);
  } catch {
    if (requestId !== loadRequestId || activeProject.value?.path !== project.path) return;
    entries.value = [];
    loadedDirectories.value = new Set();
    loadFailed.value = true;
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}

function replaceDirectoryChildren(list: SqlFileEntry[], path: string, children: SqlFileEntry[]): SqlFileEntry[] {
  return list.map((entry) => {
    if (entry.path === path && entry.is_dir) return { ...entry, children };
    if (entry.is_dir && entry.children.length > 0) return { ...entry, children: replaceDirectoryChildren(entry.children, path, children) };
    return entry;
  });
}

async function loadDirectory(path: string) {
  const projectPath = activeProject.value?.path;
  if (!projectPath || loadedDirectories.value.has(path) || loadingDirectories.value.has(path)) return;
  const requestId = loadRequestId;
  loadingDirectories.value = new Set([...loadingDirectories.value, path]);
  try {
    const children = await api.listFilesInFolder(path);
    if (requestId !== loadRequestId || activeProject.value?.path !== projectPath) return;
    entries.value = replaceDirectoryChildren(entries.value, path, children);
    loadedDirectories.value = new Set([...loadedDirectories.value, path]);
  } catch {
    if (requestId === loadRequestId && activeProject.value?.path === projectPath) toast(t("projectFiles.loadFailed"), 3000);
  } finally {
    if (requestId === loadRequestId) {
      const next = new Set(loadingDirectories.value);
      next.delete(path);
      loadingDirectories.value = next;
    }
  }
}

function collectDirPaths(list: SqlFileEntry[], into: Set<string>) {
  for (const e of list) {
    if (e.is_dir) {
      into.add(e.path);
      collectDirPaths(e.children, into);
    }
  }
}

async function refresh() {
  await loadEntries();
  toast(t("sqlFileTree.refreshed"), 1500);
}

async function toggleExpand(path: string) {
  const next = new Set(expanded.value);
  if (next.has(path)) {
    next.delete(path);
    expanded.value = next;
    return;
  }
  next.add(path);
  expanded.value = next;
  await loadDirectory(path);
}

async function setAllExpanded(value: boolean) {
  if (!value) {
    expanded.value = new Set();
    return;
  }

  const projectPath = activeProject.value?.path;
  const requestId = loadRequestId;
  if (!projectPath) return;

  const pending = new Set<string>();
  const expandedPaths = new Set<string>();
  collectDirPaths(entries.value, pending);
  while (pending.size > 0) {
    if (requestId !== loadRequestId || activeProject.value?.path !== projectPath) return;
    const path = pending.values().next().value as string;
    pending.delete(path);
    expandedPaths.add(path);
    await loadDirectory(path);
    if (requestId !== loadRequestId || activeProject.value?.path !== projectPath) return;
    expanded.value = new Set(expandedPaths);
    const discovered = new Set<string>();
    collectDirPaths(entries.value, discovered);
    for (const discoveredPath of discovered) {
      if (!expandedPaths.has(discoveredPath)) pending.add(discoveredPath);
    }
  }
  if (requestId === loadRequestId && activeProject.value?.path === projectPath) expanded.value = expandedPaths;
}

async function openFile(path: string) {
  if (!isTauriRuntime()) return;
  try {
    const content = await api.readExternalSqlFile(path);
    const connectionId = activeProject.value?.connectionId || connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
    const connection = connectionId ? connectionStore.getConfig(connectionId) : undefined;
    const database = connection ? resolveDefaultDatabase(connection, []) : "";
    const target = resolveExternalSqlFileTarget(path, (savedConnectionId) => !!connectionStore.getConfig(savedConnectionId), { connectionId, database });
    queryStore.openExternalSqlFile(target.connectionId, target.database, path, content);
  } catch (e: any) {
    if (isExternalSqlFileTooLargeError(e)) {
      executeFile(path);
      toast(t("sqlFile.largeFileExecutionOpened", { size: formatSqlFileSize(e.sizeBytes) }), 6000);
      return;
    }
    toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
  }
}

function executeFile(path: string) {
  connectionStore.sqlFileSource = {
    connectionId: activeProject.value?.connectionId || connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "",
    database: "",
    filePath: path,
  };
}

function handleEntryClick(entry: SqlFileEntry) {
  selectedPath.value = entry.path;
  if (entry.is_dir) toggleExpand(entry.path);
  else if (isSqlFile(entry.path)) openFile(entry.path);
}

async function revealInFileManager(path: string) {
  if (!isTauriRuntime()) {
    toast(t("sqlFileTree.desktopOnly"), 3000);
    return;
  }
  try {
    await api.revealPathInFileManager(path);
  } catch (e: any) {
    toast(t("sqlFileTree.revealFailed", { message: translateBackendError(t, e) }), 5000);
  }
}

async function copyPath(path: string) {
  try {
    await copyToClipboard(path);
    toast(t("sqlFileTree.pathCopied"), 1500);
  } catch {
    toast(t("sqlFileTree.copyFailed"), 3000);
  }
}

function selectProject(value: unknown) {
  if (typeof value === "string") projectStore.setActiveProject(value);
}

type TreeEntry = { entry: SqlFileEntry; depth: number };
const flatTree = computed<TreeEntry[]>(() => {
  const result: TreeEntry[] = [];
  function walk(items: SqlFileEntry[], depth: number) {
    for (const item of items) {
      result.push({ entry: item, depth });
      if (item.is_dir && expanded.value.has(item.path)) walk(item.children, depth + 1);
    }
  }
  walk(entries.value, 0);
  return result;
});

const contextMenuItems = computed<ContextMenuItem[]>(() => {
  const target = contextTarget.value;
  if (!target) return [];

  if (target.kind === "panel") {
    return [
      { label: t("sqlFileTree.refreshFolder"), action: refresh, icon: RefreshCw },
      { label: t("sqlFileTree.expandAll"), action: () => setAllExpanded(true), icon: ChevronsUpDown },
      { label: t("sqlFileTree.collapseAll"), action: () => setAllExpanded(false), icon: ChevronsDownUp },
    ];
  }

  if (target.kind === "dir") {
    return [
      { label: t("sqlFileTree.revealInFileManager"), action: () => revealInFileManager(target.entry.path), icon: FolderSearch },
      { label: t("sqlFileTree.copyPath"), action: () => copyPath(target.entry.path), icon: Copy },
    ];
  }

  const items: ContextMenuItem[] = [];
  if (isSqlFile(target.entry.path)) {
    items.push({ label: t("sqlFileTree.openFile"), action: () => openFile(target.entry.path), icon: FileCode });
    items.push({ label: t("sqlFileTree.executeSqlFile"), action: () => executeFile(target.entry.path), icon: Play });
    items.push({ label: "", separator: true });
  }
  items.push({ label: t("sqlFileTree.revealInFileManager"), action: () => revealInFileManager(target.entry.path), icon: FolderSearch });
  items.push({ label: t("sqlFileTree.copyPath"), action: () => copyPath(target.entry.path), icon: Copy });
  return items;
});

function clearContextTarget() {
  contextTarget.value = null;
}

watch(
  () => activeProject.value?.path,
  () => {
    expanded.value = new Set();
    selectedPath.value = null;
    void loadEntries();
  },
  { immediate: true },
);
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="h-9 flex items-center gap-1 px-2 border-b shrink-0 bg-muted/20">
      <span class="text-[13px] font-medium">{{ t("projectFiles.title") }}</span>
      <span class="flex-1" />
      <LightTooltip v-if="activeProject" :text="t('sqlFileTree.refreshFolder')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="refresh">
          <RefreshCw class="h-3 w-3" :class="loading ? 'animate-spin' : ''" />
        </Button>
      </LightTooltip>
      <LightTooltip :text="t('sqlFileTree.closePanel')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('close')">
          <X class="h-3 w-3" />
        </Button>
      </LightTooltip>
    </div>

    <div v-if="projectStore.projects.value.length > 0" class="px-2 py-1.5 border-b shrink-0">
      <Select :model-value="projectStore.activeProjectId.value" @update:model-value="selectProject">
        <SelectTrigger class="h-7 w-full text-xs">
          <SelectValue :placeholder="t('projectFiles.selectProject')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="project in projectStore.projects.value" :key="project.id" :value="project.id">
            {{ project.name }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <CustomContextMenu :items="contextMenuItems" @close="clearContextTarget">
      <template #default="{ onContextMenu }">
        <div
          class="flex-1 overflow-y-auto"
          @contextmenu.capture="contextTarget = { kind: 'panel' }"
          @contextmenu.prevent="
            contextTarget = { kind: 'panel' };
            onContextMenu($event);
          "
          @click.self="selectedPath = null"
        >
          <div v-if="!activeProject" class="h-full flex flex-col items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
            <FolderOpen class="h-8 w-8 text-muted-foreground/40" />
            <span>{{ t("projectFiles.noProject") }}</span>
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="emit('create-project')"> <FolderPlus class="h-3.5 w-3.5 mr-1" />{{ t("menus.createProject") }} </Button>
          </div>

          <div v-else-if="loading && entries.length === 0" class="px-3 py-2 text-xs text-muted-foreground">
            {{ t("sqlFileTree.loading") }}
          </div>
          <div v-else-if="loadFailed" class="px-3 py-2 text-xs text-muted-foreground">
            {{ t("projectFiles.loadFailed") }}
          </div>
          <div v-else-if="entries.length === 0" class="px-3 py-2 text-xs text-muted-foreground">
            {{ t("projectFiles.emptyFolder") }}
          </div>
          <div v-else>
            <div
              v-for="{ entry, depth } in flatTree"
              :key="entry.path"
              class="flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-muted/60 text-sm"
              :class="[entry.is_dir ? 'rounded-sm' : 'rounded-none', selectedPath === entry.path ? 'bg-accent text-accent-foreground' : '']"
              :style="{ paddingLeft: depth * 16 + 8 + 'px' }"
              :title="entry.path"
              @click="handleEntryClick(entry)"
              @contextmenu.capture="
                contextTarget = entry.is_dir ? { kind: 'dir', entry } : { kind: 'file', entry };
                selectedPath = entry.path;
              "
              @contextmenu.prevent="
                contextTarget = entry.is_dir ? { kind: 'dir', entry } : { kind: 'file', entry };
                selectedPath = entry.path;
                onContextMenu($event);
              "
            >
              <template v-if="entry.is_dir">
                <ChevronRight v-if="!expanded.has(entry.path)" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <ChevronDown v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <FolderClosed v-if="!expanded.has(entry.path)" class="h-4 w-4 shrink-0 text-amber-500" />
                <FolderOpen v-else class="h-4 w-4 shrink-0 text-amber-500" />
              </template>
              <template v-else>
                <span class="w-3.5 shrink-0" />
                <FileCode v-if="isSqlFile(entry.path)" class="h-4 w-4 shrink-0 text-blue-500" />
                <File v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
              </template>
              <span class="truncate ml-1" :class="entryGitColorClass(entry)">{{ entry.name }}</span>
            </div>
          </div>
        </div>
      </template>
    </CustomContextMenu>
  </div>
</template>
