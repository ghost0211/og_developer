// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey } from "@/lib/sidebar/sidebarTreeRuntime";
import { buildGroupedObjectTreeNodes } from "@/lib/table/tableTree";
import { isSidebarCommentAlignableNode, sidebarTreeNodeComment } from "@/lib/sidebar/sidebarTreeItemLayout";
import { synchronizeTriggerNodes } from "@/lib/sidebar/triggerActions";
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
  connectionStore.selectedTreeNodeId = null;
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

describe("TreeItem routine comments", () => {
  const routineNodes = () =>
    (["FUNCTION", "PROCEDURE"] as const).map(
      (object_type) =>
        buildGroupedObjectTreeNodes({
          nodeId: "c:test_pg:app",
          connectionId: "c",
          database: "test_pg",
          schema: "app",
          objects: [{ name: `validate_${object_type.toLowerCase()}`, object_type, schema: "app", signature: "(integer)", comment: `校验用户账号 ${object_type}` }],
        })[0]!.children![0]!,
    );

  it.each(["comment-inline", "comment-aligned", "comment-right"])("renders procedure/function comments in the real row (%s)", async (mode) => {
    settingsStore.editorSettings.sidebarObjectInfoMode = mode;
    const nodes = routineNodes();
    const container = await mountNodes(nodes);
    await vi.waitFor(() => expect([...container.querySelectorAll(".sidebar-object-comment")].map((element) => element.textContent)).toEqual(nodes.map((node) => node.comment)));
    expect(nodes.map((node) => node.type)).toEqual(["function", "procedure"]);
    expect(container.textContent).toContain("validate_function");
    expect(container.textContent).toContain("validate_procedure");
    expect(container.querySelector(".tree-item-object-disabled")).toBeNull();
  });

  it.each(["function", "procedure"] as const)("shows the full %s comment tooltip without a label overflow", async (type) => {
    const node = routineNodes().find((entry) => entry.type === type)!;
    node.comment = "Long routine documentation ".repeat(20);
    const container = await mountNodes([node]);
    const row = container.querySelector<HTMLElement>("[tabindex]")!;
    // happy-dom doesn't maintain the browser's :hover state from mouse events.
    const matches = row.matches.bind(row);
    vi.spyOn(row, "matches").mockImplementation((selector) => selector === ":hover" || matches(selector));
    row.parentElement!.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(node.comment!.trim()));
  });

  it("does not fabricate comments and respects hidden metadata mode", async () => {
    const nodes = routineNodes();
    nodes[0]!.comment = undefined;
    const container = await mountNodes(nodes);
    expect(container.querySelectorAll(".sidebar-object-comment")).toHaveLength(1);
    settingsStore.editorSettings.sidebarObjectInfoMode = "none";
    const hidden = await mountNodes(routineNodes());
    expect(hidden.querySelector(".sidebar-object-comment")).toBeNull();
  });
});

describe("TreeItem disabled database object colors", () => {
  it.each(["trigger", "job", "scheduler"] as const)("grays both name and icon for a disabled %s, including selection", async (type) => {
    const node: TreeNode = {
      ...triggerNodes()[0]!,
      type,
      triggerEnabledMode: type === "trigger" ? "D" : undefined,
      jobEnabled: type === "trigger" ? undefined : false,
    };
    connectionStore.selectedTreeNodeId = node.id;
    const container = await mountNodes([node]);
    const row = container.querySelector<HTMLElement>("[tabindex]")!;
    expect(row.classList.contains("tree-item-object-disabled")).toBe(true);
    expect(row.classList.contains("text-muted-foreground")).toBe(true);
    expect(row.classList.contains("tree-item-active")).toBe(true);
    expect(row.querySelector(".sidebar-object-name")?.classList.contains("text-muted-foreground")).toBe(true);
    expect(row.querySelector("svg")?.classList.contains("text-muted-foreground")).toBe(true);
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(row.classList.contains("cursor-pointer")).toBe(true);
  });

  it.each(["job", "scheduler"] as const)("does not guess %s state from a disabled-looking comment", async (type) => {
    const node: TreeNode = { ...triggerNodes()[0]!, type, comment: "disabled · every disabled_interval", jobEnabled: undefined };
    const container = await mountNodes([node]);
    expect(container.querySelector(".tree-item-object-disabled")).toBeNull();
    expect(container.querySelector(".sidebar-object-name")?.classList.contains("text-muted-foreground")).toBe(false);
    expect(container.querySelector("[tabindex] svg")?.classList.contains("text-muted-foreground")).toBe(false);
  });

  it("repaints the name and icon when a live trigger snapshot disables and re-enables it", async () => {
    const node = reactive(triggerNodes()[0]!);
    const container = await mountNodes([node]);
    expect(container.querySelector(".tree-item-object-disabled")).toBeNull();
    synchronizeTriggerNodes([node], node, [{ name: node.objectName!, timing: "AFTER", event: "UPDATE", enabled_mode: "D" }]);
    await nextTick();
    expect(container.querySelector(".tree-item-object-disabled")).not.toBeNull();
    expect(container.querySelector(".sidebar-object-name")?.classList.contains("text-muted-foreground")).toBe(true);
    expect(container.querySelector("[tabindex] svg")?.classList.contains("text-muted-foreground")).toBe(true);
    synchronizeTriggerNodes([node], node, [{ name: node.objectName!, timing: "AFTER", event: "UPDATE", enabled_mode: "O" }]);
    await nextTick();
    expect(container.querySelector(".tree-item-object-disabled")).toBeNull();
    expect(container.querySelector(".sidebar-object-name")?.classList.contains("text-muted-foreground")).toBe(false);
    expect(container.querySelector("[tabindex] svg")?.classList.contains("text-orange-300")).toBe(true);
  });

  it.each(["job", "scheduler"] as const)("restores %s colors after a fresh enabled state", async (type) => {
    const node = reactive<TreeNode>({ ...triggerNodes()[0]!, type, jobEnabled: false });
    const container = await mountNodes([node]);
    expect(container.querySelector(".tree-item-object-disabled")).not.toBeNull();
    node.jobEnabled = true;
    await nextTick();
    expect(container.querySelector(".tree-item-object-disabled")).toBeNull();
    expect(container.querySelector(".sidebar-object-name")?.classList.contains("text-muted-foreground")).toBe(false);
    expect(container.querySelector("[tabindex] svg")?.classList.contains(type === "job" ? "text-orange-500" : "text-amber-500")).toBe(true);
  });
});
