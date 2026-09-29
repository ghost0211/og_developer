import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const processList = readFileSync(new URL("../../admin/ProcessListPanel.vue", import.meta.url), "utf8");
const topSql = readFileSync(new URL("../../admin/TopSqlPanel.vue", import.meta.url), "utf8");
const routineHealth = readFileSync(new URL("../../maintenance/RoutineHealthPanel.vue", import.meta.url), "utf8");
const commandWindow = readFileSync(new URL("../../command/CommandWindow.vue", import.meta.url), "utf8");
const tableImport = readFileSync(new URL("../../import/TableImportDialog.vue", import.meta.url), "utf8");

describe("Tools menu target selection", () => {
  it("opens tools directly from the menu without a pre-selection dialog", () => {
    expect(app).toContain('@open-sessions="openProcessListFromMenu"');
    expect(app).toContain('@open-invalid-objects="openRoutineHealthFromMenu"');
    expect(app).toContain('@open-top-sql="openTopSqlFromMenu"');
    expect(app).toContain('@open-command-window="openCommandWindowFromMenu"');
    expect(app).toContain('@open-table-import="void openTableImportFromMenu()"');
    expect(app).not.toContain("ToolTargetPickerDialog");
    expect(app).not.toContain("openToolTargetPicker");
  });

  it("embeds a connection selector in the tool panel headers", () => {
    expect(processList).toContain('kind="processlist"');
    expect(topSql).toContain('kind="pg-stats"');
    expect(routineHealth).toContain('kind="pg-stats"');
    expect(tableImport).toContain('kind="table-import"');
    for (const source of [processList, topSql, routineHealth, tableImport]) {
      expect(source).toContain("ToolConnectionSelect");
    }
  });

  it("keeps the command window's existing inline connection and database selectors", () => {
    expect(commandWindow).toContain("retargetCommandTab");
    expect(commandWindow).toContain("onDatabaseSelected");
  });

  it("retargets the tab through queryStore when the inline selector changes", () => {
    expect(processList).toContain("queryStore.updateConnection(props.tabId, connectionId)");
    expect(topSql).toContain("queryStore.updateConnection(props.tabId, connectionId");
    expect(routineHealth).toContain("queryStore.updateConnection(props.tab.id, connectionId");
    expect(routineHealth).toContain("queryStore.updateDatabase(props.tab.id, database)");
  });
});
