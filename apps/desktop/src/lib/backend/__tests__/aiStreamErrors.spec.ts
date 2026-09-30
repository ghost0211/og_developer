import { afterEach, describe, expect, it, vi } from "vitest";
import { aiStream } from "@/lib/backend/http";
import type { AiCompletionRequest } from "@/lib/backend/tauri";
const request: AiCompletionRequest = {
  config: { provider: "openai-codex", apiKey: "", authMethod: "bearer", endpoint: "https://chatgpt.com/backend-api/codex/responses", apiStyle: "responses", model: "gpt-5.4", oauthAccountId: "opaque-account" },
  systemPrompt: "Explain the plan",
  messages: [],
};
afterEach(() => vi.unstubAllGlobals());
function stream(lines: unknown[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(lines.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""))));
}
describe("web AI stream errors", () => {
  it("does not swallow a sanitized failure after the final core chunk", async () => {
    stream([
      { session_id: "session", delta: "", done: true },
      { session_id: "session", delta: "", done: true, error: "Codex Responses request failed (HTTP 401)" },
    ]);
    await expect(aiStream("session", request, vi.fn())).rejects.toThrow("HTTP 401");
  });
  it("rejects an incomplete response instead of claiming success", async () => {
    stream([{ session_id: "session", delta: "partial", done: false }]);
    await expect(aiStream("session", request, vi.fn())).rejects.toThrow("stopped before completion");
  });
  it("keeps successful chunks and closes normally", async () => {
    const onChunk = vi.fn();
    stream([
      { session_id: "session", delta: "analysis", done: false },
      { session_id: "session", delta: "", done: true },
    ]);
    await expect(aiStream("session", request, onChunk)).resolves.toBeUndefined();
    expect(onChunk).toHaveBeenCalledTimes(2);
  });
  it("does not mistake a callback error for malformed JSON", async () => {
    stream([{ session_id: "session", delta: "analysis", done: true }]);
    await expect(
      aiStream("session", request, () => {
        throw new Error("render failure");
      }),
    ).rejects.toThrow("render failure");
  });
});
