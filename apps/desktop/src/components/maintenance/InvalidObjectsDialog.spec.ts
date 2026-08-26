// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";

const state = vi.hoisted(() => ({
  api: {
    listDatabases: vi.fn(),
    listSchemas: vi.fn(),
    listInvalidObjects: vi.fn(),
    recompileObject: vi.fn(),
  },
  connectionStore: {
    activeConnectionId: "og-1",
    connections: [{ id: "og-1", name: "openGauss", db_type: "opengauss", database: "postgres" }],
    getConfig: vi.fn(),
    ensureConnected: vi.fn(),
  },
  queryStore: {
    openProgramWindow: vi.fn(),
  },
  toast: vi.fn(),
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
vi.mock("@/composables/useDatabaseOptions", () => ({ databaseOptionsForConnection: (names: string[]) => names }));

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
vi.mock("@/components/ui/badge", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Badge: defineComponent({
      name: "BadgeStub",
      inheritAttrs: false,
      setup(_, context) {
        return () => h("span", context.attrs, context.slots.default?.());
      },
    }),
  };
});
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = (name: string, tag = "div") =>
    defineComponent({
      name,
      inheritAttrs: false,
      setup(_, context) {
        return () => h(tag, context.attrs, context.slots.default?.());
      },
    });
  return {
    Dialog: defineComponent({
      name: "DialogStub",
      setup(_, context) {
        return () => h("div", context.slots.default?.());
      },
    }),
    DialogContent: passthrough("DialogContentStub"),
    DialogFooter: passthrough("DialogFooterStub"),
    DialogHeader: passthrough("DialogHeaderStub"),
    DialogTitle: passthrough("DialogTitleStub", "h2"),
  };
});

vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ name: "IconStub", setup: () => () => h("i") });
  return { AlertCircle: Icon, Check: Icon, CheckCircle2: Icon, Code2: Icon, Loader2: Icon, RefreshCw: Icon, RotateCcw: Icon, Search: Icon };
});

import InvalidObjectsDialog from "@/components/maintenance/InvalidObjectsDialog.vue";

const INVALID_OBJECTS = [
  { schema: "public", name: "bad_proc", objectType: "PROCEDURE", errorLine: 3, errorMessage: "missing dependency" },
  { schema: "app", name: "bad_fn", objectType: "FUNCTION", errorLine: 8, errorMessage: "invalid relation" },
];

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await nextTick();
}

async function mountDialog() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(InvalidObjectsDialog, {
    open: true,
    prefillConnectionId: "og-1",
    prefillDatabase: "postgres",
    prefillSchema: "app",
  });
  app.mount(root);
  await flushUi();
  return root;
}

async function mountDialogWithOpenState() {
  const open = ref(true);
  root = document.createElement("div");
  document.body.appendChild(root);
  const host = defineComponent({
    setup() {
      return () =>
        h(InvalidObjectsDialog, {
          open: open.value,
          prefillConnectionId: "og-1",
          prefillDatabase: "postgres",
          prefillSchema: "app",
        });
    },
  });
  app = createApp(host);
  app.mount(root);
  await flushUi();
  return { dialog: root, close: () => (open.value = false) };
}

beforeEach(() => {
  state.api.listDatabases.mockReset().mockResolvedValue([{ name: "postgres" }]);
  state.api.listSchemas.mockReset().mockResolvedValue(["public", "app"]);
  state.api.listInvalidObjects.mockReset().mockResolvedValue(INVALID_OBJECTS);
  state.api.recompileObject.mockReset().mockResolvedValue({ schema: "app", name: "bad_fn", objectType: "FUNCTION", success: true, elapsedMs: 4 });
  state.connectionStore.getConfig.mockReset().mockReturnValue({ id: "og-1", name: "openGauss", db_type: "opengauss", database: "postgres" });
  state.connectionStore.ensureConnected.mockReset().mockResolvedValue(undefined);
  state.queryStore.openProgramWindow.mockReset();
  state.toast.mockReset();
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("InvalidObjectsDialog", () => {
  it("loads the prefilled scope and scans invalid objects", async () => {
    const dialog = await mountDialog();
    const selects = [...dialog.querySelectorAll<HTMLSelectElement>("select")];

    expect(state.connectionStore.ensureConnected).toHaveBeenCalledWith("og-1");
    expect(state.api.listDatabases).toHaveBeenCalledWith("og-1");
    expect(state.api.listSchemas).toHaveBeenCalledWith("og-1", "postgres");
    expect(state.api.listInvalidObjects).toHaveBeenCalledWith("og-1", "postgres", "app");
    expect(selects.map((select) => select.value)).toEqual(["og-1", "postgres", "app", "ALL"]);
    expect(dialog.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(dialog.textContent).toContain("bad_proc");
    expect(dialog.textContent).toContain("missing dependency");
  });

  it("recompiles all visible invalid objects and reports per-item results", async () => {
    state.api.recompileObject.mockResolvedValueOnce({ schema: "public", name: "bad_proc", objectType: "PROCEDURE", success: true, elapsedMs: 3 }).mockResolvedValueOnce({ schema: "app", name: "bad_fn", objectType: "FUNCTION", success: false, error: "compile failed", elapsedMs: 5 });

    const dialog = await mountDialog();
    const recompileAll = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("invalidObjects.recompileAll"));
    if (!recompileAll) throw new Error("recompile all button not found");

    recompileAll.click();
    await flushUi();

    expect(state.api.recompileObject).toHaveBeenNthCalledWith(1, "og-1", "postgres", "public", "bad_proc", "PROCEDURE");
    expect(state.api.recompileObject).toHaveBeenNthCalledWith(2, "og-1", "postgres", "app", "bad_fn", "FUNCTION");
    expect(state.api.listInvalidObjects).toHaveBeenCalledTimes(2);
    expect(state.toast).toHaveBeenCalledWith(expect.stringContaining("invalidObjects.batchComplete"), 3000);
  });

  it("filters by object type and keeps a single compile failure on the row", async () => {
    state.api.recompileObject.mockResolvedValue({ schema: "app", name: "bad_fn", objectType: "FUNCTION", success: false, error: "compile failed", elapsedMs: 7 });

    const dialog = await mountDialog();
    const typeFilter = dialog.querySelectorAll<HTMLSelectElement>("select")[3];
    typeFilter.value = "FUNCTION";
    typeFilter.dispatchEvent(new Event("change", { bubbles: true }));
    await flushUi();

    expect(dialog.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(dialog.textContent).not.toContain("bad_proc");
    const compileButton = [...dialog.querySelectorAll<HTMLButtonElement>("tbody button")].find((button) => button.textContent?.includes("invalidObjects.compile"));
    if (!compileButton) throw new Error("single compile button not found");

    compileButton.click();
    await flushUi();

    expect(state.api.recompileObject).toHaveBeenCalledWith("og-1", "postgres", "app", "bad_fn", "FUNCTION");
    expect(dialog.textContent).toContain("compile failed");
  });

  it("stops a batch after the dialog closes", async () => {
    let resolveFirst!: (value: unknown) => void;
    state.api.recompileObject.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const { dialog, close } = await mountDialogWithOpenState();
    const recompileAll = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("invalidObjects.recompileAll"));
    if (!recompileAll) throw new Error("recompile all button not found");

    recompileAll.click();
    await Promise.resolve();
    close();
    await nextTick();
    resolveFirst({ schema: "public", name: "bad_proc", objectType: "PROCEDURE", success: true, elapsedMs: 3 });
    await flushUi();

    expect(state.api.recompileObject).toHaveBeenCalledTimes(1);
    expect(state.toast).not.toHaveBeenCalledWith(expect.stringContaining("invalidObjects.batchComplete"), 3000);
  });

  it("opens the selected object in the matching program window", async () => {
    const dialog = await mountDialog();
    const editButton = dialog.querySelector<HTMLButtonElement>('button[title="invalidObjects.editSource"]');
    if (!editButton) throw new Error("edit source button not found");

    editButton.click();
    await flushUi();

    expect(state.queryStore.openProgramWindow).toHaveBeenCalledWith({
      connectionId: "og-1",
      database: "postgres",
      schema: "public",
      name: "bad_proc",
      objectType: "PROCEDURE",
    });
  });
});
