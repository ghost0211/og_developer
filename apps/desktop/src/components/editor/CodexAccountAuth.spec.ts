// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, type App } from "vue";
import CodexAccountAuth from "./CodexAccountAuth.vue";
import type { AiConfig } from "@/types/ai";

const api = vi.hoisted(() => ({ begin: vi.fn(), poll: vi.fn(), cancel: vi.fn(), status: vi.fn(), disconnect: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ aiCodexAuthBegin: api.begin, aiCodexAuthPoll: api.poll, aiCodexAuthCancel: api.cancel, aiCodexAuthStatus: api.status, aiCodexAuthDisconnect: api.disconnect }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/button", () => ({ Button: { template: "<button><slot /></button>" } }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
const config: AiConfig = { provider: "openai-codex", apiKey: "", endpoint: "https://chatgpt.com/backend-api/codex/responses", model: "gpt-5.4", apiStyle: "responses", authMethod: "bearer" };
const login = { sessionId: "test-session", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device", intervalSeconds: 1, expiresAt: Date.now() + 10000 };
let app: App | undefined;
let host: HTMLDivElement;
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
}
function render(accountId?: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const update = vi.fn();
  const props = reactive({ config, accountId, "onUpdate:accountId": update });
  app = createApp({ render: () => h(CodexAccountAuth, props) });
  app.mount(host);
  return { update, props };
}
function button(key: string) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent === key)!;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  api.begin.mockResolvedValue(login);
  api.poll.mockResolvedValue({ status: "pending" });
  api.status.mockResolvedValue({ authenticated: true, accountLabel: "account" });
  api.cancel.mockResolvedValue(undefined);
  api.disconnect.mockResolvedValue(undefined);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("Codex account authorization", () => {
  it("polls and emits only the opaque account reference on authorization", async () => {
    const { update } = render();
    button("ai.codexSignIn").click();
    await flush();
    expect(host.textContent).toContain("ABCD-EFGH");
    expect(host.querySelector("a")?.getAttribute("href")).toBe(login.verificationUrl);
    api.poll.mockResolvedValueOnce({ status: "authorized", oauthAccountId: "opaque-account" });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(update).toHaveBeenCalledWith("opaque-account");
    expect(api.begin).toHaveBeenCalledWith(config);
    expect(host.textContent).not.toContain("ABCD-EFGH");
  });
  it("cancels pending login on unmount and does not emit a stale response", async () => {
    let resolve: (value: unknown) => void = () => {};
    api.poll.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { update } = render();
    button("ai.codexSignIn").click();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    app?.unmount();
    app = undefined;
    resolve({ status: "authorized", oauthAccountId: "stale-account" });
    await flush();
    expect(api.cancel).toHaveBeenCalledWith("test-session");
    expect(update).not.toHaveBeenCalled();
  });
  it("cancels an old device flow when switching the edited account", async () => {
    const { props } = render();
    button("ai.codexSignIn").click();
    await flush();
    props.accountId = "other-account";
    await flush();
    expect(api.cancel).toHaveBeenCalledWith("test-session");
    expect(api.status).toHaveBeenCalledWith("other-account");
    expect(host.textContent).not.toContain("ABCD-EFGH");
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.poll).not.toHaveBeenCalled();
  });

  it("does not render a login link to an untrusted origin", async () => {
    api.begin.mockResolvedValue({ ...login, verificationUrl: "https://attacker.example/auth" });
    render();
    button("ai.codexSignIn").click();
    await flush();
    expect(host.querySelector("a")).toBeNull();
  });
  it("checks existing credentials and confirms disconnect", async () => {
    const { update } = render("opaque-account");
    await flush();
    expect(api.status).toHaveBeenCalledWith("opaque-account");
    expect(host.textContent).toContain("ai.codexConnected");
    button("ai.codexDisconnect").click();
    await flush();
    expect(api.disconnect).not.toHaveBeenCalled();
    button("common.confirm").click();
    await flush();
    expect(api.disconnect).toHaveBeenCalledWith("opaque-account");
    expect(update).toHaveBeenCalledWith(undefined);
  });
  it("allows retry after authorization expires", async () => {
    api.poll.mockResolvedValueOnce({ status: "expired" });
    render();
    button("ai.codexSignIn").click();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(host.textContent).toContain("ai.codexLoginExpired");
    expect(button("ai.codexSignIn").disabled).toBe(false);
  });
});
