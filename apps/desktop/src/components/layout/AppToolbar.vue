<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "vue-i18n";
import { Languages } from "@lucide/vue";
import AppMenuBar from "@/components/layout/AppMenuBar.vue";
import WindowControls from "@/components/layout/WindowControls.vue";
import ExportProgressPopover from "@/components/export/ExportProgressPopover.vue";
import { MAC_TRAFFIC_LIGHT_X, macTrafficLightInsetPaddingForScale, shouldReserveMacTrafficLightInset, useWindowControls } from "@/composables/useWindowControls";
import { useSettingsStore } from "@/stores/settingsStore";
import { currentLocale, nextLocale, setLocale } from "@/i18n";
import type { AppThemeMode } from "@/lib/app/appTheme";
import type { SqlProject } from "@/stores/projectStore";

const props = defineProps<{
  themeMode: AppThemeMode;
  hasConnections: boolean;
  hasSqlFileConnections: boolean;
  hasActiveTab: boolean;
  hasActiveQuery: boolean;
  hasActiveTransaction?: boolean;
  canSaveSql: boolean;
  projects: SqlProject[];
  activeProjectId?: string;
  autoCommit?: boolean;
  sidebarOpen?: boolean;
}>();

const emit = defineEmits<{
  "new-connection": [];
  "new-query": [];
  "open-editor-sql-file": [];
  "save-sql": [];
  "save-sql-as": [];
  "import-result-archive": [];
  "close-active-tab": [];
  "import-config": [];
  "export-config": [];
  "create-project": [];
  "open-project": [];
  "clone-from-git": [];
  "select-project": [projectId: string];
  undo: [];
  redo: [];
  cut: [];
  copy: [];
  paste: [];
  find: [];
  replace: [];
  "format-sql": [];
  "compress-sql": [];
  "execute-sql": [];
  "execute-current-statement": [];
  "explain-sql": [];
  "commit-transaction": [];
  "rollback-transaction": [];
  "toggle-auto-commit": [];
  "toggle-sidebar": [];
  "toggle-fullscreen": [];
  "close-other-tabs": [];
  "set-theme-mode": [mode: AppThemeMode];
  "toggle-ai": [];
  "toggle-history": [];
  "toggle-sql-library": [];
  "toggle-sql-file-panel": [];
  "toggle-project-file-panel": [];
  "toggle-git-panel": [];
  "open-settings": [initialTab?: string];
  "search-files": [];
  "search-metadata": [];
  "search-objects": [];
  "quick-open": [];
  "search-table-data": [];
  "open-sessions": [];
  "open-invalid-objects": [];
  "open-command-window": [];
  "open-table-import": [];
  "open-database-export": [];
  "open-transfer": [];
  "open-sql-file": [];
  "open-schema-diff": [];
  "open-data-compare": [];
  "open-shortcuts": [];
  "open-docs": [];
  "export-debug-logs": [];
  "open-about": [];
}>();

const settingsStore = useSettingsStore();
const { t } = useI18n();
const { isMac, isDesktop, showControls, isMaximized, isFullscreen, minimize, toggleMaximize, close } = useWindowControls();

const localeToggleLabel = computed(() => (currentLocale() === "zh-CN" ? "中" : "EN"));

function toggleLocale() {
  void setLocale(nextLocale(currentLocale()));
}

function onToolbarDblClick(e: MouseEvent) {
  if (isDesktop) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, [role='button'], a")) return;
  toggleMaximize();
}

const toolbarEl = ref<HTMLElement>();
const newConnectionLabelEl = ref<HTMLElement>();
const shouldReserveTrafficLightInset = computed(() => shouldReserveMacTrafficLightInset(isMac, isFullscreen.value, isDesktop));

let toolbarLayoutRaf = 0;
let trafficLightSyncRaf = 0;
const measuredTrafficLightInset = ref<number | null>(null);

type MacosTrafficLightLayout = {
  x: number;
  y: number;
  center_y: number;
  previous_center_y: number;
  reserved_inset: number;
};

function scheduleToolbarLayout() {
  if (toolbarLayoutRaf) cancelAnimationFrame(toolbarLayoutRaf);
  toolbarLayoutRaf = requestAnimationFrame(() => {
    toolbarLayoutRaf = 0;
    scheduleTrafficLightSync();
  });
}

function scheduleTrafficLightSync() {
  if (!shouldReserveTrafficLightInset.value) return;
  if (trafficLightSyncRaf) cancelAnimationFrame(trafficLightSyncRaf);
  trafficLightSyncRaf = requestAnimationFrame(() => {
    trafficLightSyncRaf = 0;
    void syncTrafficLightsToToolbar();
  });
}

async function syncTrafficLightsToToolbar() {
  if (!shouldReserveTrafficLightInset.value) return;
  const toolbarRect = toolbarEl.value?.getBoundingClientRect();
  const targetEl = newConnectionLabelEl.value;
  const targetRect = targetEl?.getBoundingClientRect();
  if (!toolbarRect || !targetRect) return;
  const targetCenterY = targetRect.top - toolbarRect.top + targetRect.height / 2;
  try {
    const layout = await invoke<MacosTrafficLightLayout>("set_macos_traffic_light_position", {
      x: MAC_TRAFFIC_LIGHT_X,
      y: targetCenterY,
      scale: settingsStore.editorSettings.uiScale,
    });
    measuredTrafficLightInset.value = Math.ceil(layout.reserved_inset / settingsStore.editorSettings.uiScale);
  } catch (error) {
    console.warn("[DBX] Failed to sync macOS traffic light position", { targetCenterY, error });
  }
}

function handleWindowResize() {
  scheduleToolbarLayout();
}

watch(
  () => settingsStore.editorSettings.uiScale,
  () => {
    measuredTrafficLightInset.value = null;
    scheduleToolbarLayout();
    window.setTimeout(scheduleTrafficLightSync, 120);
  },
);
watch(shouldReserveTrafficLightInset, () => scheduleToolbarLayout());

// ──────────── Resize observer ────────────

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleToolbarLayout);
  if (toolbarEl.value) resizeObserver.observe(toolbarEl.value);
  window.addEventListener("resize", handleWindowResize);
  scheduleToolbarLayout();
});

onBeforeUnmount(() => {
  if (toolbarLayoutRaf) cancelAnimationFrame(toolbarLayoutRaf);
  if (trafficLightSyncRaf) cancelAnimationFrame(trafficLightSyncRaf);
  resizeObserver?.disconnect();
  window.removeEventListener("resize", handleWindowResize);
});

const toolbarStyle = computed(() => {
  if (!shouldReserveTrafficLightInset.value) return undefined;
  return {
    paddingLeft: `${measuredTrafficLightInset.value ?? parseInt(macTrafficLightInsetPaddingForScale(settingsStore.editorSettings.uiScale), 10)}px`,
  };
});
</script>

<template>
  <div ref="toolbarEl" class="app-toolbar h-10 flex items-center gap-1 px-2 border-b bg-muted/30 shrink-0 overflow-hidden" :style="toolbarStyle" data-tauri-drag-region @dblclick="onToolbarDblClick">
    <span ref="newConnectionLabelEl" class="inline-flex items-center">
      <AppMenuBar
        :has-connections="hasConnections"
        :has-active-tab="hasActiveTab"
        :has-active-query="hasActiveQuery"
        :has-active-transaction="hasActiveTransaction"
        :can-save-sql="canSaveSql"
        :has-sql-file-connections="hasSqlFileConnections"
        :theme-mode="themeMode"
        :projects="projects"
        :active-project-id="activeProjectId"
        :auto-commit="autoCommit"
        :is-mac="isMac"
        :sidebar-open="sidebarOpen"
        :is-fullscreen="isFullscreen"
        @new-connection="emit('new-connection')"
        @new-query="emit('new-query')"
        @open-editor-sql-file="emit('open-editor-sql-file')"
        @save-sql="emit('save-sql')"
        @save-sql-as="emit('save-sql-as')"
        @import-result-archive="emit('import-result-archive')"
        @close-active-tab="emit('close-active-tab')"
        @close-other-tabs="emit('close-other-tabs')"
        @import-config="emit('import-config')"
        @export-config="emit('export-config')"
        @create-project="emit('create-project')"
        @open-project="emit('open-project')"
        @clone-from-git="emit('clone-from-git')"
        @select-project="emit('select-project', $event)"
        @undo="emit('undo')"
        @redo="emit('redo')"
        @cut="emit('cut')"
        @copy="emit('copy')"
        @paste="emit('paste')"
        @find="emit('find')"
        @replace="emit('replace')"
        @format-sql="emit('format-sql')"
        @compress-sql="emit('compress-sql')"
        @execute-sql="emit('execute-sql')"
        @execute-current-statement="emit('execute-current-statement')"
        @explain-sql="emit('explain-sql')"
        @commit-transaction="emit('commit-transaction')"
        @rollback-transaction="emit('rollback-transaction')"
        @toggle-auto-commit="emit('toggle-auto-commit')"
        @toggle-sidebar="emit('toggle-sidebar')"
        @toggle-ai="emit('toggle-ai')"
        @toggle-history="emit('toggle-history')"
        @toggle-sql-library="emit('toggle-sql-library')"
        @toggle-sql-file-panel="emit('toggle-sql-file-panel')"
        @toggle-project-file-panel="emit('toggle-project-file-panel')"
        @toggle-git-panel="emit('toggle-git-panel')"
        @toggle-fullscreen="emit('toggle-fullscreen')"
        @open-settings="emit('open-settings', $event)"
        @set-theme-mode="emit('set-theme-mode', $event)"
        @search-files="emit('search-files')"
        @search-metadata="emit('search-metadata')"
        @search-objects="emit('search-objects')"
        @quick-open="emit('quick-open')"
        @search-table-data="emit('search-table-data')"
        @open-sessions="emit('open-sessions')"
        @open-invalid-objects="emit('open-invalid-objects')"
        @open-command-window="emit('open-command-window')"
        @open-table-import="emit('open-table-import')"
        @open-database-export="emit('open-database-export')"
        @open-transfer="emit('open-transfer')"
        @open-sql-file="emit('open-sql-file')"
        @open-schema-diff="emit('open-schema-diff')"
        @open-data-compare="emit('open-data-compare')"
        @open-shortcuts="emit('open-shortcuts')"
        @open-docs="emit('open-docs')"
        @export-debug-logs="emit('export-debug-logs')"
        @open-about="emit('open-about')"
      />
    </span>

    <div class="flex-1" data-tauri-drag-region />

    <div class="flex shrink-0 items-center gap-1">
      <button
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded px-1.5 text-xs font-medium leading-none text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none"
        :title="t('settings.languageTitle')"
        :aria-label="t('settings.languageTitle')"
        @click="toggleLocale"
      >
        <Languages class="h-3.5 w-3.5 text-muted-foreground" />
        <span>{{ localeToggleLabel }}</span>
      </button>
      <ExportProgressPopover />
    </div>

    <WindowControls v-if="showControls" :is-maximized="isMaximized" @minimize="minimize" @toggle-maximize="toggleMaximize" @close="close" />
  </div>
</template>
