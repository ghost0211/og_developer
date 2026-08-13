<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronUp, FolderOpen, RefreshCw } from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import * as api from "@/lib/backend/api";
import { useProjectStore } from "@/stores/projectStore";

const props = defineProps<{
  open: boolean;
  mode: "create" | "open";
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  create: [name: string, path: string];
  select: [projectId: string];
}>();

const { t } = useI18n();
const projectStore = useProjectStore();

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});

const name = ref("");
const path = ref("");
const dirEntries = ref<string[]>([]);
const browsing = ref(false);
const browseError = ref("");

const isDesktop = isTauriRuntime();

function parentOf(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index > 0 ? trimmed.slice(0, index) : "/";
}

async function browse() {
  browseError.value = "";
  browsing.value = true;
  try {
    dirEntries.value = await api.listDirectories(path.value || "/");
  } catch (e: any) {
    dirEntries.value = [];
    browseError.value = e?.message || String(e);
  } finally {
    browsing.value = false;
  }
}

async function pickDirectory() {
  if (!isDesktop) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      path.value = selected;
      await browse();
    }
  } catch (e: any) {
    browseError.value = e?.message || String(e);
  }
}

function enterDirectory(entry: string) {
  path.value = entry;
  void browse();
}

function confirmCreate() {
  if (!name.value.trim() || !path.value.trim()) return;
  emit("create", name.value.trim(), path.value.trim());
  dialogOpen.value = false;
}

function confirmSelect() {
  const active = projectStore.activeProject.value;
  if (active) {
    emit("select", active.id);
    dialogOpen.value = false;
  }
}

watch(dialogOpen, (open) => {
  if (!open) return;
  name.value = "";
  path.value = projectStore.defaultSearchRoot() ?? "/";
  browseError.value = "";
  dirEntries.value = [];
  if (isDesktop || props.mode === "create") {
    void browse();
  }
});
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ props.mode === "create" ? t("menus.createProject") : t("menus.openProject") }}</DialogTitle>
        <DialogDescription>
          {{ t("menus.createProjectHint") }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="props.mode === 'create'" class="space-y-4 py-1">
        <div class="space-y-1.5">
          <Label for="project-name">{{ t("menus.projectName") }}</Label>
          <Input id="project-name" v-model="name" :placeholder="t('menus.projectNamePlaceholder')" />
        </div>
      </div>

      <div class="space-y-1.5">
        <Label for="project-path">{{ t("menus.projectDirectory") }}</Label>
        <div class="flex items-center gap-2">
          <Input id="project-path" v-model="path" @keyup.enter="browse" />
          <Button v-if="isDesktop" type="button" variant="outline" @click="pickDirectory">{{ t("menus.browse") }}</Button>
          <Button type="button" variant="outline" :disabled="browsing" @click="browse">
            <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': browsing }" />
          </Button>
        </div>
        <p v-if="browseError" class="text-xs text-destructive">{{ browseError }}</p>
      </div>

      <div class="max-h-48 space-y-0.5 overflow-y-auto rounded-md border bg-muted/20 p-1.5">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-muted"
          @click="
            path = parentOf(path);
            browse();
          "
        >
          <ChevronUp class="h-3.5 w-3.5 text-muted-foreground" />
          {{ t("menus.parentDirectory") }}
        </button>
        <button v-for="entry in dirEntries" :key="entry" type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-muted" @click="enterDirectory(entry)">
          <FolderOpen class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">{{ entry }}</span>
        </button>
      </div>

      <div v-if="props.mode === 'open'" class="max-h-40 space-y-0.5 overflow-y-auto rounded-md border bg-muted/20 p-1.5">
        <button
          v-for="project in projectStore.projects.value"
          :key="project.id"
          type="button"
          class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted"
          @click="
            projectStore.setActiveProject(project.id);
            dialogOpen = false;
          "
        >
          <FolderOpen class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">{{ project.name }} — {{ project.path }}</span>
          <span v-if="project.id === projectStore.activeProjectId.value" class="text-primary">✓</span>
        </button>
        <p v-if="!projectStore.projects.value.length" class="px-2 py-1 text-xs text-muted-foreground">{{ t("menus.noProjects") }}</p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="dialogOpen = false">{{ t("common.cancel") }}</Button>
        <Button v-if="props.mode === 'create'" :disabled="!name.trim() || !path.trim()" @click="confirmCreate">{{ t("menus.createProject") }}</Button>
        <Button v-else :disabled="!projectStore.activeProject.value" @click="confirmSelect">{{ t("menus.openProject") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
