import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const activityBarSource = readFileSync(new URL("../AppActivityBar.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const panelResizeSource = readFileSync(new URL("../../../composables/usePanelResize.ts", import.meta.url), "utf8");

describe("AppActivityBar", () => {
  it("represents every open panel instead of collapsing state to one active panel", () => {
    expect(activityBarSource).toContain("activePanels: ActivityPanelId[]");
    expect(activityBarSource).toContain("props.activePanels.includes(panelId)");
    expect(appSource).toContain("const activeActivityPanels = computed<ActivityPanelId[]>");
    expect(appSource).toContain(':active-panels="activeActivityPanels"');
    expect(appSource).not.toContain("activeActivityPanel === 'connections'");
  });

  it("localizes and labels all activity buttons", () => {
    expect(activityBarSource).toContain("useI18n");
    for (const key of ["connections", "projectFiles", "sqlLibrary", "history", "ai", "settings", "theme"]) {
      expect(activityBarSource).toContain(`t('activityBar.${key}')`);
    }
    expect(activityBarSource).not.toContain("数据库连接 (Connections)");
    expect(activityBarSource).toContain(":aria-label");
  });

  it("honors visibility settings for migrated toolbar actions", () => {
    expect(activityBarSource).toContain('v-if="showHistory"');
    expect(activityBarSource).toContain('v-if="showAi"');
    expect(activityBarSource).toContain('v-if="showTheme"');
    expect(appSource).toContain(':show-history="settingsStore.editorSettings.toolbarItems.history"');
    expect(appSource).toContain(':show-ai="settingsStore.editorSettings.toolbarItems.ai"');
    expect(appSource).toContain(':show-theme="settingsStore.editorSettings.toolbarItems.theme"');
  });

  it("renders activity panels next to the activity bar instead of on the far right", () => {
    const sidebarIndex = appSource.indexOf("<AppSidebar");
    const sqlFilePanelIndex = appSource.indexOf('<div v-if="showSqlFilePanel"');
    const mainTabsIndex = appSource.indexOf("<AppTabBar");
    expect(sidebarIndex).toBeGreaterThan(-1);
    expect(sqlFilePanelIndex).toBeGreaterThan(sidebarIndex);
    expect(sqlFilePanelIndex).toBeLessThan(mainTabsIndex);
    expect(appSource).toContain("panel-resize-handle--right");
    expect(panelResizeSource).toContain('startPanelResize(aiPanelWidth, "dbx-ai-panel-width", "right")');
  });

  it("keeps multiple tool entries open while showing one adjacent tool panel", () => {
    expect(appSource).toContain("const activeToolPanel = ref<ToolPanelId | null>");
    expect(appSource).toContain("function toggleToolPanel(panelId: ToolPanelId)");
    expect(appSource).toContain("v-show=\"activeToolPanel === 'sqlFile'\"");
    expect(appSource).toContain("v-show=\"activeToolPanel === 'sqlLibrary'\"");
    expect(appSource).toContain("v-show=\"activeToolPanel === 'history'\"");
    expect(appSource).toContain("v-show=\"activeToolPanel === 'ai'\"");
    expect(appSource).not.toContain("exclusiveOverride");
  });

  it("keeps preferences and theme actions functional", () => {
    expect(activityBarSource).toContain('"open-settings": []');
    expect(activityBarSource).toContain("emit('open-settings')");
    expect(appSource).toContain("@open-settings=\"openSettings('appearance')\"");
    expect(appSource).toContain('toast(`${t("toolbar.theme")}: ${modeLabel}`, 1600)');
  });
});
