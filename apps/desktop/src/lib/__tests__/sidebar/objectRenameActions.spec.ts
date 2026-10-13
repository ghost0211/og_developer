import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { canRenameTreeNodeObject, executeObjectRename, renamedObjectTreeNode } from "@/lib/sidebar/objectRenameActions";
import { renameObjectTypeForTreeNode, supportsObjectRename } from "@/lib/table/objectRenameSql";
import type { ConnectionConfig, TreeNode } from "@/types/database";

vi.mock("@/lib/backend/api", () => ({ buildRenameObjectSql: vi.fn() }));
const connection = { id: "c", db_type: "opengauss" } as ConnectionConfig;
const node: TreeNode = { id: "referenced-users", label: "auth.users", objectName: "users", tableName: "users", type: "table", schema: "auth", connectionId: "c", database: "db" };
const buildSql = vi.mocked(api.buildRenameObjectSql);

function options(overrides: Partial<Parameters<typeof executeObjectRename>[0]> = {}) {
  return { node: { ...node }, newName: " archived users ", getConnection: () => connection, execute: vi.fn().mockResolvedValue({}), onExecuted: vi.fn(), ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  buildSql.mockResolvedValue('ALTER TABLE auth.users RENAME TO "archived users";');
});

describe("openGauss direct object rename", () => {
  it.each(["DATABASE", "SCHEMA", "TABLE", "VIEW", "MATERIALIZED_VIEW", "SEQUENCE", "TYPE", "FUNCTION", "PROCEDURE", "TRIGGER", "INDEX", "COLUMN", "CONSTRAINT"] as const)("enables direct %s renames on openGauss", (type) => {
    expect(supportsObjectRename("opengauss", type)).toBe(true);
  });

  it.each(["postgres", "opengauss"] as const)("supports the documented PostgreSQL-family renames for %s", (databaseType) => {
    expect(supportsObjectRename(databaseType, "DATABASE")).toBe(true);
    expect(supportsObjectRename(databaseType, "SEQUENCE")).toBe(true);
  });

  it("rejects rename on unsupported dialects", () => {
    expect(supportsObjectRename("jdbc", "TABLE")).toBe(false);
    expect(supportsObjectRename(undefined, "TABLE")).toBe(false);
  });

  it("uses actual relation identity rather than schema-qualified display labels", async () => {
    const opts = options();
    expect(await executeObjectRename(opts)).toBe(true);
    expect(buildSql).toHaveBeenCalledWith({
      databaseType: "opengauss",
      objectType: "TABLE",
      schema: "auth",
      oldName: "users",
      newName: "archived users",
      signature: undefined,
      tableName: undefined,
    });
    expect(opts.execute).toHaveBeenCalledWith('ALTER TABLE auth.users RENAME TO "archived users";', expect.objectContaining({ schema: "auth", objectName: "users" }));
    expect(opts.onExecuted).toHaveBeenCalledOnce();
    expect(opts.node.objectName).toBe("users");
  });

  it("passes routine signatures and table context for child objects", async () => {
    buildSql.mockResolvedValue("ALTER PROCEDURE app.p(integer[]) RENAME TO q;");
    const procedureNode: TreeNode = { id: "p", label: "p(integer[])", objectName: "p", type: "procedure", schema: "app", connectionId: "c", database: "db", signature: "integer[]" };
    await executeObjectRename(options({ node: procedureNode, newName: "q" }));
    expect(buildSql).toHaveBeenLastCalledWith(expect.objectContaining({ objectType: "PROCEDURE", signature: "integer[]", tableName: undefined }));

    buildSql.mockResolvedValue("ALTER TABLE app.users RENAME COLUMN old_col TO new_col;");
    const columnNode: TreeNode = { id: "col", label: "old_col (integer)", type: "column", schema: "app", connectionId: "c", database: "db", tableName: "users", meta: { name: "old_col" } as unknown as TreeNode["meta"] };
    await executeObjectRename(options({ node: columnNode, newName: "new_col" }));
    expect(buildSql).toHaveBeenLastCalledWith(expect.objectContaining({ objectType: "COLUMN", oldName: "old_col", tableName: "users" }));
  });

  it("does not enable table-child renames without a parent table", () => {
    const orphanColumn: TreeNode = { id: "col", label: "old_col (integer)", type: "column", schema: "app", connectionId: "c", database: "db", meta: { name: "old_col" } as unknown as TreeNode["meta"] };
    expect(canRenameTreeNodeObject(orphanColumn, connection)).toBe(false);
  });

  it("has no success, refresh or pin effects after a cancelled production guard", async () => {
    const opts = options({ execute: vi.fn().mockResolvedValue(undefined) });
    expect(await executeObjectRename(opts)).toBe(false);
    expect(opts.onExecuted).not.toHaveBeenCalled();
    expect(opts.node.label).toBe("auth.users");
  });

  it("propagates permission failures without reporting success", async () => {
    const opts = options({ execute: vi.fn().mockRejectedValue(new Error("permission denied")) });
    await expect(executeObjectRename(opts)).rejects.toThrow("permission denied");
    expect(opts.onExecuted).not.toHaveBeenCalled();
  });

  it("blocks read-only connections before building SQL", async () => {
    const opts = options({ getConnection: () => ({ ...connection, read_only: true }) });
    expect(await executeObjectRename(opts)).toBe(false);
    expect(buildSql).not.toHaveBeenCalled();
    expect(opts.execute).not.toHaveBeenCalled();
  });

  it("rechecks read-only state after asynchronous SQL preparation", async () => {
    let current = connection;
    buildSql.mockImplementation(async () => {
      current = { ...connection, read_only: true };
      return "ALTER TABLE auth.users RENAME TO archived_users;";
    });
    const opts = options({ getConnection: () => current });
    expect(await executeObjectRename(opts)).toBe(false);
    expect(opts.execute).not.toHaveBeenCalled();
    expect(opts.onExecuted).not.toHaveBeenCalled();
  });

  it("captures immutable identity if the live row is recycled while SQL is building", async () => {
    const opts = options();
    buildSql.mockImplementation(async () => {
      opts.node.schema = "other_schema";
      opts.node.objectName = "other_table";
      return "ALTER TABLE auth.users RENAME TO archived_users;";
    });
    expect(await executeObjectRename(opts)).toBe(true);
    const target = opts.execute.mock.calls[0][1];
    expect(target.schema).toBe("auth");
    expect(target.objectName).toBe("users");
    expect(Object.isFrozen(target)).toBe(true);
  });

  it.each(["", "users"])("skips blank or unchanged actual names: %s", async (newName) => {
    expect(await executeObjectRename(options({ newName }))).toBe(false);
    expect(buildSql).not.toHaveBeenCalled();
  });

  it("does not operate on a different connection configuration", async () => {
    const opts = options({ getConnection: () => ({ ...connection, id: "other" }) });
    expect(await executeObjectRename(opts)).toBe(false);
    expect(opts.execute).not.toHaveBeenCalled();
  });

  it("applies the renamed name to the correct node identity field", () => {
    const tableTarget = { ...node } as const;
    expect(renamedObjectTreeNode(tableTarget, "users_v2")).toMatchObject({ label: "users_v2", objectName: "users_v2", tableName: "users_v2" });

    const schemaNode: TreeNode = { id: "s", label: "app", type: "schema", schema: "app", connectionId: "c", database: "db" };
    expect(renamedObjectTreeNode(schemaNode, "app_v2")).toMatchObject({ label: "app_v2", schema: "app_v2" });

    const functionNode: TreeNode = { id: "f", label: "f(integer)", objectName: "f", type: "function", schema: "app", connectionId: "c", database: "db", signature: "integer" };
    expect(renamedObjectTreeNode(functionNode, "g")).toMatchObject({ label: "g(integer)", objectName: "g" });

    const columnNode: TreeNode = { id: "col", label: "old_col (integer)", type: "column", schema: "app", connectionId: "c", database: "db", tableName: "users", meta: { name: "old_col" } as unknown as TreeNode["meta"] };
    expect(renamedObjectTreeNode(columnNode, "new_col")).toMatchObject({ label: "new_col", tableName: "users", meta: { name: "new_col" } });
  });

  it("maps renameable tree node types and leaves unsupported objects unmapped", () => {
    expect(renameObjectTypeForTreeNode("database")).toBe("DATABASE");
    expect(renameObjectTypeForTreeNode("schema")).toBe("SCHEMA");
    expect(renameObjectTypeForTreeNode("sequence")).toBe("SEQUENCE");
    expect(renameObjectTypeForTreeNode("fkey")).toBe("CONSTRAINT");
    expect(renameObjectTypeForTreeNode("constraint")).toBe("CONSTRAINT");
    expect(renameObjectTypeForTreeNode("synonym")).toBeNull();
    expect(renameObjectTypeForTreeNode("package")).toBeNull();
    expect(renameObjectTypeForTreeNode("job")).toBeNull();
    expect(renameObjectTypeForTreeNode("type-body")).toBeNull();
  });
});
