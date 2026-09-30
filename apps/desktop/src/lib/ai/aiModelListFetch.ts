import type { AiModelInfo } from "@/lib/backend/tauri";

export interface AiModelFetchEligibilityInput {
  isCliProvider: boolean;
  isCodexSubscription: boolean;
  requiresApiKey: boolean;
  apiKey: string;
  endpoint: string;
  oauthAccountId?: string;
}

/**
 * Why the provider model list cannot be fetched yet, or `null` when fetching
 * is allowed. The settings dialog maps each blocker to a localized hint.
 */
export type AiModelFetchBlocker = "cli" | "oauth" | "apiKey" | "endpoint" | null;

export function aiModelFetchBlocker(input: AiModelFetchEligibilityInput): AiModelFetchBlocker {
  if (input.isCliProvider) return "cli";
  if (input.isCodexSubscription) {
    return input.oauthAccountId?.trim() ? null : "oauth";
  }
  if (input.requiresApiKey && !input.apiKey.trim()) return "apiKey";
  return input.endpoint.trim() ? null : "endpoint";
}

/** Deduplicate provider-returned models by non-empty id, keeping first-seen order. */
export function uniqueModelsById(models: readonly AiModelInfo[]): AiModelInfo[] {
  const seen = new Set<string>();
  const result: AiModelInfo[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ ...model, id });
  }
  return result;
}

/**
 * Pick the model to auto-fill when the user has not chosen one: prefer the
 * provider preset when the discovered catalog contains it, otherwise the
 * first catalog entry. Returns "" when the catalog is empty.
 */
export function autoDefaultModelId(models: readonly AiModelInfo[], presetModel: string): string {
  if (!models.length) return "";
  const preset = presetModel.trim();
  if (preset && models.some((model) => model.id === preset)) return preset;
  return models[0].id;
}
