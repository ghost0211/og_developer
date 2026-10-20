// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderClosed, FolderOpen } from "@lucide/vue";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey } from "@/lib/sidebar/sidebarTreeRuntime";
import type { TreeNode } from "@/types/database";

const connectionStore = {
  activeConnectionId: "c",
  connectedIds: new Set(["c"]),
  connectingIds: new Set<string>(),
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: () => ({ id: "c", db_type: "opengauss" }),
  isDefaultDatabase: () => false,
  isPinnedTreeNodeReorderTarget: () => false,
  isTreeNodeChildrenLoaded: () => false,
  isTreeNodePinned: () => false,
  selectedTreeNodeId: null as string | null,
  selectedTreeNodeIds: [],
  selectedTreeNodeIdsSet: new Set<string>(),
  sidebarTableSearchQueries: {},
  tableNameFilterForScope: () => undefined,
  treeNodes: [],
  treeSelectionAnchorId: null,
};
const settingsStore = {
  editorSettings: {
    shortcuts: { openDataInNewTab: "" },
    sidebarActivation: "double",
    sidebarAllowHorizontalScroll: false,
    sidebarHiddenTablePrefixes: [],
    sidebarObjectInfoMode: "comment-inline",
  },
};
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => connectionStore }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ openDatabaseKeys: new Set<string>() }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => settingsStore }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const apps: App[] = [];

function schemaNode(isExpanded: boolean): TreeNode {
  return {
    id: "c:test_pg:public",
    label: "public",
    type: "schema",
    connectionId: "c",
    database: "test_pg",
    schema: "public",
    isExpanded,
    children: isExpanded ? [{ id: "c:test_pg:public:__tables", label: "tree.tables", type: "group-tables", connectionId: "c", database: "test_pg", schema: "public", children: [] }] : [],
  };
}

function lucideIconMarkup(icon: typeof FolderClosed): string {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(defineComponent({ setup: () => () => h(icon) }));
  apps.push(app);
  app.mount(container);
  const markup = container.querySelector("svg")!.innerHTML;
  app.unmount();
  container.remove();
  return markup;
}

function schemaIconMarkup(container: HTMLElement): string {
  // The schema folder icon carries the sky color class; the expand chevron and
  // other row icons do not, so this selects exactly the object icon.
  const icon = container.querySelector<SVGElement>("svg.text-sky-400");
  expect(icon, "schema folder icon svg must render").not.toBeNull();
  return icon!.innerHTML;
}

async function mountSchema(node: TreeNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(defineComponent({ setup: () => () => h(TreeItem, { node, depth: 1 }) }));
  apps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, createSidebarTreeRuntime());
  app.mount(container);
  await nextTick();
  return container;
}

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("schema folder icon follows expand state", () => {
  it("renders the closed folder when collapsed and the open folder when expanded", async () => {
    const closedMarkup = lucideIconMarkup(FolderClosed);
    const openMarkup = lucideIconMarkup(FolderOpen);
    expect(closedMarkup).not.toBe(openMarkup);

    const collapsed = await mountSchema(schemaNode(false));
    expect(schemaIconMarkup(collapsed)).toBe(closedMarkup);

    const expanded = await mountSchema(schemaNode(true));
    expect(schemaIconMarkup(expanded)).toBe(openMarkup);
  });

  it("switches the icon reactively when the schema node is toggled", async () => {
    const node = reactive(schemaNode(false)) as TreeNode;
    const container = await mountSchema(node);
    const closedMarkup = schemaIconMarkup(container);

    node.isExpanded = true;
    node.children = schemaNode(true).children;
    await nextTick();

    const openMarkup = schemaIconMarkup(container);
    expect(openMarkup).not.toBe(closedMarkup);
    expect(openMarkup).toBe(lucideIconMarkup(FolderOpen));
  });
});
