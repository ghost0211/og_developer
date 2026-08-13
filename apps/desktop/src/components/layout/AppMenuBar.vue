<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ArrowLeftRight, BookMarked, Bot, CloudDownload, DatabaseZap, FileCode, FileDown, FileInput, FileOutput, FilePlus2, FolderOpen, GitCompareArrows, History, Info, Package, PanelLeft, Search, Settings, SunMoon, TableProperties, X } from "@lucide/vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AppThemeMode } from "@/lib/app/appTheme";

const props = defineProps<{
  hasConnections: boolean;
  hasActiveTab: boolean;
  hasActiveQuery: boolean;
  canSaveSql: boolean;
  hasSqlFileConnections: boolean;
  showSidebar: boolean;
  themeMode: AppThemeMode;
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
  "toggle-ai": [];
  "toggle-history": [];
  "toggle-sql-library": [];
  "toggle-sql-file-panel": [];
  "open-settings": [];
  "set-theme-mode": [mode: AppThemeMode];
  "open-driver-store": [];
  "open-transfer": [];
  "open-sql-file": [];
  "open-schema-diff": [];
  "open-data-compare": [];
  "check-updates": [];
  "open-about": [];
}>();

const { t } = useI18n();
const menuTriggerClass = "inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium leading-none text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none";
const menuItemClass = "gap-2";
const menuIconClass = "h-3.5 w-3.5 text-muted-foreground";
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
      <DropdownMenuContent align="start" class="w-56">
        <DropdownMenuItem :class="menuItemClass" @select="emit('import-config')">
          <FileInput :class="menuIconClass" />
          {{ t("menus.importConnections") }}
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('export-config')">
          <FileOutput :class="menuIconClass" />
          {{ t("menus.exportConnections") }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :class="menuItemClass" @select="emit('open-driver-store')">
          <Package :class="menuIconClass" />
          {{ t("toolbar.driverManager") }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.edit") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-56">
        <DropdownMenuItem :class="menuItemClass" @select="emit('quick-open')">
          <Search :class="menuIconClass" />
          {{ t("menus.quickOpen") }}
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
        <button type="button" :class="menuTriggerClass" role="menuitem">{{ t("menus.session") }}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-56">
        <DropdownMenuItem :disabled="!hasConnections" :class="menuItemClass" @select="emit('new-query')">
          <FilePlus2 :class="menuIconClass" />
          {{ t("toolbar.newQuery") }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveTab" :class="menuItemClass" @select="emit('close-active-tab')">
          <X :class="menuIconClass" />
          {{ t("menus.closeTab") }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="!hasActiveTab" :class="menuItemClass" @select="emit('close-other-tabs')">
          <X :class="menuIconClass" />
          {{ t("menus.closeOtherTabs") }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-history')">
          <History :class="menuIconClass" />
          {{ t("history.title") }}
        </DropdownMenuItem>
        <DropdownMenuItem :class="menuItemClass" @select="emit('toggle-ai')">
          <Bot :class="menuIconClass" />
          {{ t("menus.aiAssistant") }}
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
        <DropdownMenuItem :class="menuItemClass" @select="emit('check-updates')">
          <CloudDownload :class="menuIconClass" />
          {{ t("updates.check") }}
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
        <DropdownMenuItem :class="menuItemClass" @select="emit('check-updates')">
          <CloudDownload :class="menuIconClass" />
          {{ t("updates.check") }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </nav>
</template>
