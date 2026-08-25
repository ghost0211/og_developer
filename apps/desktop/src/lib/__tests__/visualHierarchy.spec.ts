import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const globalsCss = readFileSync(new URL("../../styles/globals.css", import.meta.url), "utf8");
const activityBarSource = readFileSync(new URL("../../components/layout/AppActivityBar.vue", import.meta.url), "utf8");

describe("visual hierarchy surfaces", () => {
  it("keeps the toolbar, tab bar, and sidebar translucent with soft separators", () => {
    const chromeStart = globalsCss.indexOf(".app-toolbar,");
    const chromeEnd = globalsCss.indexOf("/* Frosted glass menus */", chromeStart);
    const chrome = globalsCss.slice(chromeStart, chromeEnd);

    expect(chrome).toContain("backdrop-filter: blur(12px) saturate(1.15)");
    expect(chrome).toContain("color-mix(in oklab, var(--dbx-chrome) 82%, transparent)");
    expect(chrome).toContain("inset -1px 0 0 color-mix(in oklab, var(--sidebar-border) 78%, transparent)");
    expect(activityBarSource).toContain("box-shadow: inset -1px 0 0 var(--border);");
  });

  it("uses three-layer elevation shadows for menus and dialogs", () => {
    const menuStart = globalsCss.indexOf('[data-slot="context-menu-content"]');
    const menuEnd = globalsCss.indexOf("/* A few compound pickers", menuStart);
    const menu = globalsCss.slice(menuStart, menuEnd);
    const dialogStart = globalsCss.indexOf('[data-slot="dialog-content"]', menuStart);
    const dialogEnd = globalsCss.indexOf("/* A few compound pickers", dialogStart);
    const dialog = globalsCss.slice(dialogStart, dialogEnd);

    for (const surface of [menu, dialog]) {
      expect(surface).toContain("0 1px 2px");
      expect(surface).toContain("0 8px 18px");
      expect(surface).toContain("0 24px");
      expect(surface).toContain("color-mix(in oklab, var(--border)");
    }
  });
});
