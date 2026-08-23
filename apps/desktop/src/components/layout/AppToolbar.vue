<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { Moon, Sun, SunMoon, History, Bot } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import AppMenuBar from "@/components/layout/AppMenuBar.vue";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import WindowControls from "@/components/layout/WindowControls.vue";
import ExportProgressPopover from "@/components/export/ExportProgressPopover.vue";
import { MAC_TRAFFIC_LIGHT_X, macTrafficLightInsetPaddingForScale, shouldReserveMacTrafficLightInset, useWindowControls } from "@/composables/useWindowControls";
import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { isSystemAppThemeMode, type AppThemeMode } from "@/lib/app/appTheme";
import type { SqlProject } from "@/stores/projectStore";

const props = defineProps<{
  isDark: boolean;
  themeMode: AppThemeMode;
  showAiPanel: boolean;
  showHistory: boolean;
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
  "open-settings": [initialTab?: string];
  "search-files": [];
  "search-metadata": [];
  "search-objects": [];
  "open-sessions": [];
  "open-transfer": [];
  "open-sql-file": [];
  "open-schema-diff": [];
  "open-data-compare": [];
  "open-scheduled-backups": [];
  "open-shortcuts": [];
  "open-docs": [];
  "export-debug-logs": [];
  "open-about": [];
}>();

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const toolbarItems = computed(() => settingsStore.editorSettings.toolbarItems);
const { isMac, isDesktop, showControls, isMaximized, isFullscreen, minimize, toggleMaximize, close } = useWindowControls();
const themeTriggerIcon = computed(() => {
  if (isSystemAppThemeMode(props.themeMode)) return SunMoon;
  return props.isDark ? Moon : Sun;
});

const themeCycle: AppThemeMode[] = ["light", "dark", "system"];

function nextThemeMode(mode: AppThemeMode): AppThemeMode {
  const index = themeCycle.indexOf(mode);
  return themeCycle[(index + 1) % themeCycle.length] ?? themeCycle[0];
}

function themeModeLabel(mode: AppThemeMode): string {
  if (mode === "light") return t("toolbar.themeLight");
  if (mode === "dark") return t("toolbar.themeDark");
  return t("toolbar.themeSystem");
}

function cycleThemeMode() {
  const next = nextThemeMode(props.themeMode);
  emit("set-theme-mode", next);
  toast(`${t("toolbar.theme")}: ${themeModeLabel(next)}`, 1600);
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
        @toggle-fullscreen="emit('toggle-fullscreen')"
        @open-settings="emit('open-settings', $event)"
        @set-theme-mode="emit('set-theme-mode', $event)"
        @search-files="emit('search-files')"
        @search-metadata="emit('search-metadata')"
        @search-objects="emit('search-objects')"
        @open-sessions="emit('open-sessions')"
        @open-transfer="emit('open-transfer')"
        @open-sql-file="emit('open-sql-file')"
        @open-schema-diff="emit('open-schema-diff')"
        @open-data-compare="emit('open-data-compare')"
        @open-scheduled-backups="emit('open-scheduled-backups')"
        @open-shortcuts="emit('open-shortcuts')"
        @open-docs="emit('open-docs')"
        @export-debug-logs="emit('export-debug-logs')"
        @open-about="emit('open-about')"
      />
    </span>

    <div class="flex-1" data-tauri-drag-region />

    <div class="flex shrink-0 items-center gap-1">
      <ExportProgressPopover />

      <Tooltip v-if="toolbarItems.history">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" :class="{ 'bg-accent': showHistory }" @click="emit('toggle-history')">
            <History class="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("history.title") }}</TooltipContent>
      </Tooltip>

      <Tooltip v-if="toolbarItems.ai">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" :class="{ 'bg-accent': showAiPanel }" @click="emit('toggle-ai')">
            <Bot class="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>AI</TooltipContent>
      </Tooltip>

      <Tooltip v-if="toolbarItems.theme">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" :aria-label="t('toolbar.theme')" @click="cycleThemeMode">
            <component :is="themeTriggerIcon" class="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.theme") }}</TooltipContent>
      </Tooltip>
    </div>

    <WindowControls v-if="showControls" :is-maximized="isMaximized" @minimize="minimize" @toggle-maximize="toggleMaximize" @close="close" />
  </div>
</template>
