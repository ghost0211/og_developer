import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../../components/editor/SqlFormatterSettingsPanel.vue", import.meta.url), "utf8");

describe("SQL formatter alignment settings wiring", () => {
  it("replaces the JOIN-only switch with the whole-query alignment selector", () => {
    expect(source).not.toContain('id="sql-formatter-dedent-join"');
    expect(source).toContain(':model-value="settings.keywordAlignment" @update:model-value="onKeywordAlignment"');
    for (const value of ["none", "left", "right"]) expect(source).toContain(`value: "${value}", labelKey: "settings.sqlFormatterKeywordAlignment`);
    expect(source).toContain('updateOption("keywordAlignment", value)');
    expect(source).toContain('t("settings.sqlFormatterKeywordAlignmentHint")');
  });
  it("disables conflicting newline/inline controls without erasing their stored values", () => {
    for (const field of ["logicalOperatorNewline", "clauseInline"]) {
      expect(source).toContain(`:model-value="settings.${field}" :disabled="settings.keywordAlignment !== 'none'"`);
    }
    const handler = source.slice(source.indexOf("function onKeywordAlignment"), source.indexOf("function onLogicalOperatorNewline"));
    expect(handler).not.toContain('updateOption("indentStyle"');
    expect(handler).not.toContain('updateOption("logicalOperatorNewline"');
    expect(handler).not.toContain('updateOption("clauseInline"');
  });
  it("exposes only one alignment control in the former indent-style position", () => {
    expect(source).not.toContain('settings.indentStyle"');
    expect(source).not.toContain("indentStyleOptions");
    expect(source).not.toContain("function onIndentStyle");
    expect(source.match(/id="sql-formatter-keyword-alignment"/g)).toHaveLength(1);
    const template = source.slice(source.indexOf("<template>"));
    expect(template.indexOf('id="sql-formatter-keyword-alignment"')).toBeLessThan(template.indexOf('t("settings.sqlFormatterLogicalOperatorNewline")'));
  });
  it("includes the requested SELECT/JOIN/AND/OR sample in the live preview", () => {
    const sample = source.slice(source.indexOf("const DEFAULT_FORMATTER_SAMPLE"), source.indexOf("const formatterSample ="));
    for (const text of ["select t1.domain_code", "join ddd.pdm_typemapping", "where t1.delete_flag", "and (t1.suffix_code", "or t2.physical_type_code"]) expect(sample).toContain(text);
    expect(source).toContain('formatSqlText(formatterSample.value, "postgres", settings.value)');
  });
});
