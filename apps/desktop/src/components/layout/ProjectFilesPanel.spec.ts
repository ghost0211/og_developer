// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";

const state = vi.hoisted(() => ({
  api: {
    listFilesInFolder: vi.fn(),
    readExternalSqlFile: vi.fn(),
    revealPathInFileManager: vi.fn(),
  },
  projectStore: {
    projects: { value: [{ id: "project-1", name: "workspace", path: "/workspace", connectionId: "og-1" }] },
    activeProjectId: { value: "project-1" },
    activeProject: { value: { id: "project-1", name: "workspace", path: "/workspace", connectionId: "og-1" } },
    setActiveProject: vi.fn(),
  },
  connectionStore: {
    activeConnectionId: "og-1",
    connections: [{ id: "og-1", name: "openGauss", db_type: "opengauss", database: "postgres" }],
    getConfig: vi.fn(),
    sqlFileSource: null,
  },
  gitStore: {
    isRepo: false,
    entries: [],
    status: null,
    refresh: vi.fn(),
  },
  queryStore: {
    openExternalSqlFile: vi.fn(),
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
vi.mock("@/stores/projectStore", () => ({ useProjectStore: () => state.projectStore }));
vi.mock("@/stores/gitStore", () => ({ useGitStore: () => state.gitStore }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => state.connectionStore }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => state.queryStore }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: state.copyToClipboard }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/database/defaultDatabase", () => ({ resolveDefaultDatabase: () => "postgres" }));
vi.mock("@/lib/sql/externalSqlFileTarget", () => ({ resolveExternalSqlFileTarget: () => ({ connectionId: "og-1", database: "postgres" }) }));
vi.mock("@/lib/sql/sqlFileOpen", () => ({
  externalSqlFileOpenErrorMessage: () => "open failed",
  formatSqlFileSize: (size: number) => `${size} B`,
  isExternalSqlFileTooLargeError: () => false,
}));
vi.mock("@/i18n/backend-errors", () => ({ translateBackendError: () => "backend error" }));

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
vi.mock("@/components/ui/LightTooltip.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "LightTooltipStub",
      inheritAttrs: false,
      setup(_, context) {
        return () => h("div", context.attrs, context.slots.default?.());
      },
    }),
  };
});
vi.mock("@/components/ui/select", async () => {
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
    Select: passthrough("SelectStub"),
    SelectContent: passthrough("SelectContentStub"),
    SelectItem: passthrough("SelectItemStub", "option"),
    SelectTrigger: passthrough("SelectTriggerStub", "button"),
    SelectValue: passthrough("SelectValueStub"),
  };
});
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: defineComponent({
    name: "CustomContextMenuStub",
    setup(_, context) {
      return () => h("div", context.slots.default?.({ onContextMenu: () => undefined }));
    },
  }),
}));

vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ name: "IconStub", setup: () => () => h("i") });
  return {
    FolderOpen: Icon,
    FileCode: Icon,
    FolderClosed: Icon,
    ChevronRight: Icon,
    ChevronDown: Icon,
    X: Icon,
    RefreshCw: Icon,
    FolderSearch: Icon,
    Copy: Icon,
    Play: Icon,
    File: Icon,
    FolderPlus: Icon,
    ChevronsUpDown: Icon,
    ChevronsDownUp: Icon,
  };
});

import ProjectFilesPanel from "@/components/layout/ProjectFilesPanel.vue";

const FILES = [
  { name: "queries", path: "/workspace/queries", is_dir: true, children: [] },
  { name: "README.md", path: "/workspace/README.md", is_dir: false, children: [] },
];
const QUERY_FILES = [
  { name: "query.sql", path: "/workspace/queries/query.sql", is_dir: false, children: [] },
  { name: "README.md", path: "/workspace/queries/README.md", is_dir: false, children: [] },
];

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function mountPanel() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(ProjectFilesPanel);
  app.mount(root);
  await flushUi();
  return root;
}

beforeEach(() => {
  state.api.listFilesInFolder.mockReset().mockImplementation((path: string) => (path === "/workspace" ? FILES : QUERY_FILES));
  state.api.readExternalSqlFile.mockReset().mockResolvedValue("SELECT 1;");
  state.api.revealPathInFileManager.mockReset().mockResolvedValue(undefined);
  state.connectionStore.getConfig.mockReset().mockReturnValue(state.connectionStore.connections[0]);
  state.queryStore.openExternalSqlFile.mockReset();
  state.toast.mockReset();
  state.copyToClipboard.mockReset().mockResolvedValue(undefined);
  state.projectStore.projects.value = [{ id: "project-1", name: "workspace", path: "/workspace", connectionId: "og-1" }];
  state.projectStore.activeProjectId.value = "project-1";
  state.projectStore.activeProject.value = state.projectStore.projects.value[0];
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("ProjectFilesPanel", () => {
  it("loads the active project and exposes every file type through an expandable tree", async () => {
    const panel = await mountPanel();

    expect(state.api.listFilesInFolder).toHaveBeenCalledWith("/workspace");
    expect(panel.textContent).toContain("queries");
    expect(panel.textContent).toContain("README.md");
    expect(panel.querySelector('[title="/workspace/queries/query.sql"]')).toBeNull();

    const directory = panel.querySelector<HTMLElement>('[title="/workspace/queries"]');
    if (!directory) throw new Error("project directory row not found");
    directory.click();
    await flushUi();

    expect(state.api.listFilesInFolder).toHaveBeenNthCalledWith(2, "/workspace/queries");
    expect(panel.querySelector('[title="/workspace/queries/query.sql"]')).not.toBeNull();
    expect(panel.querySelector('[title="/workspace/queries/README.md"]')).not.toBeNull();
  });

  it("resets lazy expansion state when the project root is refreshed", async () => {
    const panel = await mountPanel();
    const directory = panel.querySelector<HTMLElement>('[title="/workspace/queries"]');
    if (!directory) throw new Error("project directory row not found");
    directory.click();
    await flushUi();
    expect(panel.querySelector('[title="/workspace/queries/query.sql"]')).not.toBeNull();

    const refreshButton = panel.querySelector<HTMLButtonElement>("button");
    if (!refreshButton) throw new Error("refresh button not found");
    refreshButton.click();
    await flushUi();

    expect(state.api.listFilesInFolder).toHaveBeenNthCalledWith(3, "/workspace");
    expect(panel.querySelector('[title="/workspace/queries/query.sql"]')).toBeNull();
  });

  it("opens SQL files with the active project connection and database context", async () => {
    const panel = await mountPanel();
    const directory = panel.querySelector<HTMLElement>('[title="/workspace/queries"]');
    if (!directory) throw new Error("project directory row not found");
    directory.click();
    await flushUi();

    const sqlFile = panel.querySelector<HTMLElement>('[title="/workspace/queries/query.sql"]');
    if (!sqlFile) throw new Error("SQL file row not found");
    sqlFile.click();
    await flushUi();

    expect(state.api.readExternalSqlFile).toHaveBeenCalledWith("/workspace/queries/query.sql");
    expect(state.queryStore.openExternalSqlFile).toHaveBeenCalledWith("og-1", "postgres", "/workspace/queries/query.sql", "SELECT 1;");
  });

  it("shows a recoverable state when the project scan fails", async () => {
    state.api.listFilesInFolder.mockRejectedValueOnce(new Error("scan failed"));

    const panel = await mountPanel();

    expect(panel.textContent).toContain("projectFiles.loadFailed");
  });
});
