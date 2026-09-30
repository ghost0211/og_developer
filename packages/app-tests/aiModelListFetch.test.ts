import { strict as assert } from "node:assert";
import { test } from "vitest";
import { aiModelFetchBlocker, autoDefaultModelId, uniqueModelsById } from "../../apps/desktop/src/lib/ai/aiModelListFetch.ts";
import type { AiModelFetchEligibilityInput } from "../../apps/desktop/src/lib/ai/aiModelListFetch.ts";

function eligibility(overrides: Partial<AiModelFetchEligibilityInput> = {}): AiModelFetchEligibilityInput {
  return {
    isCliProvider: false,
    isCodexSubscription: false,
    requiresApiKey: true,
    apiKey: "",
    endpoint: "https://api.example.com/v1",
    ...overrides,
  };
}

test("cli providers never fetch model lists", () => {
  assert.equal(aiModelFetchBlocker(eligibility({ isCliProvider: true, apiKey: "sk" })), "cli");
});

test("api-key providers require a key and endpoint before fetching", () => {
  assert.equal(aiModelFetchBlocker(eligibility()), "apiKey");
  assert.equal(aiModelFetchBlocker(eligibility({ apiKey: "sk-test" })), null);
  assert.equal(aiModelFetchBlocker(eligibility({ apiKey: "sk-test", endpoint: "  " })), "endpoint");
});

test("keyless providers (local ollama-style) only need an endpoint", () => {
  assert.equal(aiModelFetchBlocker(eligibility({ requiresApiKey: false })), null);
});

test("codex subscription requires a completed login instead of an API key", () => {
  assert.equal(aiModelFetchBlocker(eligibility({ isCodexSubscription: true, requiresApiKey: false, endpoint: "" })), "oauth");
  assert.equal(aiModelFetchBlocker(eligibility({ isCodexSubscription: true, requiresApiKey: false, endpoint: "", oauthAccountId: "account-id" })), null);
});

test("uniqueModelsById trims, drops empties and keeps first-seen order", () => {
  const models = uniqueModelsById([{ id: " a " }, { id: "" }, { id: "b" }, { id: "a", displayName: "dup" }]);
  assert.deepEqual(
    models.map((model) => model.id),
    ["a", "b"],
  );
  assert.equal(models[0].displayName, undefined);
});

test("autoDefaultModelId prefers the preset when discovered, otherwise the first model", () => {
  const models = [{ id: "model-a" }, { id: "model-b" }];
  assert.equal(autoDefaultModelId(models, "model-b"), "model-b");
  assert.equal(autoDefaultModelId(models, "missing-preset"), "model-a");
  assert.equal(autoDefaultModelId(models, "  "), "model-a");
  assert.equal(autoDefaultModelId([], "model-a"), "");
});
