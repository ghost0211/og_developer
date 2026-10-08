import { describe, expect, it } from "vitest";
import { treeNodeDataObjectName } from "@/lib/sidebar/treeNodeContext";

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
