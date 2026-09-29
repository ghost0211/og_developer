// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";

const state = vi.hoisted(() => ({
  api: {
    listDatabases: vi.fn(),
  },
  connectionStore: {
    activeConnectionId: "pg-a",
    connections: [] as Array<Record<string, any>>,
    getConfig: vi.fn(),
    ensureConnected: vi.fn(),
  },
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}: ${String(values.message ?? "")}` : key),
  }),
}));
vi.mock("@/lib/backend/api", () => state.api);
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => state.connectionStore }));

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
    DialogDescription: passthrough("DialogDescriptionStub"),
    DialogFooter: passthrough("DialogFooterStub"),
    DialogHeader: passthrough("DialogHeaderStub"),
    DialogTitle: passthrough("DialogTitleStub", "h2"),
  };
});

vi.mock("@/components/ui/searchable-select/SearchableSelect.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "SearchableSelectStub",
      inheritAttrs: false,
      props: {
        modelValue: { type: String, default: "" },
        options: { type: Array, default: () => [] },
        placeholder: { type: String, default: "" },
        disabled: { type: Boolean, default: false },
        displayName: { type: Function, default: (value: string) => value },
      },
      emits: ["update:modelValue"],
      setup(props, context) {
        return () =>
          h(
            "select",
            {
              ...context.attrs,
              value: props.modelValue,
              disabled: props.disabled,
              onChange: (event: Event) => context.emit("update:modelValue", (event.target as HTMLSelectElement).value),
            },
            [h("option", { value: "" }, props.placeholder), ...(props.options as string[]).map((value) => h("option", { key: value, value }, props.displayName(value)))],
          );
      },
    }),
  };
});

import ToolTargetPickerDialog from "@/components/layout/ToolTargetPickerDialog.vue";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;
let confirmed: unknown[] = [];

async function flushUi() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
  await nextTick();
}

function createConnection(id: string, dbType: string, database: string, extra: Record<string, unknown> = {}) {
  return { id, name: `Connection ${id}`, db_type: dbType, database, host: "localhost", port: 5432, username: "user", password: "", ...extra };
}

function mountDialog(options: { kind: string; initialConnectionId?: string; initialDatabase?: string }) {
  const dialogState = reactive({ open: true, ...options });
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(ToolTargetPickerDialog, {
            open: dialogState.open,
            kind: dialogState.kind,
            initialConnectionId: dialogState.initialConnectionId,
            initialDatabase: dialogState.initialDatabase,
            "onUpdate:open": (value: boolean) => (dialogState.open = value),
            onConfirm: (target: unknown) => confirmed.push(target),
          });
      },
    }),
  );
  app.mount(root);
  return root;
}

function picker(testId: string): HTMLSelectElement {
  const element = root?.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`${testId} not found`);
  return element;
}

function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function confirmButton(): HTMLButtonElement {
  const button = [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent?.includes("common.confirm"));
  if (!button) throw new Error("confirm button not found");
  return button;
}

beforeEach(() => {
  state.connectionStore.activeConnectionId = "pg-a";
  state.connectionStore.connections = [
    createConnection("pg-a", "postgres", "a-default", { visible_databases: ["a-default", "a-private"] }),
    createConnection("jdbc-b", "jdbc", "b-default", { driver_profile: "opengauss-jdbc", visible_databases: ["b-default", "b-secondary"] }),
    createConnection("mysql", "mysql", "mysql-db"),
  ];
  state.connectionStore.getConfig.mockReset().mockImplementation((id: string) => state.connectionStore.connections.find((connection) => connection.id === id));
  state.connectionStore.ensureConnected.mockReset().mockResolvedValue(undefined);
  state.api.listDatabases.mockReset().mockImplementation(async (id: string) => (id === "pg-a" ? [{ name: "a-default" }, { name: "a-private" }] : [{ name: "b-default" }, { name: "b-secondary" }]));
  confirmed = [];
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("ToolTargetPickerDialog", () => {
  it("changes connections without leaking the previous connection's databases or confirmation target", async () => {
    let resolveA!: (rows: Array<{ name: string }>) => void;
    let resolveB!: (rows: Array<{ name: string }>) => void;
    state.api.listDatabases.mockImplementation((id: string) => {
      if (id === "pg-a") return new Promise((resolve) => (resolveA = resolve));
      return new Promise((resolve) => (resolveB = resolve));
    });

    const dialog = mountDialog({ kind: "routine-health", initialConnectionId: "pg-a", initialDatabase: "a-default" });
    await flushUi();
    expect(state.connectionStore.ensureConnected).toHaveBeenCalledWith("pg-a", { activate: false });
    expect(state.api.listDatabases).toHaveBeenCalledWith("pg-a");

    choose(picker("connection-picker"), "jdbc-b");
    await flushUi();
    expect(picker("database-picker").value).toBe("");
    expect([...picker("database-picker").options].map((option) => option.value)).toEqual([""]);

    // A late response for the old connection must not repopulate its databases.
    resolveA([{ name: "a-default" }, { name: "a-private" }]);
    await flushUi();
    expect([...picker("database-picker").options].map((option) => option.value)).toEqual([""]);

    resolveB([{ name: "b-default" }, { name: "b-secondary" }]);
    await flushUi();
    expect([...picker("database-picker").options].map((option) => option.value)).toEqual(["", "b-default", "b-secondary"]);
    expect(picker("database-picker").value).toBe("b-default");
    expect(dialog.textContent).not.toContain("a-private");

    choose(picker("database-picker"), "b-secondary");
    confirmButton().click();
    await flushUi();

    expect(confirmed).toEqual([{ kind: "routine-health", connectionId: "jdbc-b", database: "b-secondary" }]);
  });

  it("does not carry an unmatched active tab's database to the fallback connection", async () => {
    state.connectionStore.connections[0]!.visible_databases = ["a-default", "shared"];
    state.api.listDatabases.mockResolvedValue([{ name: "a-default" }, { name: "shared" }]);
    mountDialog({ kind: "top-sql", initialConnectionId: "missing-connection", initialDatabase: "shared" });
    await flushUi();
    expect(picker("connection-picker").value).toBe("pg-a");
    expect(picker("database-picker").value).toBe("a-default");
  });

  it("confirms processlist at instance scope without a database picker or database payload", async () => {
    mountDialog({ kind: "processlist", initialConnectionId: "pg-a", initialDatabase: "a-default" });
    await flushUi();

    expect(picker("connection-picker").value).toBe("pg-a");
    expect(root?.querySelector('[data-testid="database-picker"]')).toBeNull();
    expect(state.connectionStore.ensureConnected).toHaveBeenCalledWith("pg-a", { activate: false });
    expect(state.api.listDatabases).not.toHaveBeenCalled();
    expect(confirmButton().disabled).toBe(false);

    confirmButton().click();
    await flushUi();
    expect(confirmed).toEqual([{ kind: "processlist", connectionId: "pg-a" }]);
  });

  it("offers SQL-capable connection types for the command window", async () => {
    mountDialog({ kind: "command-window" });
    await flushUi();

    expect([...picker("connection-picker").options].map((option) => option.value)).toEqual(["", "pg-a", "jdbc-b", "mysql"]);
  });

  it("requires both a connection and database for table import", async () => {
    mountDialog({ kind: "table-import", initialConnectionId: "mysql" });
    await flushUi();

    expect(picker("connection-picker").value).toBe("mysql");
    expect(picker("database-picker").value).toBe("b-default");
    choose(picker("database-picker"), "b-secondary");
    confirmButton().click();
    await flushUi();

    expect(confirmed).toEqual([{ kind: "table-import", connectionId: "mysql", database: "b-secondary" }]);
  });

  it("shows a clear message when the kind has no eligible connections", async () => {
    state.connectionStore.connections = [createConnection("mysql", "mysql", "mysql-db")];
    mountDialog({ kind: "top-sql" });
    await flushUi();

    expect(root?.textContent).toContain("toolTargetPicker.noConnections");
    expect(confirmButton().disabled).toBe(true);
    expect(state.api.listDatabases).not.toHaveBeenCalled();
  });

  it("shows database loading failures and prevents confirming an incomplete target", async () => {
    state.api.listDatabases.mockRejectedValue(new Error("catalog unavailable"));
    mountDialog({ kind: "routine-health", initialConnectionId: "pg-a" });
    await flushUi();

    expect(root?.textContent).toContain("toolTargetPicker.loadFailed: catalog unavailable");
    expect(confirmButton().disabled).toBe(true);
  });
});
