<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  Activity,
  ArrowLeftRight,
  BookMarked,
  BookOpen,
  Bot,
  CalendarClock,
  Check,
  Clipboard,
  ClipboardPaste,
  Copy,
  DatabaseZap,
  Download,
  ExternalLink,
  FileCode,
  FileDown,
  FileInput,
  FileOutput,
  FilePlus2,
  FolderOpen,
  FolderSearch,
  GitCompareArrows,
  History,
  Info,
  Keyboard,
  Layers,
  Maximize2,
  Minimize2,
  PanelLeft,
  Play,
  PlayCircle,
  Redo2,
  RotateCcw,
  Scissors,
  Search,
  ShieldCheck,
  Sparkles,
  SunMoon,
  TableProperties,
  Undo2,
  Upload,
  X,
  Zap,
} from "@lucide/vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AppThemeMode } from "@/lib/app/appTheme";
import { formatShortcutDisplay } from "@/lib/editor/shortcutDisplay";
import type { ShortcutActionId } from "@/lib/editor/shortcutRegistry";
import { useSettingsStore } from "@/stores/settingsStore";
import type { SqlProject } from "@/stores/projectStore";

const props = defineProps<{
  hasConnections: boolean;
  hasActiveTab: boolean;
  hasActiveQuery: boolean;
  hasActiveTransaction?: boolean;
  canSaveSql: boolean;
  hasSqlFileConnections: boolean;
  themeMode: AppThemeMode;
  projects: SqlProject[];
  activeProjectId?: string;
  autoCommit?: boolean;
  isMac?: boolean;
  sidebarOpen?: boolean;
  isFullscreen?: boolean;
}>();

const emit = defineEmits<{
  "new-connection": [];
  "new-query": [];
  "open-editor-sql-file": [];
  "save-sql": [];
  "save-sql-as": [];
  "import-result-archive": [];
  "close-active-tab": [];
  "close-other-tabs": [];
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
  "toggle-ai": [];
  "toggle-history": [];
  "toggle-sql-library": [];
  "toggle-sql-file-panel": [];
  "toggle-fullscreen": [];
  "search-files": [];
  "search-metadata": [];
  "search-objects": [];
  "open-sessions": [];
  "open-table-import": [];
  "open-database-export": [];
  "open-transfer": [];
  "open-sql-file": [];
  "open-schema-diff": [];
  "open-data-compare": [];
  "open-scheduled-backups": [];
  "quick-open": [];
  "search-table-data": [];
  "open-settings": [];
  "set-theme-mode": [mode: AppThemeMode];
  "open-shortcuts": [];
  "open-docs": [];
  "export-debug-logs": [];
  "open-about": [];
}>();

const { t } = useI18n();
const settingsStore = useSettingsStore();

const isMacPlatform = computed(() => props.isMac || (typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform)));

function shortcutLabel(action: ShortcutActionId): string {
  const shortcut = settingsStore.editorSettings.shortcuts[action];
  return formatShortcutDisplay(shortcut, isMacPlatform.value ? "MacIntel" : "Win32");
}

const menuTriggerClass = "inline-flex h-7 items-center rounded px-2 text-xs font-medium leading-none text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none select-none";
const menuItemClass = "gap-2 text-xs cursor-pointer py-1.5";
const menuIconClass = "h-3.5 w-3.5 text-muted-foreground shrink-0";
const shortcutClass = "ml-auto pl-5 text-[10px] font-mono text-muted-foreground/70";
</script>

<template>
  <nav class="app-menu-bar flex h-8 shrink-0 items-center gap-0.5" role="menubar" :aria-label="t('menus.application')">
    <!-- 1. 文件 (File) -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.file") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-60">
        <DropdownMenuItem :class="menuItemClass" @select="emit('new-connection')">
          <DatabaseZap :class="menuIconClass" />
          <span>{{ t("toolbar.newConnection") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('new-query')">
          <FilePlus2 :class="menuIconClass" />
          <span>{{ t("toolbar.newQuery") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("newQuery") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('open-editor-sql-file')">
          <FolderOpen :class="menuIconClass" />
          <span>{{ t("menus.openSqlFile") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!canSaveSql" :class="menuItemClass" @select="emit('save-sql')">
          <FileDown :class="menuIconClass" />
          <span>{{ t("menus.saveSql") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("saveSql") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!canSaveSql" :class="menuItemClass" @select="emit('save-sql-as')">
          <FileOutput :class="menuIconClass" />
          <span>{{ t("menus.saveSqlAs") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('import-result-archive')">
          <FileInput :class="menuIconClass" />
          <span>{{ t("menus.importResult") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :class="menuItemClass" @select="emit('import-config')">
          <FileInput :class="menuIconClass" />
          <span>{{ t("menus.importConnections") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('export-config')">
          <FileOutput :class="menuIconClass" />
          <span>{{ t("menus.exportConnections") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!hasActiveTab" :class="menuItemClass" @select="emit('close-active-tab')">
          <X :class="menuIconClass" />
          <span>{{ t("menus.closeTab") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("closeTab") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveTab" :class="menuItemClass" @select="emit('close-other-tabs')">
          <Layers :class="menuIconClass" />
          <span>{{ t("menus.closeOtherTabs") }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- 2. 项目 (Project) -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.project") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-64">
        <DropdownMenuItem :class="menuItemClass" @select="emit('create-project')">
          <FolderOpen :class="menuIconClass" />
          <span>{{ t("menus.createProject") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('open-project')">
          <FolderSearch :class="menuIconClass" />
          <span>{{ t("menus.openProject") }}</span>
        </DropdownMenuItem>
        <template v-if="projects.length">
          <DropdownMenuSeparator />
          <DropdownMenuLabel class="px-2 py-1 text-[10px] text-muted-foreground">{{ t("menus.recentProjects") }}</DropdownMenuLabel>
          <DropdownMenuItem v-for="project in projects" :key="project.id" :class="menuItemClass" @select="emit('select-project', project.id)">
            <FolderOpen :class="menuIconClass" />
            <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
            <span v-if="project.id === activeProjectId" class="text-[10px] text-primary">✓</span>
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- 3. 编辑 (Edit) -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.edit") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-60">
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('undo')">
          <Undo2 :class="menuIconClass" />
          <span>{{ t("menus.undo") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("undo") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('redo')">
          <Redo2 :class="menuIconClass" />
          <span>{{ t("menus.redo") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("redo") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('cut')">
          <Scissors :class="menuIconClass" />
          <span>{{ t("menus.cut") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('copy')">
          <Copy :class="menuIconClass" />
          <span>{{ t("menus.copy") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('paste')">
          <ClipboardPaste :class="menuIconClass" />
          <span>{{ t("menus.paste") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('find')">
          <Search :class="menuIconClass" />
          <span>{{ t("menus.find") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("find") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('replace')">
          <Clipboard :class="menuIconClass" />
          <span>{{ t("menus.replace") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("replace") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('format-sql')">
          <Sparkles :class="menuIconClass" />
          <span>{{ t("toolbar.formatSql") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("formatSql") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('compress-sql')">
          <Minimize2 :class="menuIconClass" />
          <span>{{ t("toolbar.compressSql") }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- 4. 执行与事务 (Run & Transaction) -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.runTransaction") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-64">
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('execute-sql')">
          <Play :class="menuIconClass" class="text-emerald-500" />
          <span>{{ t("toolbar.execute") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("executeSql") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('execute-current-statement')">
          <PlayCircle :class="menuIconClass" class="text-sky-500" />
          <span>{{ t("menus.executeCurrentStatement") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('explain-sql')">
          <Activity :class="menuIconClass" class="text-amber-500" />
          <span>{{ t("toolbar.explainPlan") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!hasActiveTransaction" :class="menuItemClass" @select="emit('commit-transaction')">
          <Check :class="menuIconClass" class="text-emerald-600" />
          <span>{{ t("toolbar.commit") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveTransaction" :class="menuItemClass" @select="emit('rollback-transaction')">
          <RotateCcw :class="menuIconClass" class="text-destructive" />
          <span>{{ t("toolbar.rollback") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('toggle-auto-commit')">
          <ShieldCheck :class="menuIconClass" />
          <span class="flex-1">{{ t("toolbar.autoCommit") }}</span>
          <span v-if="autoCommit !== false" class="text-primary font-bold text-xs">✓</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- 5. 视图 (View) -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.view") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-60">
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-sidebar')">
          <PanelLeft :class="menuIconClass" />
          <span>{{ t(sidebarOpen ? "menus.hideSidebar" : "menus.showSidebar") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("toggleSidebar") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-ai')">
          <Bot :class="menuIconClass" class="text-indigo-500" />
          <span>{{ t("menus.aiAssistant") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-history')">
          <History :class="menuIconClass" />
          <span>{{ t("history.title") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-sql-library')">
          <BookMarked :class="menuIconClass" />
          <span>{{ t("sqlLibrary.title") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-sql-file-panel')">
          <FileCode :class="menuIconClass" />
          <span>{{ t("sqlFileTree.title") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger :class="menuItemClass">
            <span class="inline-flex items-center gap-2">
              <SunMoon :class="menuIconClass" />
              <span>{{ t("menus.theme") }}</span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent class="w-44">
              <DropdownMenuItem :class="menuItemClass" @select="emit('set-theme-mode', 'light')">
                <span class="w-3.5 text-center text-muted-foreground">{{ themeMode === "light" ? "✓" : "" }}</span>
                <span>{{ t("toolbar.themeLight") }}</span>
              </DropdownMenuItem>
              <DropdownMenuItem :class="menuItemClass" @select="emit('set-theme-mode', 'dark')">
                <span class="w-3.5 text-center text-muted-foreground">{{ themeMode === "dark" ? "✓" : "" }}</span>
                <span>{{ t("toolbar.themeDark") }}</span>
              </DropdownMenuItem>
              <DropdownMenuItem :class="menuItemClass" @select="emit('set-theme-mode', 'system')">
                <span class="w-3.5 text-center text-muted-foreground">{{ themeMode === "system" ? "✓" : "" }}</span>
                <span>{{ t("toolbar.themeSystem") }}</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-fullscreen')">
          <Maximize2 :class="menuIconClass" />
          <span>{{ t(isFullscreen ? "diagram.exitFullscreen" : "diagram.fullscreen") }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- 6. 搜索 (Search) -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.search") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-64">
        <DropdownMenuItem :class="menuItemClass" @select="emit('quick-open')">
          <Zap :class="menuIconClass" class="text-amber-500" />
          <span>{{ t("menus.quickOpen") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("quickOpen") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('search-objects')">
          <FileCode :class="menuIconClass" class="text-blue-500" />
          <span>{{ t("searchCenter.menuSource") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("searchObjectSource") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('search-metadata')">
          <TableProperties :class="menuIconClass" />
          <span>{{ t("menus.searchMetadata") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("searchMetadata") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('search-table-data')">
          <Search :class="menuIconClass" class="text-emerald-500" />
          <span>{{ t("searchCenter.menuTableData") }}</span>
          <span :class="shortcutClass">{{ shortcutLabel("searchTableData") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :class="menuItemClass" @select="emit('search-files')">
          <FolderSearch :class="menuIconClass" />
          <span>{{ t("menus.searchFiles") }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- 7. 工具 (Tools) -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.tools") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-60">
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('open-sessions')">
          <Activity :class="menuIconClass" class="text-primary" />
          <span>{{ t("processList.title") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('open-table-import')">
          <Download :class="menuIconClass" />
          <span>{{ t("contextMenu.importData") }}...</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('open-database-export')">
          <Upload :class="menuIconClass" />
          <span>{{ t("contextMenu.exportDatabase") }}...</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('open-transfer')">
          <ArrowLeftRight :class="menuIconClass" />
          <span>{{ t("transfer.dataTransfer") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasSqlFileConnections" :class="menuItemClass" @select="emit('open-sql-file')">
          <FileCode :class="menuIconClass" />
          <span>{{ t("sqlFile.title") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('open-schema-diff')">
          <GitCompareArrows :class="menuIconClass" />
          <span>{{ t("diff.title") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('open-data-compare')">
          <TableProperties :class="menuIconClass" />
          <span>{{ t("dataCompare.title") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-sql-library')">
          <BookMarked :class="menuIconClass" />
          <span>{{ t("sqlLibrary.title") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-sql-file-panel')">
          <FileCode :class="menuIconClass" />
          <span>{{ t("sqlFileTree.title") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('open-scheduled-backups')">
          <CalendarClock :class="menuIconClass" />
          <span>{{ t("databaseBackup.title") }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- 8. 设置 (Settings) - 直接点击打开设置对话框 -->
    <button type="button" :class="menuTriggerClass" role="menuitem" :title="t('settings.title')" @click="emit('open-settings')">
      {{ t("menus.settings") }}
    </button>

    <!-- 9. 帮助 (Help) -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.help") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-56">
        <DropdownMenuItem :class="menuItemClass" @select="emit('open-shortcuts')">
          <Keyboard :class="menuIconClass" />
          <span>{{ t("settings.shortcutsTab") }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('open-docs')">
          <BookOpen :class="menuIconClass" />
          <span>{{ t("settings.officialDocs") }}</span>
          <ExternalLink class="h-3 w-3 text-muted-foreground ml-auto" />
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('export-debug-logs')">
          <Download :class="menuIconClass" />
          <span>{{ t("settings.debugLogsDownload") }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :class="menuItemClass" @select="emit('open-about')">
          <Info :class="menuIconClass" />
          <span>{{ t("about.title") }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </nav>
</template>
