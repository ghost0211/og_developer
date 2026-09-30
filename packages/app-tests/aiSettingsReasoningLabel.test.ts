import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import en from "../../apps/desktop/src/i18n/locales/en";
import zhCN from "../../apps/desktop/src/i18n/locales/zh-CN";

test("AI settings default reasoning label uses a defined locale key", () => {
  const source = readFileSync(new URL("../../apps/desktop/src/components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");
  assert.ok(source.includes('t("ai.reasoningLevel")'));
  assert.ok(!source.includes('t("ai.defaultReasoningLevel")'));
  for (const locale of [en, zhCN]) {
    assert.ok(locale.ai.reasoningLevel.length > 0);
  }
});
