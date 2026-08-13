import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const menuSource = readFileSync(new URL("../AppMenuBar.vue", import.meta.url), "utf8");

describe("AppMenuBar", () => {
  it("exposes the requested top-level application menus", () => {
    for (const key of ["file", "project", "edit", "search", "tools", "settings", "help"]) {
      expect(menuSource).toContain(`t("menus.${key}")`);
    }
  });

  it("exposes editor and search actions", () => {
    for (const event of ["undo", "redo", "cut", "copy", "paste", "find", "replace", "format-sql", "compress-sql", "search-files", "search-metadata", "search-objects", "create-project", "open-project", "select-project"]) {
      expect(menuSource).toContain(`@select="emit('${event}'`);
    }
  });

  it("has no update-check or driver-store entries", () => {
    expect(menuSource).not.toContain("check-updates");
    expect(menuSource).not.toContain("open-driver-store");
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
