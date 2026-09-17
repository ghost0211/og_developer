// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, reactive, type App } from "vue";
import type { QueryTab } from "@/types/database";
import type { RoutineHealthSnapshot } from "@/lib/backend/routineHealthTypes";

const state = vi.hoisted(() => ({
  api: {
    listSchemas: vi.fn(),
    listRoutineHealthSnapshot: vi.fn(),
    recompileObject: vi.fn(),
  },
  connectionStore: {
    getConfig: vi.fn(),
    ensureConnected: vi.fn(),
  },
  queryStore: {
    openProgramWindow: vi.fn(),
    createTab: vi.fn(),
  },
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      return `${key} ${Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(" ")}`;
    },
    te: () => false,
  }),
}));

vi.mock("@/lib/backend/api", () => state.api);
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => state.connectionStore }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => state.queryStore }));

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
vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ name: "IconStub", setup: () => () => h("i") });
  return { Activity: Icon, Code2: Icon, Loader2: Icon, RefreshCw: Icon, Search: Icon };
});

import RoutineHealthPanel from "@/components/maintenance/RoutineHealthPanel.vue";

const BAD_SOURCE = "CREATE FUNCTION app.bad_fn() RETURNS int AS $$ BEGIN END; $$ LANGUAGE plpgsql;";

function snapshot(overrides: Partial<RoutineHealthSnapshot> = {}): RoutineHealthSnapshot {
  return {
    routines: [
      { id: "1", schema: "app", name: "get_users", objectType: "FUNCTION", signature: "p_id integer", source: "BEGIN\n SELECT * FROM app.absent;\nEND;", language: "plpgsql" },
      { id: "2", schema: "app", name: "get_users", objectType: "FUNCTION", signature: "p_id text", source: "BEGIN RETURN 1; END;", language: "plpgsql" },
    ],
    relations: [{ schema: "app", name: "users", kind: "r", columns: ["id", "name"] }],
    indexes: [],
    searchPath: ["pg_catalog", "app"],
    invalidObjects: [{ schema: "app", name: "bad_fn", objectType: "FUNCTION", errorLine: 3, errorMessage: "syntax error", source: BAD_SOURCE }],
    warnings: ["Routine calls are checked by name only."],
    ...overrides,
  };
}

function missingSource(name: string, id: string): RoutineHealthSnapshot["routines"][number] {
  return { id, schema: "app", name, objectType: "FUNCTION", signature: "p_id integer", source: "BEGIN SELECT * FROM app.absent; END;", language: "plpgsql" };
}

function makeTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return reactive({
    id: "health-tab",
    connectionId: "c1",
    database: "db",
    schema: "app",
    title: "Routine health",
    mode: "routine-health",
    ...overrides,
  }) as unknown as QueryTab;
}

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
}

async function mountPanel(tab: QueryTab = makeTab()) {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(RoutineHealthPanel, { tab });
  app.mount(root);
  await flushUi();
  return root;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

function check(checkbox: HTMLInputElement, checked: boolean) {
  checkbox.checked = checked;
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  state.api.listSchemas.mockReset().mockResolvedValue(["app", "other"]);
  state.api.listRoutineHealthSnapshot.mockReset().mockResolvedValue(snapshot());
  state.api.recompileObject.mockReset().mockResolvedValue({ schema: "app", name: "bad_fn", objectType: "FUNCTION", success: true, elapsedMs: 3 });
  state.connectionStore.getConfig.mockReset().mockReturnValue({ id: "c1", name: "PostgreSQL", db_type: "postgres", database: "db" });
  state.connectionStore.ensureConnected.mockReset().mockResolvedValue(undefined);
  state.queryStore.openProgramWindow.mockReset();
  state.queryStore.createTab.mockReset();
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("RoutineHealthPanel", () => {
  it("keeps compiler records separate from analysis results", async () => {
    const panel = await mountPanel();
    const compilation = panel.querySelector('[data-origin="compilation"]');
    const analysis = panel.querySelector('[data-origin="analysis"]');

    expect(panel.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(compilation).not.toBeNull();
    expect(analysis).not.toBeNull();
    expect(compilation!.textContent).toContain("routineHealth.compilationFailed");
    expect(compilation!.textContent).toContain("bad_fn");
    expect(compilation!.textContent).toContain("syntax error");
    expect(analysis!.textContent).toContain("app.get_users");
    expect(analysis!.textContent).toContain("未找到表或视图 app.absent。");
    expect(compilation!.querySelector('[data-testid="retry-record"]')).not.toBeNull();
    expect(analysis!.querySelector('[data-testid="retry-record"]')).toBeNull();
  });

  it("navigates same-name overloads by signature and keeps the panel state", async () => {
    const panel = await mountPanel();
    const analysis = panel.querySelector('[data-origin="analysis"]')!;
    expect(analysis.textContent).toContain("p_id integer");
    analysis.querySelector<HTMLButtonElement>('[data-testid="open-source"]')!.click();
    await flushUi();

    expect(state.queryStore.openProgramWindow).toHaveBeenCalledTimes(1);
    expect(state.queryStore.openProgramWindow).toHaveBeenCalledWith({
      connectionId: "c1",
      database: "db",
      schema: "app",
      name: "get_users",
      objectType: "FUNCTION",
      signature: "p_id integer",
      catalog: undefined,
    });
    // Navigating away must not drop the analyzed results.
    expect(panel.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(panel.querySelector('[data-origin="analysis"]')).not.toBeNull();
  });

  it("views recorded compiler source without navigating an overload", async () => {
    const panel = await mountPanel();
    panel.querySelector('[data-origin="compilation"]')!.querySelector<HTMLButtonElement>('[data-testid="open-source"]')!.click();
    await flushUi();

    expect(state.queryStore.createTab).toHaveBeenCalledWith("c1", "db", "app.bad_fn", "query", "app", BAD_SOURCE, undefined, { forceNew: true });
    expect(state.queryStore.openProgramWindow).not.toHaveBeenCalled();
  });

  it("does not claim VALID when there are no compiler failure records", async () => {
    state.api.listRoutineHealthSnapshot.mockResolvedValue(snapshot({ routines: [], invalidObjects: [] }));
    const panel = await mountPanel();

    expect(panel.textContent).not.toContain("VALID");
    expect(panel.textContent).not.toContain("invalidObjects.emptyHint");
    expect(panel.textContent).toContain("routineHealth.noRoutines");
  });

  it("clears stale results when a scan fails", async () => {
    const panel = await mountPanel();
    expect(panel.querySelectorAll("tbody tr").length).toBeGreaterThan(0);

    state.api.listRoutineHealthSnapshot.mockRejectedValueOnce(new Error("catalog unavailable"));
    buttonByText(panel, "routineHealth.analyze").click();
    await flushUi();

    expect(panel.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(panel.textContent).toContain("routineHealth.scanFailed");
    expect(panel.textContent).toContain("catalog unavailable");
  });

  it("ignores a stale async response after the scope changes", async () => {
    let resolveStale!: (value: RoutineHealthSnapshot) => void;
    state.api.listRoutineHealthSnapshot
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockResolvedValue(snapshot({ routines: [missingSource("fresh_fn", "9")], invalidObjects: [] }));
    const tab = makeTab();
    const panel = await mountPanel(tab);
    expect(state.api.listRoutineHealthSnapshot).toHaveBeenCalledTimes(1);

    tab.schema = "other";
    await flushUi();
    resolveStale(snapshot({ routines: [missingSource("stale_fn", "8")], invalidObjects: [] }));
    await flushUi();

    expect(panel.textContent).toContain("fresh_fn");
    expect(panel.textContent).not.toContain("stale_fn");
  });

  it("allows DDL retry only for compilation records and refreshes the analysis", async () => {
    const panel = await mountPanel();
    const retryButtons = panel.querySelectorAll('[data-testid="retry-record"]');

    expect(retryButtons).toHaveLength(1);
    expect(retryButtons[0]!.closest('[data-origin="compilation"]')).not.toBeNull();
    (retryButtons[0] as HTMLButtonElement).click();
    await flushUi();

    expect(state.api.recompileObject).toHaveBeenCalledWith("c1", "db", "app", "bad_fn", "FUNCTION");
    expect(state.api.listRoutineHealthSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps DDL execution errors visible after the refresh", async () => {
    state.api.recompileObject.mockResolvedValue({ schema: "app", name: "bad_fn", objectType: "FUNCTION", success: false, error: "relation users does not exist", elapsedMs: 4 });
    const panel = await mountPanel();
    panel.querySelector<HTMLButtonElement>('[data-testid="retry-record"]')!.click();
    await flushUi();

    expect(panel.textContent).toContain("relation users does not exist");
    expect(panel.textContent).toContain("routineHealth.retrySummary");
    expect(state.api.listRoutineHealthSnapshot).toHaveBeenCalledTimes(2);
  });

  it("stops remaining batch retries when the panel is disposed", async () => {
    let resolveFirst!: (value: unknown) => void;
    state.api.recompileObject.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    state.api.listRoutineHealthSnapshot.mockResolvedValue(
      snapshot({
        invalidObjects: [
          { schema: "app", name: "bad_fn", objectType: "FUNCTION", errorMessage: "syntax error", source: BAD_SOURCE },
          { schema: "app", name: "worse_fn", objectType: "FUNCTION", errorMessage: "still broken", source: BAD_SOURCE },
        ],
      }),
    );
    const panel = await mountPanel();
    check(panel.querySelector<HTMLInputElement>('thead input[type="checkbox"]')!, true);
    await flushUi();
    buttonByText(panel, "routineHealth.retrySelected").click();
    await Promise.resolve();

    app?.unmount();
    app = null;
    resolveFirst({ schema: "app", name: "bad_fn", objectType: "FUNCTION", success: true, elapsedMs: 2 });
    await flushUi();

    expect(state.api.recompileObject).toHaveBeenCalledTimes(1);
  });
});
