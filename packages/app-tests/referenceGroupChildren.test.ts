import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, test, vi } from "vitest";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import type { ConnectionConfig, TreeNode } from "../../apps/desktop/src/types/database.ts";

function installMemoryStorage() {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

let restoreLocalStorage: (() => void) | undefined;

const apiMock = vi.hoisted(() => ({
  listObjectReferences: vi.fn(),
  getConfig: vi.fn(),
  listDatabases: vi.fn(),
  listSchemas: vi.fn(),
}));

vi.mock("../../apps/desktop/src/lib/backend/api", () => apiMock);

beforeEach(() => {
  setActivePinia(createPinia());
  restoreLocalStorage = installMemoryStorage();
  apiMock.listObjectReferences.mockReset();
  apiMock.listDatabases.mockReset();
  apiMock.listSchemas.mockReset();
  apiMock.getConfig.mockReset();
});

test("reference group children render from listObjectReferences", async () => {
  const store = useConnectionStore();
  // 构造一个表节点 + 被引用组节点
  const tableNode: TreeNode = {
    id: "conn:db:public:ogdev_emp",
    label: "ogdev_emp",
    type: "table",
    connectionId: "conn",
    database: "db",
    schema: "public",
    isExpanded: false,
    children: [],
  };
  const refNode: TreeNode = {
    id: "conn:db:public:ogdev_emp:__referencedBy",
    label: "tree.referencedBy",
    type: "group-referenced-by",
    referenceDirection: "referencedBy",
    referenceObjectType: "table",
    objectName: "ogdev_emp",
    connectionId: "conn",
    database: "db",
    schema: "public",
    isExpanded: false,
    children: [],
  };
  // 注入 store 树
  // @ts-expect-error store internals
  store.treeNodes = [{ id: "conn", type: "connection", connectionId: "conn", label: "conn", children: [tableNode] }];
  // @ts-expect-error store internals
  tableNode.children = [refNode];
  // @ts-expect-error store internals
  store.configs = new Map([["conn", { id: "conn", name: "conn", db_type: "opengauss", host: "h", port: 1, username: "u", password: "" }]]);
  apiMock.listObjectReferences.mockResolvedValue([{ schema: "public", name: "mv_emp", objectType: "materialized_view", detail: "view definition" }]);
  apiMock.listDatabases.mockResolvedValue([]);
  apiMock.listSchemas.mockResolvedValue([]);

  await store.loadReferenceGroupChildren(refNode);
  console.log("API calls:", apiMock.listObjectReferences.mock.calls.length, JSON.stringify(apiMock.listObjectReferences.mock.calls));

  // @ts-expect-error store internals
  const live = store.treeNodes[0].children[0].children[0];
  assert.equal(live.type, "group-referenced-by");
  const children = live.children ?? [];
  assert.equal(children.length, 1, `expected 1 child, got ${JSON.stringify(children)}`);
  assert.equal(children[0].label, "public.mv_emp (view definition)");
  assert.equal(children[0].type, "materialized_view");
  assert.equal(apiMock.listObjectReferences.mock.calls[0][3], "table");
  assert.equal(apiMock.listObjectReferences.mock.calls[0][4], "ogdev_emp");
  assert.equal(apiMock.listObjectReferences.mock.calls[0][5], "referencedBy");
});
