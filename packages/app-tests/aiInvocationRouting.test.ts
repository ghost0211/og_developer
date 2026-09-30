import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { resolveAiInvocationConfig } from "../../apps/desktop/src/lib/ai/aiInvocationRouting.ts";
import type { AiConfig, AiConfigItem } from "../../apps/desktop/src/types/ai.ts";

const defaultConfig: AiConfigItem = {
  id: "default-id",
  name: "Settings default",
  provider: "openai",
  apiKey: "default-key",
  authMethod: "api-key",
  endpoint: "https://default.example/v1",
  model: "default-model",
  apiStyle: "completions",
  isDefault: true,
};

const otherConfig: AiConfigItem = {
  ...defaultConfig,
  id: "other-id",
  name: "Other provider",
  apiKey: "other-key",
  endpoint: "https://other.example/v1",
  model: "other-default-model",
  isDefault: false,
};

const chatConfig: AiConfig = {
  ...otherConfig,
  model: "chat-selected-model",
  runtimeEffort: { kind: "text", value: "high" },
};

const appSource = readFileSync(new URL("../../apps/desktop/src/App.vue", import.meta.url), "utf8");
const assistantSource = readFileSync(new URL("../../apps/desktop/src/components/editor/AiAssistant.vue", import.meta.url), "utf8");

test("chat invocations continue to use the chat-selected config and model", () => {
  assert.equal(resolveAiInvocationConfig([defaultConfig, otherConfig], chatConfig, "chat"), chatConfig);
});

test("settings-default invocations use the marked config's own model without changing chat selection", () => {
  const result = resolveAiInvocationConfig([defaultConfig, otherConfig], chatConfig, "settings-default");

  assert.equal(result?.id, "default-id");
  assert.equal(result?.model, "default-model");
  assert.equal(result?.runtimeEffort, null);
  assert.equal(chatConfig.model, "chat-selected-model");
  assert.equal(defaultConfig.model, "default-model");
});

test("settings-default routing falls back to the first config only when no default is marked", () => {
  const result = resolveAiInvocationConfig([{ ...defaultConfig, isDefault: false }, otherConfig], chatConfig, "settings-default");
  assert.equal(result?.id, "default-id");
  assert.equal(result?.model, "default-model");
  assert.equal(resolveAiInvocationConfig([], chatConfig, "settings-default"), null);
});

test("App fix, history, and explain-plan entry points explicitly choose the settings default", () => {
  assert.match(appSource, /triggerAction\("fix", errorMessage, \{ modelSource: "settings-default" \}\)/);
  assert.match(appSource, /triggerAction\("explain", buildHistoryAiAnalysisPrompt\(entry\), \{ modelSource: "settings-default" \}\)/);
  assert.match(appSource, /triggerAction\("explain", prompt, \{ modelSource: "settings-default" \}\)/);
  assert.match(assistantSource, /function triggerAction\(action: AiAction, instruction\?: string, options: AiInvocationOptions = \{\}\)/);
  assert.match(assistantSource, /const invocationConfig = resolveAiInvocationConfig\(settings\.aiConfigs, activeFullConfig\.value, modelSource\)/);
  assert.match(assistantSource, /config: invocationConfig/);
});

test("effort popup displays capability provenance, including routed custom-source caution", () => {
  assert.match(assistantSource, /const activeEffortSourceLabel = computed\(/);
  assert.match(assistantSource, /v-if="activeEffortSourceLabel"/);
  assert.match(assistantSource, /ai\.effortSourceCustom/);
});
