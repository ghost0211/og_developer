import { readFileSync } from "node:fs";
import { describe, expect, it as test } from "vitest";
import en from "@/i18n/locales/en";
import zhCN from "@/i18n/locales/zh-CN";

const contentAreaSource = readFileSync(new URL("../../components/layout/ContentArea.vue", import.meta.url), "utf8");

function cachedResultMessages(messages: Record<string, unknown>): Record<string, unknown> {
  return messages.grid as Record<string, unknown>;
}

describe("cached result messages", () => {
  test.each([
    ["English", en],
    ["Simplified Chinese", zhCN],
  ])("provides the missing-result actions in %s", (_locale, messages) => {
    const grid = cachedResultMessages(messages);

    expect(grid.cachedResultUnavailable).toEqual(expect.any(String));
    expect(grid.reexecuteQuery).toEqual(expect.any(String));
  });

  test("uses the grid namespace from the cached-result fallback UI", () => {
    expect(contentAreaSource).toContain('t("grid.cachedResultUnavailable")');
    expect(contentAreaSource).toContain('t("grid.reexecuteQuery")');
    expect(contentAreaSource).not.toContain('t("editor.cachedResultUnavailable")');
    expect(contentAreaSource).not.toContain('t("editor.reexecuteQuery")');
  });
});
