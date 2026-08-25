<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { BookMarked, Bot, Database, FolderOpen, History, Moon, Settings, Sun, SunMoon } from "@lucide/vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import type { AppThemeMode } from "@/lib/app/appTheme";
import { isSystemAppThemeMode } from "@/lib/app/appTheme";

export type ActivityPanelId = "connections" | "files" | "library" | "history" | "ai";

const props = defineProps<{
  activePanels: ActivityPanelId[];
  isDark: boolean;
  themeMode: AppThemeMode;
  showHistory: boolean;
  showAi: boolean;
  showTheme: boolean;
}>();

const emit = defineEmits<{
  "toggle-panel": [panelId: ActivityPanelId];
  "cycle-theme": [];
  "open-settings": [];
}>();

const { t } = useI18n();

const themeIcon = computed(() => {
  if (isSystemAppThemeMode(props.themeMode)) return SunMoon;
  return props.isDark ? Moon : Sun;
});

function isPanelActive(panelId: ActivityPanelId): boolean {
  return props.activePanels.includes(panelId);
}

function handlePanelClick(panelId: ActivityPanelId) {
  emit("toggle-panel", panelId);
}
</script>

<template>
  <aside class="app-activity-bar flex flex-col justify-between items-center w-11 shrink-0 border-r bg-muted/40 z-30 select-none py-2" role="navigation" :aria-label="t('activityBar.navigation')">
    <!-- Top View Switchers -->
    <div class="flex flex-col items-center gap-1.5 w-full px-1">
      <!-- 1. Database Connections -->
      <LightTooltip :text="t('activityBar.connections')" side="right" :delay="150" :close-delay="0" nowrap>
        <button
          type="button"
          class="relative flex items-center justify-center w-9 h-9 rounded-lg transition-all"
          :class="[isPanelActive('connections') ? 'bg-background text-primary shadow-sm ring-1 ring-border/80' : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground']"
          :aria-label="t('activityBar.connections')"
          :aria-pressed="isPanelActive('connections')"
          @click="handlePanelClick('connections')"
        >
          <!-- Active Left Accent Indicator Bar -->
          <span v-if="isPanelActive('connections')" class="absolute -left-1 w-1 h-5 rounded-r bg-primary shadow-sm" />
          <Database class="h-4 w-4" />
        </button>
      </LightTooltip>

      <!-- 2. Project Files -->
      <LightTooltip :text="t('activityBar.projectFiles')" side="right" :delay="150" :close-delay="0" nowrap>
        <button
          type="button"
          class="relative flex items-center justify-center w-9 h-9 rounded-lg transition-all"
          :class="[isPanelActive('files') ? 'bg-background text-primary shadow-sm ring-1 ring-border/80' : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground']"
          :aria-label="t('activityBar.projectFiles')"
          :aria-pressed="isPanelActive('files')"
          @click="handlePanelClick('files')"
        >
          <span v-if="isPanelActive('files')" class="absolute -left-1 w-1 h-5 rounded-r bg-primary shadow-sm" />
          <FolderOpen class="h-4 w-4" />
        </button>
      </LightTooltip>

      <!-- 3. SQL Library -->
      <LightTooltip :text="t('activityBar.sqlLibrary')" side="right" :delay="150" :close-delay="0" nowrap>
        <button
          type="button"
          class="relative flex items-center justify-center w-9 h-9 rounded-lg transition-all"
          :class="[isPanelActive('library') ? 'bg-background text-primary shadow-sm ring-1 ring-border/80' : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground']"
          :aria-label="t('activityBar.sqlLibrary')"
          :aria-pressed="isPanelActive('library')"
          @click="handlePanelClick('library')"
        >
          <span v-if="isPanelActive('library')" class="absolute -left-1 w-1 h-5 rounded-r bg-primary shadow-sm" />
          <BookMarked class="h-4 w-4" />
        </button>
      </LightTooltip>

      <!-- 4. Query History -->
      <LightTooltip v-if="showHistory" :text="t('activityBar.history')" side="right" :delay="150" :close-delay="0" nowrap>
        <button
          type="button"
          class="relative flex items-center justify-center w-9 h-9 rounded-lg transition-all"
          :class="[isPanelActive('history') ? 'bg-background text-primary shadow-sm ring-1 ring-border/80' : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground']"
          :aria-label="t('activityBar.history')"
          :aria-pressed="isPanelActive('history')"
          @click="handlePanelClick('history')"
        >
          <span v-if="isPanelActive('history')" class="absolute -left-1 w-1 h-5 rounded-r bg-primary shadow-sm" />
          <History class="h-4 w-4" />
        </button>
      </LightTooltip>

      <!-- 5. AI Assistant -->
      <LightTooltip v-if="showAi" :text="t('activityBar.ai')" side="right" :delay="150" :close-delay="0" nowrap>
        <button
          type="button"
          class="relative flex items-center justify-center w-9 h-9 rounded-lg transition-all"
          :class="[isPanelActive('ai') ? 'bg-background text-indigo-600 dark:text-indigo-400 shadow-sm ring-1 ring-border/80' : 'text-muted-foreground hover:bg-muted/80 hover:text-indigo-600 dark:hover:text-indigo-400']"
          :aria-label="t('activityBar.ai')"
          :aria-pressed="isPanelActive('ai')"
          @click="handlePanelClick('ai')"
        >
          <span v-if="isPanelActive('ai')" class="absolute -left-1 w-1 h-5 rounded-r bg-indigo-500 shadow-sm" />
          <Bot class="h-4 w-4" />
        </button>
      </LightTooltip>
    </div>

    <!-- Bottom Actions -->
    <div class="flex flex-col items-center gap-1.5 w-full px-1">
      <LightTooltip :text="t('activityBar.settings')" side="right" :delay="150" :close-delay="0" nowrap>
        <button type="button" class="flex items-center justify-center w-9 h-9 rounded-lg text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors" :aria-label="t('activityBar.settings')" @click="emit('open-settings')">
          <Settings class="h-4 w-4" />
        </button>
      </LightTooltip>

      <!-- Theme Switcher -->
      <LightTooltip v-if="showTheme" :text="t('activityBar.theme')" side="right" :delay="150" :close-delay="0" nowrap>
        <button type="button" class="flex items-center justify-center w-9 h-9 rounded-lg text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors" :aria-label="t('activityBar.theme')" @click="emit('cycle-theme')">
          <component :is="themeIcon" class="h-4 w-4" />
        </button>
      </LightTooltip>
    </div>
  </aside>
</template>

<style scoped>
.app-activity-bar {
  background: var(--muted);
  border-color: var(--border);
  backdrop-filter: blur(12px) saturate(1.12);
  -webkit-backdrop-filter: blur(12px) saturate(1.12);
  box-shadow: inset -1px 0 0 var(--border);
  box-shadow: inset -1px 0 0 color-mix(in oklab, var(--border) 62%, transparent);
}

@supports (background: color-mix(in oklab, white 50%, transparent)) {
  .app-activity-bar {
    background: color-mix(in oklab, var(--muted) 68%, transparent);
    border-color: color-mix(in oklab, var(--border) 58%, transparent);
  }
}
</style>
