// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    executeQuery: vi.fn(),
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
    vi.mocked(api.executeQuery).mockReset();
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
