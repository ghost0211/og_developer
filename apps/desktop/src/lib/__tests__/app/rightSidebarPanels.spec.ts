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
    expect(appSource).toContain("@close=\"closeToolPanel('history')\"");
    expect(appSource).toContain("@close=\"closeToolPanel('sqlLibrary')\"");
    expect(appSource).toContain("@close=\"closeToolPanel('sqlFile')\"");
  });

  it("routes welcome, history analysis, selection, and error-fix opens through the same controller", () => {
    expect(appSource).toContain("@show-history=\"openToolPanel('history')\"");
    expect(functionSource("fixWithAi", "sendSelectionToAi")).toContain('openToolPanel("ai")');
    expect(functionSource("sendSelectionToAi", "openAiPanel")).toContain('openToolPanel("ai")');
    expect(functionSource("openAiPanel", "analyzeHistoryWithAi")).toContain('openToolPanel("ai")');
  });

  it("persists the single active right-side tool", () => {
    expect(appSource).toContain('ai: "ogdeveloper-ai-panel-open"');
    expect(appSource).toContain('history: "ogdeveloper-history-panel-open"');
    expect(appSource).toContain('sqlLibrary: "ogdeveloper-sql-library-open"');
    expect(appSource).toContain('sqlFile: "ogdeveloper-sql-file-panel-open"');
    expect(appSource).toContain('safeLocalStorageSet("ogdeveloper-active-tool-panel"');
    expect(appSource).not.toContain('safeLocalStorageSet("ogdeveloper-tool-panel-order"');
  });

  it("routes history and AI panel actions through the menu and activity bar without duplicating toolbar buttons", () => {
    expect(appSource).toContain("@toggle-ai=\"toggleToolPanel('ai')\"");
    expect(appSource).toContain("@toggle-history=\"toggleToolPanel('history')\"");
    expect(toolbarSource).not.toContain('<Tooltip v-if="toolbarItems.sqlLibrary">');
    expect(toolbarSource).not.toContain('<Tooltip v-if="toolbarItems.sqlFileTree">');
    expect(activityBarSource).toContain("handlePanelClick('history')");
    expect(activityBarSource).toContain("handlePanelClick('ai')");
    expect(appSource).not.toMatch(/watch\([\s\S]{0,180}toolbarItems\.(ai|history|sqlLibrary|sqlFileTree)[\s\S]{0,180}closeToolPanel/);
  });
});
