<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Moon, Sun, SunMoon, History, Bot, ArrowLeftRight, FileCode, BookMarked, GitCompareArrows, TableProperties, Settings, CloudDownload, FileDown, FolderTree } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import AppMenuBar from "@/components/layout/AppMenuBar.vue";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import WindowControls from "@/components/layout/WindowControls.vue";
import ExportProgressPopover from "@/components/export/ExportProgressPopover.vue";
import { MAC_TRAFFIC_LIGHT_X, macTrafficLightInsetPaddingForScale, shouldReserveMacTrafficLightInset, useWindowControls } from "@/composables/useWindowControls";
import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { isSystemAppThemeMode, type AppThemeMode } from "@/lib/app/appTheme";

const props = defineProps<{
  isDark: boolean;
  themeMode: AppThemeMode;
  showAiPanel: boolean;
  showHistory: boolean;
  showSqlLibrary: boolean;
  showSqlFilePanel: boolean;
  showDriverStore: boolean;
  showSettingsPage: boolean;
  checkingUpdates: boolean;
  hasUpdateAvailable: boolean;
  agentDriverUpdateCount: number;
  hasConnections: boolean;
  hasSqlFileConnections: boolean;
  hasActiveTab: boolean;
  hasActiveQuery: boolean;
  canSaveSql: boolean;
  showSidebar: boolean;
}>();

const emit = defineEmits<{
  "new-connection": [];
  "new-query": [];
  "open-editor-sql-file": [];
  "save-sql": [];
  "import-result-archive": [];
  "close-active-tab": [];
  "import-config": [];
  "export-config": [];
  "quick-open": [];
  "format-sql": [];
  "compress-sql": [];
  "toggle-sidebar": [];
  "close-other-tabs": [];
  "set-theme-mode": [mode: AppThemeMode];
  "toggle-ai": [];
  "toggle-history": [];
  "toggle-sql-library": [];
  "toggle-sql-file-panel": [];
  "open-settings": [];
  "open-driver-store": [];
  "check-updates": [];
  "open-transfer": [];
  "open-sql-file": [];
  "open-schema-diff": [];
  "open-data-compare": [];
  "open-about": [];
}>();

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const toolbarItems = computed(() => settingsStore.editorSettings.toolbarItems);
const { isMac, isDesktop, showControls, isMaximized, isFullscreen, minimize, toggleMaximize, close } = useWindowControls();
const checkingUpdates = computed(() => props.checkingUpdates);

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
const toolbarCollapsed = ref(false);
const shouldReserveTrafficLightInset = computed(() => shouldReserveMacTrafficLightInset(isMac, isFullscreen.value, isDesktop));

function checkToolbarWidth() {
  const el = toolbarEl.value;
  if (!el) return;
  const screenWidth = window.visualViewport?.width ?? window.innerWidth;
  const threshold = screenWidth / 2;
  toolbarCollapsed.value = el.clientWidth < threshold;
}

// ──────────── Right-side overflow detection ────────────

const rightWrapper = ref<HTMLElement>();
const rightOverflowCount = ref(0);
let toolbarLayoutRaf = 0;
let trafficLightSyncRaf = 0;
let settlingRightOverflow = false;
let pendingRightOverflowSettle = false;
const measuredTrafficLightInset = ref<number | null>(null);

type MacosTrafficLightLayout = {
  x: number;
  y: number;
  center_y: number;
  previous_center_y: number;
  reserved_inset: number;
};

/** Ordered list of right-side item keys that can overflow into "More".
 *  Items earlier in the list overflow first when space shrinks. */
const collapsibleRightItemDefs = computed(() => {
  interface ItemDef {
    key: string;
    label: string;
    icon: any;
    action: () => void;
    disabled: boolean;
  }
  const items: ItemDef[] = [];
  if (toolbarItems.value.checkUpdates) {
    items.push({
      key: "checkUpdates",
      label: t("updates.check"),
      icon: CloudDownload,
      action: () => emit("check-updates"),
      disabled: checkingUpdates.value,
    });
  }
  items.push({
    key: "exportProgress",
    label: t("exportProgress.tooltip"),
    icon: FileDown,
    action: () => {},
    disabled: false,
  });
  if (toolbarItems.value.sqlLibrary) {
    items.push({
      key: "sqlLibrary",
      label: t("sqlLibrary.title"),
      icon: BookMarked,
      action: () => emit("toggle-sql-library"),
      disabled: false,
    });
  }
  if (toolbarItems.value.sqlFileTree) {
    items.push({
      key: "sqlFileTree",
      label: t("sqlFileTree.title"),
      icon: FolderTree,
      action: () => emit("toggle-sql-file-panel"),
      disabled: false,
    });
  }
  if (toolbarItems.value.history) {
    items.push({
      key: "history",
      label: t("history.title"),
      icon: History,
      action: () => emit("toggle-history"),
      disabled: false,
    });
  }
  if (toolbarItems.value.ai) {
    items.push({
      key: "ai",
      label: "AI",
      icon: Bot,
      action: () => emit("toggle-ai"),
      disabled: false,
    });
  }
  if (toolbarItems.value.theme) {
    items.push({
      key: "theme",
      label: t("toolbar.theme"),
      icon: themeTriggerIcon.value,
      action: cycleThemeMode,
      disabled: false,
    });
  }
  return items;
});

const overflowedRightKeys = computed(() => {
  const defs = collapsibleRightItemDefs.value;
  const overflowKeys = defs.slice(0, rightOverflowCount.value).map((d) => d.key);
  return new Set(overflowKeys);
});

/** Overflowed right items to show in the "More" dropdown. */
const overflowRightMenuItems = computed(() => {
  const defs = collapsibleRightItemDefs.value;
  return defs.slice(0, rightOverflowCount.value).map((d) => ({
    value: d.key,
    label: d.label,
    icon: d.icon,
    action: d.action,
    disabled: d.disabled,
  }));
});

async function settleRightOverflowOnce() {
  const wrapper = rightWrapper.value;
  if (!wrapper) return;

  const defsLength = collapsibleRightItemDefs.value.length;
  if (rightOverflowCount.value > defsLength) {
    rightOverflowCount.value = defsLength;
    await nextTick();
  }

  for (let i = 0; i <= defsLength + 1; i++) {
    const current = rightWrapper.value;
    if (!current) return;

    if (current.scrollWidth > current.clientWidth + 1 && rightOverflowCount.value < defsLength) {
      rightOverflowCount.value++;
      await nextTick();
      continue;
    }

    if (rightOverflowCount.value <= 0) return;

    rightOverflowCount.value--;
    await nextTick();

    const restored = rightWrapper.value;
    if (restored && restored.scrollWidth <= restored.clientWidth + 1) {
      continue;
    }

    rightOverflowCount.value++;
    await nextTick();
    return;
  }
}

async function settleRightOverflow() {
  if (settlingRightOverflow) {
    pendingRightOverflowSettle = true;
    return;
  }

  settlingRightOverflow = true;
  try {
    do {
      pendingRightOverflowSettle = false;
      await nextTick();
      await settleRightOverflowOnce();
    } while (pendingRightOverflowSettle);
  } finally {
    settlingRightOverflow = false;
  }
}

function scheduleToolbarLayout() {
  if (toolbarLayoutRaf) cancelAnimationFrame(toolbarLayoutRaf);
  toolbarLayoutRaf = requestAnimationFrame(() => {
    toolbarLayoutRaf = 0;
    checkToolbarWidth();
    scheduleTrafficLightSync();
    void settleRightOverflow();
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

watch(collapsibleRightItemDefs, () => scheduleToolbarLayout(), { flush: "post" });
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
  if (rightWrapper.value) resizeObserver.observe(rightWrapper.value);
  window.addEventListener("resize", handleWindowResize);
  scheduleToolbarLayout();
});

onBeforeUnmount(() => {
  if (toolbarLayoutRaf) cancelAnimationFrame(toolbarLayoutRaf);
  if (trafficLightSyncRaf) cancelAnimationFrame(trafficLightSyncRaf);
  resizeObserver?.disconnect();
  window.removeEventListener("resize", handleWindowResize);
});

// ──────────── Left-side "More" items ────────────

const moreItems = computed(() => {
  const items: Array<{ value: string; label: string; icon: any; action: () => void; disabled: boolean }> = [];

  // Hidden left-side items go into "More"
  if (!toolbarItems.value.dataTransfer) {
    items.push({
      value: "transfer",
      label: t("transfer.dataTransfer"),
      icon: ArrowLeftRight,
      action: () => emit("open-transfer"),
      disabled: !props.hasConnections,
    });
  }

  // "More" menu items (individually toggleable)
  if (toolbarItems.value.sqlFile) {
    items.push({
      value: "sql-file",
      label: t("sqlFile.title"),
      icon: FileCode,
      action: () => emit("open-sql-file"),
      disabled: !props.hasSqlFileConnections,
    });
  }
  if (toolbarItems.value.schemaDiff) {
    items.push({
      value: "schema-diff",
      label: t("diff.title"),
      icon: GitCompareArrows,
      action: () => emit("open-schema-diff"),
      disabled: !props.hasConnections,
    });
  }
  if (toolbarItems.value.dataCompare) {
    items.push({
      value: "data-compare",
      label: t("dataCompare.title"),
      icon: TableProperties,
      action: () => emit("open-data-compare"),
      disabled: !props.hasConnections,
    });
  }

  // Append overflowed right-side items at the end
  for (const ri of overflowRightMenuItems.value) {
    items.push({
      value: `right-${ri.value}`,
      label: ri.label,
      icon: ri.icon,
      action: ri.action,
      disabled: ri.disabled,
    });
  }

  return items;
});

const showMoreDropdown = computed(() => moreItems.value.length > 0);

const collapsedItems = computed(() => {
  const items: Array<{ value: string; label: string; icon: any; action: () => void; disabled: boolean }> = [];
  if (toolbarItems.value.dataTransfer) {
    items.push({
      value: "transfer",
      label: t("transfer.dataTransfer"),
      icon: ArrowLeftRight,
      action: () => emit("open-transfer"),
      disabled: !props.hasConnections,
    });
  }
  // Always include moreItems (may contain hidden left-side items + overflowed right items)
  if (moreItems.value.length > 0) {
    items.push(...moreItems.value);
  }
  return items;
});

function runMoreItem(value: string) {
  const item = moreItems.value.find((i) => i.value === value);
  item?.action();
}

function runCollapsedItem(value: string) {
  const item = collapsedItems.value.find((i) => i.value === value);
  item?.action();
}

// Per-item overflow visibility helper
function isRightItemVisible(key: string) {
  return !overflowedRightKeys.value.has(key);
}

const toolbarTextButtonClass = "h-8 px-2 text-xs gap-1 leading-none";
const toolbarTextLabelClass = "inline-flex translate-y-px items-center leading-none";
const toolbarDropdownTriggerClass = `inline-flex h-8 items-center gap-1 rounded-[6px] px-2 text-xs font-medium leading-none hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 transition-colors [&>span:first-child]:translate-y-px`;
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
        :can-save-sql="canSaveSql"
        :has-sql-file-connections="hasSqlFileConnections"
        :show-sidebar="showSidebar"
        :theme-mode="themeMode"
        @new-connection="emit('new-connection')"
        @new-query="emit('new-query')"
        @open-editor-sql-file="emit('open-editor-sql-file')"
        @save-sql="emit('save-sql')"
        @import-result-archive="emit('import-result-archive')"
        @close-active-tab="emit('close-active-tab')"
        @import-config="emit('import-config')"
        @export-config="emit('export-config')"
        @quick-open="emit('quick-open')"
        @format-sql="emit('format-sql')"
        @compress-sql="emit('compress-sql')"
        @toggle-sidebar="emit('toggle-sidebar')"
        @close-other-tabs="emit('close-other-tabs')"
        @toggle-ai="emit('toggle-ai')"
        @toggle-history="emit('toggle-history')"
        @toggle-sql-library="emit('toggle-sql-library')"
        @toggle-sql-file-panel="emit('toggle-sql-file-panel')"
        @open-settings="emit('open-settings')"
        @set-theme-mode="emit('set-theme-mode', $event)"
        @open-driver-store="emit('open-driver-store')"
        @open-transfer="emit('open-transfer')"
        @open-sql-file="emit('open-sql-file')"
        @open-schema-diff="emit('open-schema-diff')"
        @open-data-compare="emit('open-data-compare')"
        @check-updates="emit('check-updates')"
        @open-about="emit('open-about')"
      />
    </span>

    <template v-if="!toolbarCollapsed">
      <Button v-if="toolbarItems.dataTransfer" variant="ghost" size="sm" :class="toolbarTextButtonClass" @click="emit('open-transfer')" :disabled="!hasConnections">
        <ArrowLeftRight class="h-3.5 w-3.5" />
        <span :class="toolbarTextLabelClass">{{ t("transfer.dataTransfer") }}</span>
      </Button>

      <LightDropdown
        v-if="showMoreDropdown"
        model-value=""
        :items="moreItems"
        :aria-label="t('common.more')"
        :trigger-label="t('common.more')"
        :trigger-class="toolbarDropdownTriggerClass"
        :show-trigger-label="true"
        :show-chevron="true"
        check-position="none"
        align="start"
        @update:model-value="runMoreItem"
      />
    </template>

    <template v-if="toolbarCollapsed">
      <LightDropdown
        v-if="collapsedItems.length > 0"
        model-value=""
        :items="collapsedItems"
        :aria-label="t('common.more')"
        :trigger-label="t('common.more')"
        :trigger-class="toolbarDropdownTriggerClass"
        :show-trigger-label="true"
        :show-chevron="true"
        check-position="none"
        align="start"
        @update:model-value="runCollapsedItem"
      />
    </template>

    <div class="flex-1" data-tauri-drag-region />

    <!-- Right-side items wrapped in overflow-aware container -->
    <div ref="rightWrapper" class="flex min-w-0 items-center gap-1 overflow-hidden">
      <template v-if="toolbarItems.checkUpdates">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button v-show="isRightItemVisible('checkUpdates')" variant="ghost" size="icon" class="relative h-8 w-8 shrink-0" :disabled="checkingUpdates" @click="emit('check-updates')">
              <Loader2 v-if="checkingUpdates" class="h-4 w-4 animate-spin" />
              <CloudDownload v-else class="h-4 w-4" />
              <span v-if="hasUpdateAvailable" class="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-background" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t("updates.check") }}</TooltipContent>
        </Tooltip>
      </template>

      <div v-show="isRightItemVisible('exportProgress')" class="contents">
        <ExportProgressPopover />
      </div>

      <Tooltip v-if="toolbarItems.sqlLibrary">
        <TooltipTrigger as-child>
          <Button v-show="isRightItemVisible('sqlLibrary')" variant="ghost" size="icon" class="h-8 w-8 shrink-0" :class="{ 'bg-accent': showSqlLibrary }" @click="emit('toggle-sql-library')">
            <BookMarked class="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("sqlLibrary.title") }}</TooltipContent>
      </Tooltip>

      <Tooltip v-if="toolbarItems.sqlFileTree">
        <TooltipTrigger as-child>
          <Button v-show="isRightItemVisible('sqlFileTree')" variant="ghost" size="icon" class="h-8 w-8 shrink-0" :class="{ 'bg-accent': showSqlFilePanel }" @click="emit('toggle-sql-file-panel')">
            <FolderTree class="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("sqlFileTree.title") }}</TooltipContent>
      </Tooltip>

      <Tooltip v-if="toolbarItems.history">
        <TooltipTrigger as-child>
          <Button v-show="isRightItemVisible('history')" variant="ghost" size="icon" class="h-8 w-8 shrink-0" :class="{ 'bg-accent': showHistory }" @click="emit('toggle-history')">
            <History class="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("history.title") }}</TooltipContent>
      </Tooltip>

      <Tooltip v-if="toolbarItems.ai">
        <TooltipTrigger as-child>
          <Button v-show="isRightItemVisible('ai')" variant="ghost" size="icon" class="h-8 w-8 shrink-0" :class="{ 'bg-accent': showAiPanel }" @click="emit('toggle-ai')">
            <Bot class="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>AI</TooltipContent>
      </Tooltip>

      <Tooltip v-if="toolbarItems.theme">
        <TooltipTrigger as-child>
          <Button v-show="isRightItemVisible('theme')" variant="ghost" size="icon" class="h-8 w-8 shrink-0" :aria-label="t('toolbar.theme')" @click="cycleThemeMode">
            <component :is="themeTriggerIcon" class="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.theme") }}</TooltipContent>
      </Tooltip>
    </div>
    <!-- /rightWrapper -->

    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon" class="relative h-8 w-8 shrink-0" :class="{ 'bg-accent': showSettingsPage }" @click="emit('open-settings')">
          <Settings class="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ t("settings.title") }}</TooltipContent>
    </Tooltip>

    <WindowControls v-if="showControls" :is-maximized="isMaximized" @minimize="minimize" @toggle-maximize="toggleMaximize" @close="close" />
  </div>
</template>
