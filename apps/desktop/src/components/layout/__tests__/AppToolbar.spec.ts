import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toolbarSource = readFileSync(new URL("../AppToolbar.vue", import.meta.url), "utf8");
const menuBarSource = readFileSync(new URL("../AppMenuBar.vue", import.meta.url), "utf8");

function declaredEmits(source: string): string[] {
  const block = /defineEmits<\{([\s\S]*?)\}>\(\)/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/"([\w-]+)":\s*\[/g)].map((match) => match[1]);
}

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

  // 回归：Top SQL 菜单项加了 AppMenuBar 的 emit，但 AppToolbar 未转发，点击无反应。
  // AppMenuBar 声明的每个事件都必须在 AppToolbar 声明并转发到 App.vue。
  it("declares and forwards every AppMenuBar event", () => {
    const menuEmits = declaredEmits(menuBarSource);
    expect(menuEmits.length).toBeGreaterThan(0);
    const toolbarEmits = new Set(declaredEmits(toolbarSource));
    for (const event of menuEmits) {
      expect(toolbarEmits.has(event), `AppToolbar 应在 defineEmits 中声明 "${event}"`).toBe(true);
      expect(toolbarSource, `AppToolbar 模板应转发 "${event}"（@${event}="emit(...)"）`).toContain(`@${event}=`);
    }
  });
});
