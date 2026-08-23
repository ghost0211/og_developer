<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ExternalLink, FolderOpen, Plus, Search, Trash2 } from "@lucide/vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { normalizeProjectPath, useProjectStore, type SqlProject } from "@/stores/projectStore";
import { useConnectionStore } from "@/stores/connectionStore";

const props = defineProps<{
  open: boolean;
  mode: "create" | "open";
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  create: [name: string, path: string, connectionId?: string, details?: { description?: string }];
  select: [projectId: string];
}>();

const { t } = useI18n();
const { toast } = useToast();
const projectStore = useProjectStore();
const connectionStore = useConnectionStore();

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});

const isDesktop = isTauriRuntime();

// View Mode within the dialog
const viewMode = ref<"create" | "detail">("create");
const selectedProjectId = ref<string | null>(null);
const searchProjectQuery = ref("");

// Create Form State
const createName = ref("");
const createPath = ref("");
const createDescription = ref("");
const createConnectionId = ref<string | undefined>(undefined);
const createInitFolders = ref(true);

// Edit Form State
const editName = ref("");
const editPath = ref("");
const editDescription = ref("");
const editConnectionId = ref<string | undefined>(undefined);

// Filtered projects
const filteredProjects = computed(() => {
  const q = searchProjectQuery.value.trim().toLowerCase();
  if (!q) return projectStore.projects.value;
  return projectStore.projects.value.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q) || (p.description && p.description.toLowerCase().includes(q)));
});

const selectedProject = computed(() => {
  if (selectedProjectId.value) {
    return projectStore.projects.value.find((p) => p.id === selectedProjectId.value);
  }
  return projectStore.activeProject.value || projectStore.projects.value[0];
});

function connectionName(connId?: string): string {
  if (!connId) return t("projectHub.unboundConnection");
  const conn = connectionStore.getConfig(connId);
  return conn?.name || connId;
}

function connectionIconType(connId?: string): string {
  if (!connId) return "database";
  const conn = connectionStore.getConfig(connId);
  return conn?.driver_profile || conn?.db_type || "database";
}

// Select project in list
function selectProject(proj: SqlProject) {
  selectedProjectId.value = proj.id;
  viewMode.value = "detail";
  editName.value = proj.name;
  editPath.value = proj.path;
  editDescription.value = proj.description || "";
  editConnectionId.value = proj.connectionId;
}

function startCreateMode() {
  viewMode.value = "create";
  createName.value = "";
  createPath.value = projectStore.defaultSearchRoot() ?? "";
  createDescription.value = "";
  createConnectionId.value = connectionStore.activeConnectionId || undefined;
  createInitFolders.value = true;
}

// Desktop Directory Pickers
async function pickCreateDirectory() {
  if (!isDesktop) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      createPath.value = selected;
      if (!createName.value.trim()) {
        const folderName =
          selected
            .split(/[\/\\]/)
            .filter(Boolean)
            .pop() || "";
        if (folderName) createName.value = folderName;
      }
    }
  } catch (e: any) {
    toast(t("projectHub.directoryPickerFailed", { message: e?.message || String(e) }), 4000);
  }
}

async function pickEditDirectory() {
  if (!isDesktop) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      editPath.value = selected;
    }
  } catch (e: any) {
    toast(t("projectHub.directoryPickerFailed", { message: e?.message || String(e) }), 4000);
  }
}

function openInExplorer(folderPath: string) {
  if (!folderPath) return;
  if (isDesktop) {
    import("@tauri-apps/plugin-shell")
      .then(({ open }) => open(folderPath))
      .catch(() => {
        toast(t("projectHub.openDirectoryFailed"), 3000);
      });
  } else {
    toast(t("projectHub.desktopOnly"), 2500);
  }
}

// Actions
function projectPathChild(root: string, child: string): string {
  const normalized = normalizeProjectPath(root);
  if (normalized === "/") return `/${child}`;
  const base = /^[A-Za-z]:[\\/]$/.test(normalized) ? normalized.slice(0, -1) : normalized;
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base}${separator}${child}`;
}

async function confirmCreate() {
  const name = createName.value.trim();
  const path = normalizeProjectPath(createPath.value);
  if (!name || !path) {
    toast(t("projectHub.namePathRequired"), 2500);
    return;
  }
  if (projectStore.projects.value.some((project) => normalizeProjectPath(project.path) === path)) {
    toast(t("projectHub.pathAlreadyRegistered"), 3000);
    return;
  }

  try {
    const subdirs = createInitFolders.value ? ["sql", "queries", "scripts", "migrations", "ddl", "docs"] : ["sql"];
    for (const sub of subdirs) await api.ensureDirectory(projectPathChild(path, sub));
  } catch (error: any) {
    toast(t("projectHub.createDirectoryFailed", { message: error?.message || String(error) }), 5000);
    return;
  }

  emit("create", name, path, createConnectionId.value || undefined, { description: createDescription.value.trim() || undefined });
  dialogOpen.value = false;
}

function saveProjectEdit() {
  const project = selectedProject.value;
  if (!project) return;
  const name = editName.value.trim();
  const path = normalizeProjectPath(editPath.value);
  if (!name || !path) {
    toast(t("projectHub.namePathRequired"), 2500);
    return;
  }
  if (projectStore.projects.value.some((candidate) => candidate.id !== project.id && normalizeProjectPath(candidate.path) === path)) {
    toast(t("projectHub.pathAlreadyRegistered"), 3000);
    return;
  }

  const updated = projectStore.updateProject(project.id, {
    name,
    path,
    description: editDescription.value.trim() || undefined,
    connectionId: editConnectionId.value || undefined,
  });
  if (updated && updated.id === projectStore.activeProjectId.value && updated.connectionId && connectionStore.getConfig(updated.connectionId)) {
    connectionStore.activeConnectionId = updated.connectionId;
  }

  toast(t("projectHub.projectSaved"), 1500);
}

function activateProject(proj: SqlProject) {
  projectStore.setActiveProject(proj.id);
  if (proj.connectionId && connectionStore.getConfig(proj.connectionId)) {
    connectionStore.activeConnectionId = proj.connectionId;
  }
  emit("select", proj.id);
  dialogOpen.value = false;
}

function deleteProject(proj: SqlProject) {
  if (!window.confirm(t("projectHub.removeConfirm", { name: proj.name }))) return;
  projectStore.removeProject(proj.id);
  toast(t("projectHub.projectRemoved", { name: proj.name }), 1500);
  if (projectStore.projects.value.length > 0) {
    selectProject(projectStore.projects.value[0]);
  } else {
    startCreateMode();
  }
}

watch(
  dialogOpen,
  (open) => {
    if (!open) return;
    if (props.mode === "create" || projectStore.projects.value.length === 0) {
      startCreateMode();
    } else {
      viewMode.value = "detail";
      const target = projectStore.activeProject.value || projectStore.projects.value[0];
      if (target) selectProject(target);
    }
  },
  { immediate: true },
);
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[780px] h-[82vh] max-h-[86vh] flex flex-col p-0 gap-0 overflow-hidden border bg-background text-foreground shadow-2xl">
      <!-- Top Dialog Header -->
      <DialogHeader class="px-4 py-2.5 pr-12 border-b bg-muted/30 flex flex-row items-center justify-between space-y-0 shrink-0 select-none">
        <DialogTitle class="flex items-center gap-2 text-sm font-semibold">
          <FolderOpen class="h-4 w-4 text-primary" />
          <span>{{ t("projectHub.title") }}</span>
        </DialogTitle>
        <Badge variant="outline" class="text-xs font-mono">
          {{ t("projectHub.projectCount", { count: projectStore.projects.value.length }) }}
        </Badge>
      </DialogHeader>

      <!-- Main Body: 2-Column Split Layout -->
      <div class="flex-1 min-h-0 flex overflow-hidden">
        <!-- Left Column: Projects List -->
        <div class="w-64 border-r bg-muted/15 flex flex-col min-h-0 shrink-0">
          <div class="p-2 border-b bg-muted/20 flex items-center justify-between gap-1 shrink-0 select-none">
            <Button size="sm" class="h-7 w-full gap-1 text-xs" @click="startCreateMode">
              <Plus class="h-3.5 w-3.5" />
              <span>{{ t("projectHub.newProject") }}</span>
            </Button>
          </div>

          <!-- Search Project Filter -->
          <div class="p-2 border-b shrink-0">
            <div class="relative">
              <Search class="absolute left-2 top-1.5 h-3 w-3 text-muted-foreground/60 pointer-events-none" />
              <input v-model="searchProjectQuery" type="text" :placeholder="t('projectHub.searchPlaceholder')" class="h-6 w-full rounded border bg-background pl-6 pr-2 text-xs font-mono outline-none focus:border-ring" />
            </div>
          </div>

          <!-- Project Item Cards -->
          <div class="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1">
            <div v-if="filteredProjects.length === 0" class="p-4 text-center text-xs text-muted-foreground italic">
              {{ t("projectHub.noProjects") }}
            </div>

            <div
              v-for="p in filteredProjects"
              :key="p.id"
              class="p-2 rounded-md border cursor-pointer transition-all select-none group"
              :class="[selectedProjectId === p.id && viewMode === 'detail' ? 'bg-primary/10 border-primary shadow-sm' : 'bg-background hover:bg-muted/40 border-border/70']"
              @click="selectProject(p)"
            >
              <div class="flex items-center justify-between mb-1">
                <div class="font-bold text-xs flex items-center gap-1.5 truncate">
                  <FolderOpen class="h-3.5 w-3.5 text-primary shrink-0" />
                  <span class="truncate" :title="p.name">{{ p.name }}</span>
                </div>
                <Badge v-if="p.id === projectStore.activeProjectId.value" class="text-[9px] px-1 py-0 bg-emerald-600">
                  {{ t("projectHub.current") }}
                </Badge>
              </div>

              <div class="text-[10px] text-muted-foreground font-mono truncate" :title="p.path">
                {{ p.path }}
              </div>

              <div class="flex items-center gap-1.5 mt-1.5 text-[10px] text-muted-foreground">
                <DatabaseIcon :db-type="connectionIconType(p.connectionId)" class="h-2.5 w-2.5 shrink-0" />
                <span class="truncate">{{ connectionName(p.connectionId) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Right Column: Project Details or Create Wizard -->
        <div class="flex-1 min-h-0 flex flex-col bg-background overflow-y-auto p-4">
          <!-- 1. Create New Project Wizard -->
          <div v-if="viewMode === 'create'" class="space-y-4 max-w-lg">
            <div>
              <h3 class="text-sm font-semibold">{{ t("projectHub.createTitle") }}</h3>
              <p class="text-xs text-muted-foreground mt-0.5">{{ t("projectHub.createDescription") }}</p>
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs font-semibold">{{ t("projectHub.nameRequired") }}</Label>
              <Input v-model="createName" :placeholder="t('projectHub.namePlaceholder')" class="h-8 text-xs font-mono" />
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs font-semibold">{{ t("projectHub.pathRequired") }}</Label>
              <div class="flex items-center gap-2">
                <Input v-model="createPath" :placeholder="t('projectHub.pathPlaceholder')" class="h-8 text-xs font-mono flex-1" />
                <Button v-if="isDesktop" type="button" variant="outline" size="sm" class="h-8 gap-1 px-2.5 text-xs shrink-0" @click="pickCreateDirectory">
                  <FolderOpen class="h-3.5 w-3.5" />
                  <span>{{ t("projectHub.browse") }}</span>
                </Button>
              </div>
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs font-semibold">{{ t("projectHub.connectionOptional") }}</Label>
              <Select v-model="createConnectionId">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue :placeholder="t('projectHub.unboundConnectionOption')" />
                </SelectTrigger>
                <SelectContent class="text-xs">
                  <SelectItem value="">{{ t("projectHub.unboundConnectionOption") }}</SelectItem>
                  <SelectItem v-for="c in connectionStore.connections" :key="c.id" :value="c.id"> {{ c.name }} ({{ c.db_type }}) </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs font-semibold">{{ t("projectHub.descriptionOptional") }}</Label>
              <Input v-model="createDescription" :placeholder="t('projectHub.descriptionPlaceholder')" class="h-8 text-xs" />
            </div>

            <div class="flex items-center gap-2 pt-2 select-none">
              <input id="init-folders" v-model="createInitFolders" type="checkbox" class="h-3.5 w-3.5 accent-primary cursor-pointer" />
              <label for="init-folders" class="text-xs text-muted-foreground cursor-pointer">
                {{ t("projectHub.initializeFolders") }}
              </label>
            </div>

            <div class="pt-4 flex items-center gap-2">
              <Button size="sm" class="h-8 px-4 text-xs bg-primary" :disabled="!createName.trim() || !createPath.trim()" @click="confirmCreate">
                {{ t("projectHub.createAndActivate") }}
              </Button>
              <Button v-if="projectStore.projects.value.length > 0" variant="ghost" size="sm" class="h-8 text-xs" @click="viewMode = 'detail'">
                {{ t("projectHub.cancel") }}
              </Button>
            </div>
          </div>

          <!-- 2. View / Edit Selected Project -->
          <div v-else-if="selectedProject" class="space-y-4 max-w-lg">
            <div class="flex items-center justify-between border-b pb-3">
              <div>
                <h3 class="text-sm font-semibold flex items-center gap-2">
                  <span>{{ selectedProject.name }}</span>
                  <Badge v-if="selectedProject.id === projectStore.activeProjectId.value" class="bg-emerald-600 text-[10px]">
                    {{ t("projectHub.activeProject") }}
                  </Badge>
                </h3>
                <p class="text-xs text-muted-foreground font-mono mt-0.5">{{ selectedProject.path }}</p>
              </div>

              <div class="flex items-center gap-1.5">
                <Button v-if="selectedProject.id !== projectStore.activeProjectId.value" size="sm" variant="outline" class="h-7 text-xs bg-emerald-600/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-300" @click="activateProject(selectedProject)">
                  <Check class="h-3.5 w-3.5 mr-1" />
                  <span>{{ t("projectHub.switchToCurrent") }}</span>
                </Button>
                <Button size="sm" variant="ghost" class="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" :title="t('projectHub.removeProject')" @click="deleteProject(selectedProject)">
                  <Trash2 class="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs font-semibold">{{ t("projectHub.projectName") }}</Label>
              <Input v-model="editName" class="h-8 text-xs font-mono" />
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs font-semibold">{{ t("projectHub.projectPath") }}</Label>
              <div class="flex items-center gap-2">
                <Input v-model="editPath" class="h-8 text-xs font-mono flex-1" />
                <Button v-if="isDesktop" type="button" variant="outline" size="sm" class="h-8 gap-1 px-2 text-xs shrink-0" @click="pickEditDirectory">
                  <FolderOpen class="h-3.5 w-3.5" />
                  <span>{{ t("projectHub.changeDirectory") }}</span>
                </Button>
                <Button v-if="isDesktop" type="button" variant="outline" size="sm" class="h-8 gap-1 px-2 text-xs shrink-0" :title="t('projectHub.openDirectory')" @click="openInExplorer(editPath)">
                  <ExternalLink class="h-3.5 w-3.5" />
                  <span>{{ t("projectHub.openDirectory") }}</span>
                </Button>
              </div>
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs font-semibold">{{ t("projectHub.boundConnection") }}</Label>
              <Select v-model="editConnectionId">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue :placeholder="t('projectHub.unboundConnectionOption')" />
                </SelectTrigger>
                <SelectContent class="text-xs">
                  <SelectItem value="">{{ t("projectHub.unboundConnectionOption") }}</SelectItem>
                  <SelectItem v-for="c in connectionStore.connections" :key="c.id" :value="c.id"> {{ c.name }} ({{ c.db_type }}) </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs font-semibold">{{ t("projectHub.projectDescription") }}</Label>
              <Input v-model="editDescription" :placeholder="t('projectHub.descriptionPlaceholder')" class="h-8 text-xs" />
            </div>

            <div class="pt-3 flex items-center justify-between">
              <Button size="sm" class="h-8 px-4 text-xs bg-primary" @click="saveProjectEdit">
                {{ t("projectHub.saveChanges") }}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom Footer -->
      <DialogFooter class="px-4 py-2 border-t bg-muted/20 shrink-0 flex flex-row items-center justify-between select-none">
        <div class="text-[11px] text-muted-foreground">
          {{ t("projectHub.footerHint") }}
        </div>
        <Button variant="outline" size="sm" class="h-7 text-xs" @click="dialogOpen = false">
          {{ t("projectHub.close") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
