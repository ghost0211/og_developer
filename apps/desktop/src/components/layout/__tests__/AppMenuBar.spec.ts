import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const menuSource = readFileSync(new URL("../AppMenuBar.vue", import.meta.url), "utf8");

describe("AppMenuBar", () => {
  it("exposes the requested top-level application menus", () => {
    for (const key of ["file", "project", "edit", "session", "tools", "settings", "help"]) {
      expect(menuSource).toContain(`t("menus.${key}")`);
    }
  });

  it("routes settings through the standalone settings action", () => {
    expect(menuSource).toContain("@select=\"emit('open-settings')\"");
    expect(menuSource).not.toContain("settings-page");
  });

  it("keeps the moved utilities in the Tools menu", () => {
    for (const event of ["open-transfer", "open-sql-file", "open-schema-diff", "open-data-compare", "toggle-sql-library", "toggle-sql-file-panel"]) {
      expect(menuSource).toContain(`@select="emit('${event}')"`);
    }
  });
});
