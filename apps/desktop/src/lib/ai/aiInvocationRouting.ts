import type { AiConfig, AiConfigItem } from "@/types/ai";

export type AiInvocationModelSource = "chat" | "settings-default";

export interface AiInvocationOptions {
  /** Defaults to the chat model for user-submitted chat messages. */
  modelSource?: AiInvocationModelSource;
}

/**
 * Resolve the config for one invocation without changing the persisted chat selection.
 * Settings-driven actions use the marked default config (or the settings store's first-config
 * fallback) and that config's own model, never the currently selected chat model.
 */
export function resolveAiInvocationConfig(configs: readonly AiConfigItem[], chatConfig: AiConfig | null, source: AiInvocationModelSource = "chat"): AiConfig | null {
  if (source === "chat") return chatConfig;

  const defaultConfig = configs.find((config) => config.isDefault) ?? configs[0];
  if (!defaultConfig) return null;
  return {
    ...defaultConfig,
    model: defaultConfig.model.trim(),
    // Per-chat effort overrides do not apply to settings-driven invocations.
    runtimeEffort: null,
  };
}
