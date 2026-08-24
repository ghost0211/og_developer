import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const activityBarSource = readFileSync(new URL("../AppActivityBar.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

describe("AppActivityBar", () => {
  it("represents the connections view plus at most one active right-side tool", () => {
    expect(activityBarSource).toContain("activePanels: ActivityPanelId[]");
    expect(activityBarSource).toContain("props.activePanels.includes(panelId)");
    expect(appSource).toContain("const activeActivityPanels = computed<ActivityPanelId[]>");
    expect(appSource).toContain(':active-panels="activeActivityPanels"');
    expect(appSource).toContain('if (activeToolPanel.value === "sqlFile") panels.push("files")');
  });

  it("keeps connections on the left and renders the active tool after the editor", () => {
    expect(appSource).toContain("const activeToolPanel = ref<ToolPanelId | null>");
    expect(appSource).toContain('v-show="sidebarOpen"');
    expect(appSource).not.toContain('v-show="sidebarOpen && activeToolPanel === null"');
    expect(appSource.indexOf("v-if=\"activeToolPanel === 'sqlFile'\"")).toBeGreaterThan(appSource.indexOf("<div :class=\"isClassicLayout ? 'flex-1 min-w-0 overflow-hidden'"));
    expect(appSource).toContain("panel-resize-handle--left");
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

  it("keeps preferences and theme actions functional", () => {
    expect(activityBarSource).toContain('"open-settings": []');
    expect(activityBarSource).toContain("emit('open-settings')");
    expect(appSource).toContain("@open-settings=\"openSettings('appearance')\"");
    expect(appSource).toContain('toast(`${t("toolbar.theme")}: ${modeLabel}`, 1600)');
  });
});
