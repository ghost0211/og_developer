import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editorToolbarSource = readFileSync(new URL("../../../components/layout/EditorToolbar.vue", import.meta.url), "utf8");
const pickerSource = readFileSync(new URL("../../../components/layout/EditorContextPicker.vue", import.meta.url), "utf8");
const zhLocale = readFileSync(new URL("../../../i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enLocale = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");

describe("EditorContextPicker", () => {
  it("replaces the three separate toolbar dropdowns with one context picker", () => {
    expect(editorToolbarSource).toContain("<EditorContextPicker");
    // The connection, database and schema selects collapsed into the picker; the
    // toolbar itself must not keep per-purpose SearchableSelect dropdowns.
    expect(editorToolbarSource).not.toContain("<SearchableSelect");
    expect(editorToolbarSource.match(/editor\.selectDatabase/g) ?? []).toHaveLength(0);
    expect(editorToolbarSource.match(/editor\.selectSchema/g) ?? []).toHaveLength(0);
  });

  it("re-emits every context change the toolbar previously exposed", () => {
    for (const event of ["changeConnection", "changeDatabase", "changeSchema", "setDefaultDatabase", "clearDefaultDatabase"]) {
      expect(editorToolbarSource).toContain(`emit('${event}'`);
      expect(pickerSource).toContain(`emit("${event}"`);
    }
  });

  it("keeps the default-database and clear-database actions inside the picker footer", () => {
    expect(pickerSource).toContain('t("editor.setDefaultDatabase")');
    expect(pickerSource).toContain('t("editor.defaultDatabase")');
    expect(pickerSource).toContain('t("editor.clearDatabase")');
  });

  it("keeps the database-required shake prompt on the merged trigger", () => {
    expect(pickerSource).toContain("databaseRequiredSignal");
    expect(pickerSource).toContain("context-picker-required-shake");
    expect(editorToolbarSource).not.toContain("database-required-prompt");
  });

  it("declares the new picker strings in both locales", () => {
    for (const key of ["searchContext", "contextConnections", "contextDatabases", "contextSchemas"]) {
      expect(zhLocale).toContain(`${key}:`);
      expect(enLocale).toContain(`${key}:`);
    }
  });
});
