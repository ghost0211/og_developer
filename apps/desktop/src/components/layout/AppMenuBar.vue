<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ArrowLeftRight, BookMarked, Clipboard, ClipboardPaste, Copy, DatabaseZap, FileCode, FileDown, FileInput, FileOutput, FilePlus2, FolderOpen, FolderSearch, GitCompareArrows, Info, PanelLeft, Redo2, Scissors, Search, Settings, SunMoon, TableProperties, Undo2, X } from "@lucide/vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AppThemeMode } from "@/lib/app/appTheme";
import type { SqlProject } from "@/stores/projectStore";

const props = defineProps<{
  hasConnections: boolean;
  hasActiveTab: boolean;
  hasActiveQuery: boolean;
  canSaveSql: boolean;
  hasSqlFileConnections: boolean;
  showSidebar: boolean;
  themeMode: AppThemeMode;
  projects: SqlProject[];
  activeProjectId?: string;
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
  "toggle-sidebar": [];
  "search-files": [];
  "search-metadata": [];
  "search-objects": [];
  "close-other-tabs": [];
  "toggle-ai": [];
  "toggle-history": [];
  "toggle-sql-library": [];
  "toggle-sql-file-panel": [];
  "open-settings": [];
  "set-theme-mode": [mode: AppThemeMode];
  "open-transfer": [];
  "open-sql-file": [];
  "open-schema-diff": [];
  "open-data-compare": [];
  "open-about": [];
}>();

const { t } = useI18n();
const menuTriggerClass = "inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium leading-none text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none";
const menuItemClass = "gap-2";
const menuIconClass = "h-3.5 w-3.5 text-muted-foreground";
const shortcutClass = "ml-auto pl-6 text-[10px] text-muted-foreground";
</script>

<template>
  <nav class="app-menu-bar flex h-8 shrink-0 items-center gap-0.5" role="menubar" :aria-label="t('menus.application')">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.file") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-56">
        <DropdownMenuItem :class="menuItemClass" @select="emit('new-connection')">
          <DatabaseZap :class="menuIconClass" />
          {{ t("toolbar.newConnection") }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('new-query')">
          <FilePlus2 :class="menuIconClass" />
          {{ t("toolbar.newQuery") }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('open-editor-sql-file')">
          <FolderOpen :class="menuIconClass" />
          {{ t("menus.openSqlFile") }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!canSaveSql" :class="menuItemClass" @select="emit('save-sql')">
          <FileDown :class="menuIconClass" />
          {{ t("menus.saveSql") }}
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('import-result-archive')">
          <FileInput :class="menuIconClass" />
          {{ t("menus.importResult") }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :class="menuItemClass" @select="emit('import-config')">
          <FileInput :class="menuIconClass" />
          {{ t("menus.importConnections") }}
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('export-config')">
          <FileOutput :class="menuIconClass" />
          {{ t("menus.exportConnections") }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!hasActiveTab" :class="menuItemClass" @select="emit('close-active-tab')">
          <X :class="menuIconClass" />
          {{ t("menus.closeTab") }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.project") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-64">
        <DropdownMenuItem :class="menuItemClass" @select="emit('create-project')">
          <FolderOpen :class="menuIconClass" />
          {{ t("menus.createProject") }}
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('open-project')">
          <FolderSearch :class="menuIconClass" />
          {{ t("menus.openProject") }}
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

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.edit") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-56">
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('undo')">
          <Undo2 :class="menuIconClass" />
          {{ t("menus.undo") }}
          <span :class="shortcutClass">Ctrl+Z</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('redo')">
          <Redo2 :class="menuIconClass" />
          {{ t("menus.redo") }}
          <span :class="shortcutClass">Ctrl+Y</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('cut')">
          <Scissors :class="menuIconClass" />
          {{ t("menus.cut") }}
          <span :class="shortcutClass">Ctrl+X</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('copy')">
          <Copy :class="menuIconClass" />
          {{ t("menus.copy") }}
          <span :class="shortcutClass">Ctrl+C</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('paste')">
          <ClipboardPaste :class="menuIconClass" />
          {{ t("menus.paste") }}
          <span :class="shortcutClass">Ctrl+V</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('find')">
          <Search :class="menuIconClass" />
          {{ t("menus.find") }}
          <span :class="shortcutClass">Ctrl+F</span>
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('replace')">
          <Clipboard :class="menuIconClass" />
          {{ t("menus.replace") }}
          <span :class="shortcutClass">Ctrl+H</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('format-sql')">
          <FileCode :class="menuIconClass" />
          {{ t("toolbar.formatSql") }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveQuery" :class="menuItemClass" @select="emit('compress-sql')">
          <FileCode :class="menuIconClass" />
          {{ t("toolbar.compressSql") }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-sidebar')">
          <PanelLeft :class="menuIconClass" />
          {{ props.showSidebar ? t("menus.hideSidebar") : t("menus.showSidebar") }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.search") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-56">
        <DropdownMenuItem :class="menuItemClass" @select="emit('search-files')">
          <FolderSearch :class="menuIconClass" />
          {{ t("menus.searchFiles") }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('search-metadata')">
          <TableProperties :class="menuIconClass" />
          {{ t("menus.searchMetadata") }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('search-objects')">
          <FileCode :class="menuIconClass" />
          {{ t("menus.searchObjects") }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.tools") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-60">
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('open-transfer')">
          <ArrowLeftRight :class="menuIconClass" />
          {{ t("transfer.dataTransfer") }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasSqlFileConnections" :class="menuItemClass" @select="emit('open-sql-file')">
          <FileCode :class="menuIconClass" />
          {{ t("sqlFile.title") }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('open-schema-diff')">
          <GitCompareArrows :class="menuIconClass" />
          {{ t("diff.title") }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('open-data-compare')">
          <TableProperties :class="menuIconClass" />
          {{ t("dataCompare.title") }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-sql-library')">
          <BookMarked :class="menuIconClass" />
          {{ t("sqlLibrary.title") }}
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-sql-file-panel')">
          <FileCode :class="menuIconClass" />
          {{ t("sqlFileTree.title") }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.settings") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-56">
        <DropdownMenuItem :class="menuItemClass" @select="emit('open-settings')">
          <Settings :class="menuIconClass" />
          {{ t("settings.title") }}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger :class="menuItemClass">
            <span class="inline-flex items-center gap-2">
              <SunMoon class="h-3.5 w-3.5 text-muted-foreground" />
              {{ t("menus.theme") }}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent class="w-44">
              <DropdownMenuItem :class="menuItemClass" @select="emit('set-theme-mode', 'light')">
                <span class="w-3.5 text-center text-muted-foreground">{{ themeMode === "light" ? "✓" : "" }}</span>
                {{ t("toolbar.themeLight") }}
              </DropdownMenuItem>
              <DropdownMenuItem :class="menuItemClass" @select="emit('set-theme-mode', 'dark')">
                <span class="w-3.5 text-center text-muted-foreground">{{ themeMode === "dark" ? "✓" : "" }}</span>
                {{ t("toolbar.themeDark") }}
              </DropdownMenuItem>
              <DropdownMenuItem :class="menuItemClass" @select="emit('set-theme-mode', 'system')">
                <span class="w-3.5 text-center text-muted-foreground">{{ themeMode === "system" ? "✓" : "" }}</span>
                {{ t("toolbar.themeSystem") }}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.help") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-52">
        <DropdownMenuItem :class="menuItemClass" @select="emit('open-about')">
          <Info :class="menuIconClass" />
          {{ t("about.title") }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </nav>
</template>
