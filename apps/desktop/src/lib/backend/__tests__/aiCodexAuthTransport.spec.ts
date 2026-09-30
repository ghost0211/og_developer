import { afterEach, describe, expect, it, vi } from "vitest";
import { aiCodexAuthBegin, aiCodexAuthPoll, aiCodexAuthCancel, aiCodexAuthStatus, aiCodexAuthDisconnect } from "@/lib/backend/http";
import type { AiConfig } from "@/types/ai";

afterEach(() => vi.unstubAllGlobals());
describe("Codex authorization web transport", () => {
  it("forwards the device flow and opaque IDs to session-protected routes", async () => {
    const config: AiConfig = { provider: "openai-codex", apiKey: "", authMethod: "bearer", endpoint: "https://chatgpt.com/backend-api/codex/responses", apiStyle: "responses", model: "gpt-5.4" };
    const session = { sessionId: "session", userCode: "CODE", verificationUrl: "https://auth.openai.com/codex/device", intervalSeconds: 5, expiresAt: "2026-09-30T10:00:00Z" };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "authorized", oauthAccountId: "account-ref" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ canceled: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ disconnected: true })));
    vi.stubGlobal("fetch", fetch);
    expect(await aiCodexAuthBegin(config)).toEqual(session);
    expect(await aiCodexAuthPoll("session")).toEqual({ status: "authorized", oauthAccountId: "account-ref" });
    expect(await aiCodexAuthCancel("session")).toBe(true);
    expect(await aiCodexAuthStatus("account-ref")).toEqual({ authenticated: true });
    expect(await aiCodexAuthDisconnect("account-ref")).toBe(true);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/ai/codex-auth/begin", "/api/ai/codex-auth/poll", "/api/ai/codex-auth/cancel", "/api/ai/codex-auth/status", "/api/ai/codex-auth/disconnect"]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ config });
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ oauthAccountId: "account-ref" });
    for (const [, request] of fetch.mock.calls) {
      expect(request.method).toBe("POST");
      expect(request.credentials ?? "same-origin").toBe("same-origin");
      expect(request.body).not.toMatch(/accessToken|refreshToken/);
    }
  });
});
