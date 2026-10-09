// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey } from "@/lib/sidebar/sidebarTreeRuntime";
import { buildGroupedObjectTreeNodes } from "@/lib/table/tableTree";
import { isSidebarCommentAlignableNode, sidebarTreeNodeComment } from "@/lib/sidebar/sidebarTreeItemLayout";
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
  selectedTreeNodeId: null,
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
function triggerNodes(comment?: string): TreeNode[] {
  return buildGroupedObjectTreeNodes({
    nodeId: "c:test_pg:erow_biz",
    connectionId: "c",
    database: "test_pg",
    schema: "erow_biz",
    objects: ["test_jsonb_unique", "other_table"].map((parent_name) => ({
      name: "ogdev_display_test_trg",
      object_type: "TRIGGER",
      schema: "erow_biz",
      parent_schema: "erow_biz",
      parent_name,
      comment,
      enabled_mode: "O",
    })),
  })[0]!.children!;
}
async function mountNodes(nodes: TreeNode[]) {
  // happy-dom has no layout engine. Fixed widths only allow the real component's
  // right-aligned metadata branch to render; this test checks content, not geometry.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(180);
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(
          "div",
          nodes.map((node) => h(TreeItem, { node, depth: 3, commentLabelWidth: 220 })),
        ),
    }),
  );
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
  settingsStore.editorSettings.sidebarObjectInfoMode = "comment-inline";
  vi.restoreAllMocks();
});

describe("TreeItem schema trigger owner comments", () => {
  it("passes trigger ownership through the actual comment and alignment policy", () => {
    const node = triggerNodes()[0]!;
    expect(node.tableName).toBe("test_jsonb_unique");
    expect(node.comment).toBe("test_jsonb_unique");
    expect(sidebarTreeNodeComment(node)).toBe("test_jsonb_unique");
    expect(isSidebarCommentAlignableNode(node)).toBe(true);
  });

  it.each(["comment-inline", "comment-aligned", "comment-right"])("renders owning table in %s mode even without a trigger comment", async (mode) => {
    settingsStore.editorSettings.sidebarObjectInfoMode = mode;
    const container = await mountNodes(triggerNodes());
    await vi.waitFor(() => {
      const comments = [...container.querySelectorAll(".sidebar-object-comment")].map((element) => element.textContent);
      expect(comments).toEqual(["test_jsonb_unique", "other_table"]);
    });
    expect(container.textContent).toContain("ogdev_display_test_trg");
  });

  it("renders the table and real trigger comment without changing object identity", async () => {
    const nodes = triggerNodes("Audit writes");
    const container = await mountNodes(nodes);
    expect([...container.querySelectorAll(".sidebar-object-comment")].map((element) => element.textContent)).toEqual(["test_jsonb_unique — Audit writes", "other_table — Audit writes"]);
    expect(nodes[0]!.objectName).toBe("ogdev_display_test_trg");
    expect(nodes[0]!.tableName).toBe("test_jsonb_unique");
    expect(nodes[0]!.id).not.toBe(nodes[1]!.id);
  });

  it("respects the setting that hides object comments", async () => {
    settingsStore.editorSettings.sidebarObjectInfoMode = "none";
    const container = await mountNodes(triggerNodes());
    expect(container.querySelector(".sidebar-object-comment")).toBeNull();
  });
});
