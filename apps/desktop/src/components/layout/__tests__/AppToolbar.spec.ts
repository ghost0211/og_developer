import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toolbarSource = readFileSync(new URL("../AppToolbar.vue", import.meta.url), "utf8");

describe("AppToolbar actions", () => {
  it("keeps transfer and utility actions in the application menus instead of the left toolbar", () => {
    expect(toolbarSource).not.toContain("transfer.dataTransfer");
    expect(toolbarSource).not.toContain("common.more");
    expect(toolbarSource).not.toContain("<LightDropdown");
  });

  it("keeps only history, AI, and theme among the persistent right-side panel icons", () => {
    expect(toolbarSource).not.toContain("<BookMarked");
    expect(toolbarSource).not.toContain("<FolderTree");
    expect(toolbarSource).not.toContain("<Settings");
    expect(toolbarSource).not.toContain("agentDriverUpdateCount");
    expect(toolbarSource).not.toContain('<Tooltip v-if="toolbarItems.sqlLibrary">');
    expect(toolbarSource).not.toContain('<Tooltip v-if="toolbarItems.sqlFileTree">');
    expect(toolbarSource).toContain('<Tooltip v-if="toolbarItems.history">');
    expect(toolbarSource).toContain('<Tooltip v-if="toolbarItems.ai">');
    expect(toolbarSource).toContain('<Tooltip v-if="toolbarItems.theme">');
  });
});
