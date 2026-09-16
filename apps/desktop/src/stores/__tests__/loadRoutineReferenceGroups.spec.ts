// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    executeQuery: vi.fn(),
    listObjectReferences: vi.fn(),
    getColumns: vi.fn(),
    listTypeAttributes: vi.fn(),
    resolveSynonymTarget: vi.fn(),
    listOpengaussPackageSubprograms: vi.fn(),
  };
});

import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ConnectionConfig, QueryResult, TreeNode } from "@/types/database";

const ogConfig = {
  id: "og-1",
  name: "og",
  db_type: "opengauss",
  driver_profile: "opengauss-jdbc",
  host: "127.0.0.1",
  port: 5432,
  username: "u",
  database: "db",
} as ConnectionConfig;

function procedureNode(overrides?: Partial<TreeNode>): TreeNode {
  return {
    id: "og-1:db:hr_app:test_proc:PROCEDURE",
    label: "test_proc",
    type: "procedure",
    objectName: "test_proc",
    connectionId: "og-1",
    database: "db",
    schema: "hr_app",
    isExpanded: false,
    ...overrides,
  };
}

const paramResult: QueryResult = {
  columns: ["name", "data_type", "mode", "ordinal", "has_default"],
  rows: [
    ["p_id", "integer", "IN", 1, false],
    ["p_out", "integer", "OUT", 2, false],
  ],
  row_count: 2,
  affected_rows: 0,
} as unknown as QueryResult;

describe("loadTreeNodeChildren → routine parameter expansion", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
  });

  it("expands a standalone procedure into parameter children", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(paramResult);
    const store = useConnectionStore();
    store.addEphemeralConnection(ogConfig);
    const node = procedureNode();
    store.treeNodes.push(node);

    await store.loadTreeNodeChildren(node);

    const live = store.treeNodes.find((n) => n.id === node.id)!;
    const labels = (live.children ?? []).map((c) => c.label);
    expect(labels.some((label) => label.includes("p_id"))).toBe(true);
    expect(labels.some((label) => label.includes("p_out"))).toBe(true);
  });

  it("queries package members with the pkg.member qualified name", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(paramResult);
    const store = useConnectionStore();
    store.addEphemeralConnection(ogConfig);
    const node = procedureNode({
      id: "og-1:db:hr_app:emp_pkg:raise_salary:PROCEDURE",
      label: "raise_salary",
      objectName: "raise_salary",
      parentName: "emp_pkg",
    });
    store.treeNodes.push(node);

    await store.loadTreeNodeChildren(node);

    const sql = vi.mocked(api.executeQuery).mock.calls[0]?.[2] ?? "";
    expect(sql).toContain("pkg.pkgname = 'emp_pkg'");
    expect(sql).toContain("p.proname = 'raise_salary'");
    const live = store.treeNodes.find((n) => n.id === node.id)!;
    expect((live.children ?? []).some((c) => c.label.includes("p_id"))).toBe(true);
  });
});

describe("reference results keep one dependency level", () => {
  const column = {
    name: "id",
    data_type: "integer",
    is_nullable: false,
    column_default: null,
    is_primary_key: true,
    extra: null,
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
    vi.mocked(api.executeQuery).mockResolvedValue(paramResult);
    vi.mocked(api.getColumns).mockResolvedValue([column]);
    vi.mocked(api.listTypeAttributes).mockResolvedValue([column]);
  });

  async function referenceResult(objectType: string, direction: "references" | "referencedBy" = "references") {
    const store = useConnectionStore();
    store.addEphemeralConnection(ogConfig);
    const root = procedureNode();
    store.treeNodes.push(root);
    await store.loadTreeNodeChildren(root);
    const liveRoot = store.treeNodes[0]!;
    expect(liveRoot.children?.filter((child) => child.referenceDirection).map((child) => child.referenceDirection)).toEqual(["references", "referencedBy"]);
    const group = liveRoot.children!.find((child) => child.referenceDirection === direction)!;
    vi.mocked(api.listObjectReferences).mockResolvedValue([{ schema: "hr_app", name: "test_proc", objectType, detail: "dependency detail" }]);
    await store.loadTreeNodeChildren(group);
    const result = group.children![0]!;
    expect(result.isReferenceResult).toBe(true);
    expect(result.label).toBe("hr_app.test_proc (dependency detail)");
    return { store, result };
  }

  function expectNoReferenceGroups(node: TreeNode) {
    expect(node.children?.some((child) => child.type === "group-references" || child.type === "group-referenced-by")).toBe(false);
    expect(api.listObjectReferences).toHaveBeenCalledTimes(1);
  }

  it.each([
    ["function", "references"],
    ["function", "referencedBy"],
    ["procedure", "references"],
    ["procedure", "referencedBy"],
  ] as const)("expands %s parameters under %s without offering a recursive dependency", async (type, direction) => {
    const { store, result } = await referenceResult(type, direction);
    await store.loadTreeNodeChildren(result);
    expect(result.children?.map((child) => child.type)).toEqual(["column", "column"]);
    expect(result.children?.[0]?.label).toContain("p_id: integer");
    expectNoReferenceGroups(result);
    // Re-expansion must not introduce groups through the existing-children cache.
    await store.loadTreeNodeChildren(result);
    expectNoReferenceGroups(result);
  });

  it.each(["table", "view", "materialized_view"])("loads %s columns using the object name instead of its decorated label", async (type) => {
    const { store, result } = await referenceResult(type);
    await store.loadTreeNodeChildren(result);
    const columns = result.children!.find((child) => child.type === "group-columns")!;
    await store.loadTreeNodeChildren(columns);
    expect(api.getColumns).toHaveBeenCalledWith("og-1", "db", "hr_app", "test_proc", undefined);
    expect(columns.children?.[0]?.meta).toEqual(column);
    expectNoReferenceGroups(result);
  });

  it("loads type attributes using the object name without further reference groups", async () => {
    const { store, result } = await referenceResult("type");
    await store.loadTreeNodeChildren(result);
    expect(api.listTypeAttributes).toHaveBeenCalledWith("og-1", "db", "hr_app", "test_proc");
    expect(result.children?.[0]?.meta).toEqual(column);
    expectNoReferenceGroups(result);
  });

  it("resolves synonym targets using the object name and retains their columns", async () => {
    vi.mocked(api.resolveSynonymTarget).mockResolvedValue({ targetSchema: "public", targetName: "actual_table", targetKind: "r" });
    const { store, result } = await referenceResult("synonym");
    await store.loadTreeNodeChildren(result);
    expect(api.resolveSynonymTarget).toHaveBeenCalledWith("og-1", "db", "hr_app", "test_proc");
    const columns = result.children!.find((child) => child.type === "group-columns")!;
    await store.loadTreeNodeChildren(columns);
    expect(api.getColumns).toHaveBeenCalledWith("og-1", "db", "public", "actual_table", undefined);
    expectNoReferenceGroups(result);
  });

  it.each(["package", "package_body"])("keeps %s members in the same reference-result context", async (type) => {
    vi.mocked(api.listOpengaussPackageSubprograms).mockResolvedValue([{ name: "member", functionType: "PROCEDURE", dataType: "void", definition: "", arguments: "p_id integer" }]);
    const { store, result } = await referenceResult(type);
    await store.loadTreeNodeChildren(result);
    expectNoReferenceGroups(result);
    const member = result.children![0]!;
    expect(member.isReferenceResult).toBe(true);
    await store.loadTreeNodeChildren(member);
    expect(member.children?.map((child) => child.type)).toEqual(["column", "column"]);
    expectNoReferenceGroups(member);
  });

  it("keeps referenced sequences as leaves", async () => {
    const { store, result } = await referenceResult("sequence");
    await store.loadTreeNodeChildren(result);
    expect(result.children).toEqual([]);
    expectNoReferenceGroups(result);
  });
});
