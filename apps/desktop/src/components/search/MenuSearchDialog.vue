<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FileCode, FolderOpen, RefreshCw, Search, TableProperties } from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as api from "@/lib/backend/api";
import { useProjectStore } from "@/stores/projectStore";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

export type MenuSearchMode = "files" | "metadata" | "objects";

const props = defineProps<{
  open: boolean;
  mode: MenuSearchMode;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "open-file": [path: string];
  "open-object": [hit: { connectionId: string; database: string; schema: string; objectType: string; name: string }];
}>();

const { t } = useI18n();
const projectStore = useProjectStore();
const isDesktop = isTauriRuntime();

async function pickDirectory() {
  if (!isDesktop) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") root.value = selected;
  } catch (e: any) {
    error.value = e?.message || String(e);
  }
}

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});

const activeMode = ref<MenuSearchMode>(props.mode);
const query = ref("");
const root = ref("");
const dirEntries = ref<string[]>([]);
const searching = ref(false);
const error = ref("");
const fileHits = ref<Awaited<ReturnType<typeof api.searchFiles>>>([]);
const metadataHits = ref<Awaited<ReturnType<typeof api.searchMetadata>>>([]);
const objectHits = ref<Awaited<ReturnType<typeof api.searchObjectDefinitions>>>([]);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    activeMode.value = props.mode;
    query.value = "";
    error.value = "";
    fileHits.value = [];
    metadataHits.value = [];
    objectHits.value = [];
    root.value = projectStore.defaultSearchRoot() ?? "/";
    void refreshDirs();
  },
);

async function refreshDirs() {
  try {
    dirEntries.value = await api.listDirectories(root.value || "/");
  } catch {
    dirEntries.value = [];
  }
}

function parentOf(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index > 0 ? trimmed.slice(0, index) : "/";
}

async function search() {
  const needle = query.value.trim();
  if (!needle) return;
  searching.value = true;
  error.value = "";
  try {
    if (activeMode.value === "files") {
      fileHits.value = await api.searchFiles(root.value || ".", needle);
    } else if (activeMode.value === "metadata") {
      metadataHits.value = await api.searchMetadata(needle);
    } else {
      objectHits.value = await api.searchObjectDefinitions(needle);
    }
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    searching.value = false;
  }
}

function openFile(path: string) {
  emit("open-file", path);
}

function openMetadata(hit: { connection_id: string; database: string; schema: string; object_type: string; name: string }) {
  emit("open-object", { connectionId: hit.connection_id, database: hit.database, schema: hit.schema, objectType: hit.object_type, name: hit.name });
}

function openDefinition(hit: { connection_id: string; database: string; schema: string; object_type: string; name: string }) {
  emit("open-object", { connectionId: hit.connection_id, database: hit.database, schema: hit.schema, objectType: hit.object_type, name: hit.name });
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[640px]">
      <DialogHeader>
        <DialogTitle>{{ t("menus.search") }}</DialogTitle>
        <DialogDescription>{{ t("menus.searchHint") }}</DialogDescription>
      </DialogHeader>

      <Tabs v-model="activeMode" class="space-y-3">
        <TabsList>
          <TabsTrigger value="files"><FolderOpen class="mr-1 h-3.5 w-3.5" />{{ t("menus.searchFiles") }}</TabsTrigger>
          <TabsTrigger value="metadata"><TableProperties class="mr-1 h-3.5 w-3.5" />{{ t("menus.searchMetadata") }}</TabsTrigger>
          <TabsTrigger value="objects"><FileCode class="mr-1 h-3.5 w-3.5" />{{ t("menus.searchObjects") }}</TabsTrigger>
        </TabsList>

        <div v-if="activeMode === 'files'" class="space-y-2">
          <template v-if="isDesktop">
            <div class="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" @click="pickDirectory">
                <FolderOpen class="mr-1 h-3.5 w-3.5" />
                {{ t("menus.browse") }}
              </Button>
              <span class="min-w-0 flex-1 truncate rounded-md border bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">{{ root || t("menus.searchRootPlaceholder") }}</span>
            </div>
          </template>
          <template v-else>
            <div class="flex items-center gap-2">
              <Input v-model="root" :placeholder="t('menus.searchRootPlaceholder')" @keyup.enter="search" />
              <Button type="button" variant="outline" @click="refreshDirs"><RefreshCw class="h-3.5 w-3.5" /></Button>
            </div>
            <div v-if="dirEntries.length" class="flex max-h-24 flex-wrap gap-1 overflow-y-auto rounded-md border bg-muted/20 p-1.5">
              <button
                type="button"
                class="rounded-sm px-2 py-0.5 text-xs hover:bg-muted"
                @click="
                  root = parentOf(root);
                  refreshDirs();
                "
              >
                ../
              </button>
              <button
                v-for="entry in dirEntries"
                :key="entry"
                type="button"
                class="rounded-sm px-2 py-0.5 text-xs hover:bg-muted"
                @click="
                  root = entry;
                  refreshDirs();
                "
              >
                {{ entry.split(/[\\/]/).pop() }}
              </button>
            </div>
          </template>
        </div>

        <div class="flex items-center gap-2">
          <Input v-model="query" :placeholder="activeMode === 'files' ? t('menus.searchFileNamePlaceholder') : t('menus.searchQueryPlaceholder')" @keyup.enter="search" />
          <Button type="button" :disabled="searching || !query.trim()" @click="search">
            <Search class="mr-1 h-3.5 w-3.5" />
            {{ t("menus.searchAction") }}
          </Button>
        </div>
        <p v-if="error" class="text-xs text-destructive">{{ error }}</p>

        <div class="max-h-72 space-y-0.5 overflow-y-auto rounded-md border bg-muted/20 p-1.5">
          <template v-if="activeMode === 'files'">
            <button v-for="hit in fileHits" :key="hit.path" type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-muted" @click="openFile(hit.path)">
              <FileCode class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate">{{ hit.relative }}</span>
              <span class="shrink-0 text-[10px] text-muted-foreground">{{ hit.size }} B</span>
            </button>
            <p v-if="!fileHits.length && !searching" class="px-2 py-1 text-xs text-muted-foreground">{{ t("menus.searchEmpty") }}</p>
          </template>
          <template v-else-if="activeMode === 'metadata'">
            <button v-for="hit in metadataHits" :key="`${hit.connection_id}:${hit.database}:${hit.schema}:${hit.object_type}:${hit.name}`" type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-muted" @click="openMetadata(hit)">
              <TableProperties class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span class="shrink-0 text-[10px] text-muted-foreground">{{ hit.object_type }}</span>
              <span class="min-w-0 flex-1 truncate font-mono">{{ hit.schema }}.{{ hit.name }}</span>
              <span class="shrink-0 text-[10px] text-muted-foreground">{{ hit.connection_name }}</span>
            </button>
            <p v-if="!metadataHits.length && !searching" class="px-2 py-1 text-xs text-muted-foreground">{{ t("menus.searchEmpty") }}</p>
          </template>
          <template v-else>
            <div v-for="hit in objectHits" :key="`${hit.connection_id}:${hit.database}:${hit.schema}:${hit.object_type}:${hit.name}`" class="cursor-pointer rounded-sm px-2 py-1.5 hover:bg-muted" @click="openDefinition(hit)">
              <div class="flex items-center gap-2 text-xs">
                <span class="shrink-0 text-[10px] text-muted-foreground">{{ hit.object_type }}</span>
                <span class="min-w-0 flex-1 truncate font-mono">{{ hit.schema }}.{{ hit.name }}</span>
                <span class="shrink-0 text-[10px] text-muted-foreground">{{ hit.connection_name }}</span>
              </div>
              <pre class="mt-1 line-clamp-3 whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">{{ hit.snippet }}</pre>
            </div>
            <p v-if="!objectHits.length && !searching" class="px-2 py-1 text-xs text-muted-foreground">{{ t("menus.searchEmpty") }}</p>
          </template>
        </div>
      </Tabs>
    </DialogContent>
  </Dialog>
</template>
