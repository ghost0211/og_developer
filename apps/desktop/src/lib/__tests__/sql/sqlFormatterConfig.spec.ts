import { describe, expect, it } from "vitest";
import { DEFAULT_SQL_FORMATTER_SETTINGS, normalizeSqlFormatterSettings, parseSqlFormatterConfig, serializeSqlFormatterConfig, sqlFormatterOptions } from "@/lib/sql/sqlFormatterConfig";

describe("sqlFormatterConfig shortcut storage", () => {
  it("does not serialize JSON editor shortcut settings", () => {
    const config = JSON.parse(serializeSqlFormatterConfig(DEFAULT_SQL_FORMATTER_SETTINGS));

    expect(config.editor).toBeUndefined();
  });

  it("ignores legacy JSON editor shortcut settings on import", () => {
    const result = parseSqlFormatterConfig(
      JSON.stringify({
        version: 1,
        formatter: "sql-formatter",
        options: {},
        editor: {
          scope: "legacyJsonEditorScope",
          shortcuts: [{ id: "unknownLegacyShortcut", enabled: "yes" }],
        },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("keeps clauseInline/dedentJoin off by default and out of the sql-formatter library options", () => {
    expect(DEFAULT_SQL_FORMATTER_SETTINGS.clauseInline).toBe(false);
    expect(DEFAULT_SQL_FORMATTER_SETTINGS.dedentJoin).toBe(false);
    expect(normalizeSqlFormatterSettings({}).clauseInline).toBe(false);
    expect(normalizeSqlFormatterSettings({}).dedentJoin).toBe(false);
    expect(normalizeSqlFormatterSettings({ clauseInline: true, dedentJoin: true })).toMatchObject({ clauseInline: true, dedentJoin: true });
    const options = sqlFormatterOptions({ clauseInline: true, dedentJoin: true });
    expect(options).not.toHaveProperty("clauseInline");
    expect(options).not.toHaveProperty("dedentJoin");
    expect(options).not.toHaveProperty("keywordAlignment");
  });

  it("round-trips clauseInline/dedentJoin through config export/import and rejects invalid values", () => {
    const serialized = serializeSqlFormatterConfig({ clauseInline: true, dedentJoin: true });
    const parsed = parseSqlFormatterConfig(serialized);
    expect(parsed).toEqual({ ok: true, settings: { ...DEFAULT_SQL_FORMATTER_SETTINGS, clauseInline: true, dedentJoin: true, keywordAlignment: "left" } });

    const invalid = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { dedentJoin: "yes" } }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).toBe("Invalid formatter option value: dedentJoin.");
  });

  it("keeps standard defaults and honors explicit alignment for the legacy JOIN/inline combination", () => {
    expect(DEFAULT_SQL_FORMATTER_SETTINGS.keywordAlignment).toBe("none");
    expect(normalizeSqlFormatterSettings({}).keywordAlignment).toBe("none");
    expect(normalizeSqlFormatterSettings({ clauseInline: true }).keywordAlignment).toBe("none");
    expect(normalizeSqlFormatterSettings({ dedentJoin: true }).keywordAlignment).toBe("none");
    expect(normalizeSqlFormatterSettings({ clauseInline: true, dedentJoin: true }).keywordAlignment).toBe("left");
    expect(normalizeSqlFormatterSettings({ options: { clauseInline: true, dedentJoin: true } }).keywordAlignment).toBe("left");
    expect(normalizeSqlFormatterSettings({ keywordAlignment: "none", clauseInline: true, dedentJoin: true }).keywordAlignment).toBe("none");
    expect(normalizeSqlFormatterSettings({ keywordAlignment: "right", clauseInline: true, dedentJoin: true }).keywordAlignment).toBe("right");
    expect(normalizeSqlFormatterSettings({ keywordAlignment: "invalid" }).keywordAlignment).toBe("none");
  });

  it.each(["none", "left", "right"] as const)("round-trips %s alignment with standard indentation and underlying newline choices", (keywordAlignment) => {
    const settings = normalizeSqlFormatterSettings({ keywordAlignment, indentStyle: "standard", logicalOperatorNewline: "after", clauseInline: true });
    expect(parseSqlFormatterConfig(serializeSqlFormatterConfig(settings))).toEqual({ ok: true, settings });
  });

  it.each(["center", true, 1, null])("rejects invalid keywordAlignment %s on import", (keywordAlignment) => {
    expect(parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { keywordAlignment } }))).toEqual({ ok: false, message: "Invalid formatter option value: keywordAlignment." });
  });

  it.each([
    ["tabularLeft", "left"],
    ["tabularRight", "right"],
  ] as const)("migrates legacy %s even with explicit default alignment from v0.2.49", (indentStyle, expected) => {
    for (const input of [{ indentStyle }, { ...DEFAULT_SQL_FORMATTER_SETTINGS, indentStyle }]) {
      const normalized = normalizeSqlFormatterSettings(input);
      expect(normalized).toMatchObject({ keywordAlignment: expected, indentStyle: "standard" });
      expect(normalizeSqlFormatterSettings(normalized)).toEqual(normalized);
      expect(parseSqlFormatterConfig(serializeSqlFormatterConfig(input))).toEqual({ ok: true, settings: normalized });
      expect(sqlFormatterOptions(input)).toMatchObject({ indentStyle: "standard", logicalOperatorNewline: "before" });
    }
  });

  it.each(["left", "right"] as const)("explicit %s alignment wins over the legacy tabular style", (keywordAlignment) => {
    expect(normalizeSqlFormatterSettings({ keywordAlignment, indentStyle: "tabularLeft" })).toMatchObject({ keywordAlignment, indentStyle: "standard" });
    expect(normalizeSqlFormatterSettings({ keywordAlignment, indentStyle: "tabularRight" })).toMatchObject({ keywordAlignment, indentStyle: "standard" });
  });

  it("switching back to standard cannot restore retired fixed-width tabular padding", () => {
    const migrated = normalizeSqlFormatterSettings({ ...DEFAULT_SQL_FORMATTER_SETTINGS, indentStyle: "tabularRight", logicalOperatorNewline: "after" });
    const standard = normalizeSqlFormatterSettings({ ...migrated, keywordAlignment: "none" });
    expect(standard).toMatchObject({ indentStyle: "standard", keywordAlignment: "none", logicalOperatorNewline: "after" });
    expect(sqlFormatterOptions(standard)).toMatchObject({ indentStyle: "standard", logicalOperatorNewline: "after" });
    expect(parseSqlFormatterConfig(serializeSqlFormatterConfig(standard))).toEqual({ ok: true, settings: standard });
  });

  it("active alignment canonicalizes the retired indent style but preserves other stored choices", () => {
    const stored = normalizeSqlFormatterSettings({ keywordAlignment: "right", indentStyle: "tabularLeft", logicalOperatorNewline: "after", clauseInline: false });
    expect(sqlFormatterOptions(stored)).toMatchObject({ indentStyle: "standard", logicalOperatorNewline: "before" });
    expect(stored).toMatchObject({ indentStyle: "standard", keywordAlignment: "right", logicalOperatorNewline: "after", clauseInline: false });
    expect(sqlFormatterOptions({ ...stored, keywordAlignment: "none" })).toMatchObject({ indentStyle: "standard", logicalOperatorNewline: "after" });
  });

  it("merges DBX custom parameter types with user paramTypes", () => {
    const options = sqlFormatterOptions({
      paramTypes: {
        positional: false,
        named: ["@"],
        custom: [{ regex: String.raw`\{\{[^}]+\}\}` }],
      },
    });

    expect(options.paramTypes).toEqual({
      positional: false,
      named: ["@"],
      custom: [{ regex: String.raw`\{\{[^}]+\}\}` }, { regex: String.raw`\$\{[^}]+\}` }, { regex: String.raw`#\{[^}]+\}` }],
    });
  });
});
