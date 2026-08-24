import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toolbarSource = readFileSync(new URL("../AppToolbar.vue", import.meta.url), "utf8");

describe("AppToolbar actions", () => {
  it("keeps transfer and utility actions in the application menus instead of the left toolbar", () => {
    expect(toolbarSource).not.toContain("transfer.dataTransfer");
    expect(toolbarSource).not.toContain("common.more");
    expect(toolbarSource).not.toContain("<LightDropdown");
  });

  it("keeps the right-side toolbar clean with export progress and window controls", () => {
    expect(toolbarSource).not.toContain("<BookMarked");
    expect(toolbarSource).not.toContain("<FolderTree");
    expect(toolbarSource).not.toContain("<Settings");
    expect(toolbarSource).not.toContain("agentDriverUpdateCount");
    expect(toolbarSource).toContain("<ExportProgressPopover");
    expect(toolbarSource).toContain("<WindowControls");
    expect(toolbarSource).not.toContain("showAiPanel:");
    expect(toolbarSource).not.toContain("showHistory:");
    expect(toolbarSource).not.toContain("isDark:");
  });
});
