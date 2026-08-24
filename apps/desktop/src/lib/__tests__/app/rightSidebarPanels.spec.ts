import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const toolbarSource = readFileSync(new URL("../../../components/layout/AppToolbar.vue", import.meta.url), "utf8");
const activityBarSource = readFileSync(new URL("../../../components/layout/AppActivityBar.vue", import.meta.url), "utf8");

function functionSource(name: string, nextName: string): string {
  const start = appSource.indexOf(`function ${name}`);
  const end = appSource.indexOf(`function ${nextName}`, start + 1);
  return appSource.slice(start, end);
}

describe("right sidebar panel entry points", () => {
  it("routes toolbar and close actions through the centralized controller", () => {
    expect(appSource).toContain("@toggle-ai=\"toggleToolPanel('ai')\"");
    expect(appSource).toContain("@toggle-history=\"toggleToolPanel('history')\"");
    expect(appSource).toContain("@toggle-sql-library=\"toggleToolPanel('sqlLibrary')\"");
    expect(appSource).toContain("@toggle-sql-file-panel=\"toggleToolPanel('sqlFile')\"");
    expect(appSource).toContain("@close=\"closeRightSidebarPanel('history')\"");
    expect(appSource).toContain("@close=\"closeRightSidebarPanel('sqlLibrary')\"");
    expect(appSource).toContain("@close=\"closeRightSidebarPanel('sqlFile')\"");
  });

  it("routes welcome, history analysis, selection, and error-fix opens through the same controller", () => {
    expect(appSource).toContain("@show-history=\"openRightSidebarPanel('history')\"");
    expect(functionSource("fixWithAi", "sendSelectionToAi")).toContain('openRightSidebarPanel("ai")');
    expect(functionSource("sendSelectionToAi", "openAiPanel")).toContain('openRightSidebarPanel("ai")');
    expect(functionSource("openAiPanel", "analyzeHistoryWithAi")).toContain('openRightSidebarPanel("ai")');
  });

  it("persists every open tool entry and restores the active tool panel", () => {
    expect(appSource).toContain('ai: "dbx-ai-panel-open"');
    expect(appSource).toContain('history: "dbx-history-panel-open"');
    expect(appSource).toContain('sqlLibrary: "dbx-sql-library-open"');
    expect(appSource).toContain('sqlFile: "dbx-sql-file-panel-open"');
    expect(appSource).toContain('safeLocalStorageGet("dbx-active-tool-panel")');
    expect(appSource).toContain('safeLocalStorageSet("dbx-active-tool-panel"');
  });

  it("routes history and AI panel actions through the menu and activity bar without duplicating toolbar buttons", () => {
    expect(appSource).toContain("@toggle-ai=\"toggleToolPanel('ai')\"");
    expect(appSource).toContain("@toggle-history=\"toggleToolPanel('history')\"");
    expect(toolbarSource).not.toContain('<Tooltip v-if="toolbarItems.sqlLibrary">');
    expect(toolbarSource).not.toContain('<Tooltip v-if="toolbarItems.sqlFileTree">');
    expect(activityBarSource).toContain("handlePanelClick('history')");
    expect(activityBarSource).toContain("handlePanelClick('ai')");
    expect(appSource).not.toMatch(/watch\([\s\S]{0,180}toolbarItems\.(ai|history|sqlLibrary|sqlFileTree)[\s\S]{0,180}closeRightSidebarPanel/);
  });
});
