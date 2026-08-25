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
  listOpengaussPackageSubprograms: vi.fn(),
  getConfig: vi.fn(),
  listDatabases: vi.fn(),
  listSchemas: vi.fn(),
}));

vi.mock("../../apps/desktop/src/lib/backend/api", () => apiMock);

beforeEach(() => {
  setActivePinia(createPinia());
  restoreLocalStorage = installMemoryStorage();
  apiMock.listObjectReferences.mockReset();
  apiMock.listOpengaussPackageSubprograms.mockReset();
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
  // @ts-expect-error store internals
  store.connectedIds = new Set(["conn"]);
  apiMock.listObjectReferences.mockResolvedValue([{ schema: "public", name: "mv_emp", objectType: "materialized_view", detail: "view definition" }]);
  apiMock.listDatabases.mockResolvedValue([]);
  apiMock.listSchemas.mockResolvedValue([]);

  await store.loadReferenceGroupChildren(refNode);

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

test("package and package body nodes expose their own reference groups", async () => {
  const store = useConnectionStore();
  store.connections = [{ id: "conn", name: "conn", db_type: "opengauss", host: "h", port: 1, username: "u", password: "" } as ConnectionConfig];
  // @ts-expect-error store internals
  store.connectedIds = new Set(["conn"]);
  apiMock.listOpengaussPackageSubprograms.mockResolvedValue([]);

  for (const nodeType of ["package", "package-body"] as const) {
    const packageNode: TreeNode = {
      id: `conn:db:public:ref_pkg:${nodeType}`,
      label: "ref_pkg",
      objectName: "ref_pkg",
      type: nodeType,
      connectionId: "conn",
      database: "db",
      schema: "public",
      isExpanded: false,
      children: [],
    };
    // @ts-expect-error store internals
    store.treeNodes = [packageNode];

    await store.loadOpengaussPackageSubprograms("conn", "db", "ref_pkg", "public", packageNode.id);

    const livePackage = store.treeNodes[0]!;
    assert.deepEqual(
      livePackage.children?.map((child) => [child.type, child.referenceObjectType, child.objectName]),
      [
        ["group-references", nodeType === "package-body" ? "package_body" : "package", "ref_pkg"],
        ["group-referenced-by", nodeType === "package-body" ? "package_body" : "package", "ref_pkg"],
      ],
    );
  }
});

test("routine references and package references render correctly with appropriate node types", async () => {
  const store = useConnectionStore();
  const procRefNode: TreeNode = {
    id: "conn:db:public:ogtest_proc:__references",
    label: "tree.references",
    type: "group-references",
    referenceDirection: "references",
    referenceObjectType: "procedure",
    objectName: "ogtest_proc",
    connectionId: "conn",
    database: "db",
    schema: "public",
    isExpanded: false,
    children: [],
  };

  // @ts-expect-error store internals
  store.treeNodes = [{ id: "conn", type: "connection", connectionId: "conn", label: "conn", children: [procRefNode] }];
  // @ts-expect-error store internals
  store.configs = new Map([["conn", { id: "conn", name: "conn", db_type: "opengauss", host: "h", port: 1, username: "u", password: "" }]]);
  // @ts-expect-error store internals
  store.connectedIds = new Set(["conn"]);

  apiMock.listObjectReferences.mockResolvedValue([
    { schema: "public", name: "ogdev_emp", objectType: "table", detail: "表/视图操作" },
    { schema: "pkg_service", name: "gms_output", objectType: "package", detail: "包引用" },
    { schema: "public", name: "calc_tax", objectType: "function", detail: "例程调用" },
  ]);

  await store.loadReferenceGroupChildren(procRefNode);

  // @ts-expect-error store internals
  const live = store.treeNodes[0].children[0];
  assert.equal(live.children?.length, 3);
  assert.equal(live.children?.[0].type, "table");
  assert.equal(live.children?.[0].label, "public.ogdev_emp (表/视图操作)");
  assert.equal(live.children?.[1].type, "package");
  assert.equal(live.children?.[1].label, "pkg_service.gms_output (包引用)");
  assert.equal(live.children?.[2].type, "function");
  assert.equal(live.children?.[2].label, "public.calc_tax (例程调用)");
});
