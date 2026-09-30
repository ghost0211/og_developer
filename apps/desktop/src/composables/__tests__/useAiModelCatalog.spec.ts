import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfigItem, AiEffortCapability } from "@/types/ai";

const apiMock = vi.hoisted(() => ({
  aiListModels: vi.fn(),
  aiResolveModelEffort: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

import { useAiModelCatalog } from "@/composables/useAiModelCatalog";

function config(id = "config-1"): AiConfigItem {
  return {
    id,
    name: "OpenAI",
    isDefault: true,
    provider: "openai",
    apiKey: "secret",
    authMethod: "bearer",
    endpoint: "https://api.example.com/v1",
    model: "",
    apiStyle: "responses",
  };
}

describe("useAiModelCatalog", () => {
  const catalog = useAiModelCatalog();

  beforeEach(() => {
    catalog.catalogs.clear();
    catalog.effortCatalogs.clear();
    apiMock.aiListModels.mockReset();
    apiMock.aiResolveModelEffort.mockReset();
  });

  it("deduplicates concurrent model requests and removes duplicate model IDs", async () => {
    apiMock.aiListModels.mockResolvedValue([
      { id: "gpt-5.6", displayName: "GPT 5.6" },
      { id: "gpt-5.6", displayName: "Duplicate" },
    ]);

    const [first, second] = await Promise.all([catalog.loadModels(config()), catalog.loadModels(config())]);

    expect(apiMock.aiListModels).toHaveBeenCalledTimes(1);
    expect(first).toEqual([{ id: "gpt-5.6", displayName: "GPT 5.6" }]);
    expect(second).toEqual(first);
    expect(catalog.catalogs.get("config-1")?.status).toBe("ready");
  });

  it("reuses effort capability returned with the model catalog", async () => {
    const capability: AiEffortCapability = {
      kind: "enum",
      options: [{ id: "low", label: "Low", selection: { kind: "enum", value: "low" } }],
      default: { kind: "enum", value: "low" },
      source: "providerApi",
    };
    apiMock.aiListModels.mockResolvedValue([{ id: "claude-model", effortCapability: capability }]);

    await catalog.loadModels(config());
    const resolved = await catalog.resolveEffort(config(), "claude-model");

    expect(resolved).toEqual(capability);
    expect(apiMock.aiResolveModelEffort).not.toHaveBeenCalled();
  });

  it("keeps routed model levels from config as custom suggestions when the provider omits capabilities", async () => {
    const configured: AiConfigItem = {
      ...config(),
      models: [{ name: "commandcode/deepseek/deepseek-v4.1-flash", supportedEffortLevels: ["high", "max", "high"] }],
    };
    apiMock.aiListModels.mockResolvedValue([{ id: "commandcode/deepseek/deepseek-v4.1-flash" }]);

    await catalog.loadModels(configured);

    const entry = catalog.effortCatalogs.get(catalog.effortKey(configured.id, "commandcode/deepseek/deepseek-v4.1-flash"));
    expect(entry?.capability).toMatchObject({
      kind: "enum",
      source: "custom",
      default: { kind: "providerDefault" },
      options: [
        { id: "high", selection: { kind: "enum", value: "high" } },
        { id: "max", selection: { kind: "enum", value: "max" } },
      ],
    });
  });

  it("uses provider-reported legacy effort levels and labels configured fallback as custom", async () => {
    apiMock.aiListModels.mockResolvedValue([{ id: "reported-model", supportedEffortLevels: ["low", "high"] }]);
    await catalog.loadModels(config());
    expect(catalog.effortCatalogs.get(catalog.effortKey("config-1", "reported-model"))?.capability).toMatchObject({
      kind: "enum",
      source: "providerApi",
      default: { kind: "providerDefault" },
    });

    apiMock.aiResolveModelEffort.mockResolvedValue({ kind: "unsupported" });
    const configured: AiConfigItem = { ...config(), models: [{ name: "manual-model", supportedEffortLevels: ["medium"] }] };
    await expect(catalog.resolveEffort(configured, "manual-model")).resolves.toMatchObject({
      kind: "enum",
      source: "custom",
      options: [{ id: "medium", selection: { kind: "enum", value: "medium" } }],
    });
    expect(apiMock.aiResolveModelEffort).not.toHaveBeenCalled();
  });

  it("invalidates configured effort suggestions when their saved levels change", async () => {
    const low: AiConfigItem = { ...config(), models: [{ name: "manual-model", supportedEffortLevels: ["low"] }] };
    const high: AiConfigItem = { ...config(), models: [{ name: "manual-model", supportedEffortLevels: ["high"] }] };

    await expect(catalog.resolveEffort(low, "manual-model")).resolves.toMatchObject({ options: [{ id: "low" }] });
    await expect(catalog.resolveEffort(high, "manual-model")).resolves.toMatchObject({ options: [{ id: "high" }] });
    expect(apiMock.aiResolveModelEffort).not.toHaveBeenCalled();
  });

  it("keeps a provider failure scoped and allows an explicit retry", async () => {
    apiMock.aiListModels.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce([{ id: "recovered" }]);

    await expect(catalog.loadModels(config())).rejects.toThrow("temporary failure");
    expect(catalog.catalogs.get("config-1")).toMatchObject({ status: "error", error: "temporary failure" });

    await expect(catalog.loadModels(config(), true)).resolves.toEqual([{ id: "recovered" }]);
    expect(apiMock.aiListModels).toHaveBeenCalledTimes(2);
  });

  it("invalidates model and effort caches when provider runtime configuration changes", async () => {
    const initial = config();
    const updated = { ...initial, endpoint: "https://api.changed.example.com/v1" };
    apiMock.aiListModels.mockResolvedValueOnce([{ id: "old-model" }]).mockResolvedValueOnce([{ id: "new-model" }]);
    apiMock.aiResolveModelEffort.mockResolvedValueOnce({ kind: "unsupported" }).mockResolvedValueOnce({
      kind: "enum",
      options: [{ id: "high", label: "High", selection: { kind: "enum", value: "high" } }],
      default: { kind: "enum", value: "high" },
      source: "providerApi",
    });

    await expect(catalog.loadModels(initial)).resolves.toEqual([{ id: "old-model" }]);
    await expect(catalog.resolveEffort(initial, "manual-model")).resolves.toEqual({ kind: "unsupported" });
    await expect(catalog.loadModels(updated)).resolves.toEqual([{ id: "new-model" }]);
    await expect(catalog.resolveEffort(updated, "manual-model")).resolves.toMatchObject({ kind: "enum" });

    expect(apiMock.aiListModels).toHaveBeenCalledTimes(2);
    expect(apiMock.aiResolveModelEffort).toHaveBeenCalledTimes(2);
  });

  it("invalidates the model catalog when a Codex subscription account changes", async () => {
    const initial: AiConfigItem = {
      ...config(),
      provider: "openai-codex",
      apiKey: "",
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      oauthAccountId: "account-one",
    };
    const updated = { ...initial, oauthAccountId: "account-two" };
    apiMock.aiListModels.mockResolvedValueOnce([{ id: "first-account-model" }]).mockResolvedValueOnce([{ id: "second-account-model" }]);

    await expect(catalog.loadModels(initial)).resolves.toEqual([{ id: "first-account-model" }]);
    await expect(catalog.loadModels(updated)).resolves.toEqual([{ id: "second-account-model" }]);

    expect(apiMock.aiListModels).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale request overwrite a newer provider catalog", async () => {
    let resolveInitial: ((models: { id: string }[]) => void) | undefined;
    apiMock.aiListModels
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
      )
      .mockResolvedValueOnce([{ id: "new-model" }]);

    const initialRequest = catalog.loadModels(config());
    const updatedRequest = catalog.loadModels({ ...config(), endpoint: "https://api.changed.example.com/v1" });
    await expect(updatedRequest).resolves.toEqual([{ id: "new-model" }]);
    resolveInitial?.([{ id: "old-model" }]);
    await expect(initialRequest).resolves.toEqual([{ id: "old-model" }]);

    expect(catalog.catalogs.get("config-1")?.models).toEqual([{ id: "new-model" }]);
  });
});
