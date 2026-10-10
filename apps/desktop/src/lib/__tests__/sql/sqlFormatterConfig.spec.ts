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

  it("keeps clauseInline off by default and out of the sql-formatter library options", () => {
    expect(DEFAULT_SQL_FORMATTER_SETTINGS.clauseInline).toBe(false);
    expect(normalizeSqlFormatterSettings({}).clauseInline).toBe(false);
    expect(normalizeSqlFormatterSettings({ clauseInline: true }).clauseInline).toBe(true);
    expect(sqlFormatterOptions({ clauseInline: true })).not.toHaveProperty("clauseInline");
  });

  it("round-trips clauseInline through config export/import and rejects invalid values", () => {
    const serialized = serializeSqlFormatterConfig({ clauseInline: true });
    const parsed = parseSqlFormatterConfig(serialized);
    expect(parsed).toEqual({ ok: true, settings: { ...DEFAULT_SQL_FORMATTER_SETTINGS, clauseInline: true } });

    const invalid = parseSqlFormatterConfig(JSON.stringify({ version: 1, formatter: "sql-formatter", options: { clauseInline: "yes" } }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).toBe("Invalid formatter option value: clauseInline.");
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
