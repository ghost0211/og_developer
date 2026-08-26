// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const state = vi.hoisted(() => ({
  api: {
    executeQuery: vi.fn(),
  },
  connectionStore: {
    connections: [
      { id: "og-1", name: "openGauss", db_type: "opengauss", username: "omm", database: "postgres" },
      { id: "gauss-1", name: "GaussDB", db_type: "gaussdb", username: "gauss", database: "app" },
      { id: "mysql-1", name: "MySQL", db_type: "mysql", username: "root", database: "test" },
    ],
    getConfig: vi.fn(),
    ensureConnected: vi.fn(),
  },
  queryStore: {
    retargetCommandTab: vi.fn(),
    updateDatabase: vi.fn(),
  },
  toast: vi.fn(),
  copyToClipboard: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      return `${key} ${Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(" ")}`;
    },
  }),
}));

vi.mock("@/lib/backend/api", () => state.api);
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => state.connectionStore }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => state.queryStore }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: state.copyToClipboard }));

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      name: "ButtonStub",
      inheritAttrs: false,
      setup(_, context) {
        return () => h("button", context.attrs, context.slots.default?.());
      },
    }),
  };
});

vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ name: "IconStub", setup: () => () => h("i") });
  return { Copy: Icon, Loader2: Icon, Play: Icon, Terminal: Icon, Trash2: Icon };
});

import CommandWindow from "@/components/command/CommandWindow.vue";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

function getConfig(id: string) {
  return state.connectionStore.connections.find((connection) => connection.id === id);
}

function executeButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes("commandWindow.execute"));
  if (!button) throw new Error("execute button not found");
  return button;
}

async function mountCommand() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(CommandWindow, {
    tabId: "command-tab",
    connectionId: "og-1",
    database: "postgres",
    schema: "public",
    databaseType: "opengauss",
  });
  app.mount(root);
  await flushUi();
  return root;
}

beforeEach(() => {
  state.api.executeQuery.mockReset();
  state.connectionStore.getConfig.mockReset().mockImplementation(getConfig);
  state.connectionStore.ensureConnected.mockReset().mockResolvedValue(undefined);
  state.queryStore.retargetCommandTab.mockReset();
  state.queryStore.updateDatabase.mockReset();
  state.toast.mockReset();
  state.copyToClipboard.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("CommandWindow", () => {
  it("initializes the bound connection without activating it and gates input while connecting", async () => {
    let resolveConnection!: () => void;
    state.connectionStore.ensureConnected.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnection = resolve;
        }),
    );

    const panel = await mountCommand();
    const textarea = panel.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("command input not found");

    expect(state.connectionStore.ensureConnected).toHaveBeenCalledWith("og-1", { activate: false });
    expect(textarea.disabled).toBe(true);
    expect(executeButton(panel).disabled).toBe(true);
    expect(panel.textContent).toContain("commandWindow.connecting");

    resolveConnection();
    await flushUi();

    expect(textarea.disabled).toBe(false);
    expect(panel.textContent).toContain("commandWindow.connectedTo");
  });

  it("executes SQL through the active connection and normalizes a trailing slash", async () => {
    state.api.executeQuery.mockResolvedValue({
      columns: ["id", "name"],
      rows: [
        [1, "Alice"],
        [2, null],
      ],
      affected_rows: null,
    });

    const panel = await mountCommand();
    const textarea = panel.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("command input not found");

    textarea.value = "SELECT 1;/";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    executeButton(panel).click();
    await flushUi();

    expect(state.api.executeQuery).toHaveBeenCalledWith("og-1", "postgres", "SELECT 1;", "public");
    expect(panel.textContent).toContain("Alice");
    expect(panel.textContent).toContain("commandWindow.rowCount");
  });

  it("submits single-line commands from the keyboard, recalls history, and switches databases", async () => {
    state.api.executeQuery.mockResolvedValue({ columns: [], rows: [], affected_rows: 1 });

    const panel = await mountCommand();
    const textarea = panel.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("command input not found");

    textarea.value = "SELECT 1";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushUi();

    expect(state.api.executeQuery).toHaveBeenCalledWith("og-1", "postgres", "SELECT 1", "public");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await flushUi();
    expect(textarea.value).toBe("SELECT 1");

    textarea.value = "\\c app";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushUi();

    expect(state.queryStore.updateDatabase).toHaveBeenCalledWith("command-tab", "app");
  });

  it("maps meta commands to safe metadata queries and renders command errors", async () => {
    state.api.executeQuery.mockResolvedValueOnce({ columns: ["Name"], rows: [["orders"]], affected_rows: null }).mockRejectedValueOnce(new Error("permission denied"));

    const panel = await mountCommand();
    const textarea = panel.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("command input not found");

    textarea.value = "\\dt";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    executeButton(panel).click();
    await flushUi();

    expect(state.api.executeQuery).toHaveBeenCalledWith("og-1", "postgres", expect.stringContaining("pg_catalog.pg_class"), "public");
    expect(panel.textContent).toContain("orders");

    textarea.value = "SELECT forbidden";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    executeButton(panel).click();
    await flushUi();

    expect(panel.textContent).toContain("permission denied");
  });
});
