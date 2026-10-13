import { describe, expect, it } from "vitest";
import { treeNodeDataObjectName, treeNodeRenameObjectName } from "@/lib/sidebar/treeNodeContext";
import type { TreeNode } from "@/types/database";

describe("treeNodeDataObjectName", () => {
  it("prefers the real object name on reference-result nodes with schema-qualified labels", () => {
    // Synonym/function reference rows display "schema.name (detail)" as label.
    expect(treeNodeDataObjectName({ label: "auth.auth_user", tableName: "auth_user", objectName: "auth_user" })).toBe("auth_user");
    expect(treeNodeDataObjectName({ label: "app.def_user (FOR dbo.def_user)", tableName: "def_user" })).toBe("def_user");
  });

  it("falls back to objectName then label for plain object nodes", () => {
    expect(treeNodeDataObjectName({ label: "users", objectName: "users" })).toBe("users");
    expect(treeNodeDataObjectName({ label: "users" })).toBe("users");
    expect(treeNodeDataObjectName({ label: "users", tableName: "  " })).toBe("users");
  });
});

describe("treeNodeRenameObjectName", () => {
  it("uses the real database and schema identity instead of display labels", () => {
    expect(treeNodeRenameObjectName({ label: "默认数据库", type: "database", database: "app" } as TreeNode)).toBe("app");
    expect(treeNodeRenameObjectName({ label: "默认数据库", type: "database", database: "" } as TreeNode)).toBe("默认数据库");
    expect(treeNodeRenameObjectName({ label: "app", type: "schema", schema: "app" } as TreeNode)).toBe("app");
  });

  it("never falls back to the parent table for table children", () => {
    expect(treeNodeRenameObjectName({ label: "old_col (integer)", type: "column", tableName: "users", meta: { name: "old_col" } as unknown as TreeNode["meta"] } as TreeNode)).toBe("old_col");
    expect(treeNodeRenameObjectName({ label: "idx_users (id)", type: "index", tableName: "users", meta: { name: "idx_users" } as unknown as TreeNode["meta"] } as TreeNode)).toBe("idx_users");
    expect(treeNodeRenameObjectName({ label: "users_org_fkey (u→o)", type: "fkey", tableName: "users", meta: { name: "users_org_fkey" } as unknown as TreeNode["meta"] } as TreeNode)).toBe("users_org_fkey");
    expect(treeNodeRenameObjectName({ label: "users_audit (audit)", type: "trigger", tableName: "users", objectName: "users_audit" } as TreeNode)).toBe("users_audit");
  });

  it("uses objectName for routines and plain objects", () => {
    expect(treeNodeRenameObjectName({ label: "f(integer)", objectName: "f", type: "function" } as TreeNode)).toBe("f");
    expect(treeNodeRenameObjectName({ label: "app.users", objectName: "users", type: "table" } as TreeNode)).toBe("users");
  });
});
