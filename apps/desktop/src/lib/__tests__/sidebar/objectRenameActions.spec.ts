import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { executeObjectRename } from "@/lib/sidebar/objectRenameActions";
import { supportsObjectRename } from "@/lib/table/objectRenameSql";
import { supportsSourceBackedRoutineRename } from "@/lib/table/objectSourceEditor";
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
  it.each(["TABLE", "VIEW", "MATERIALIZED_VIEW"] as const)("enables only direct %s renames", (type) => {
    expect(supportsObjectRename("opengauss", type)).toBe(true);
  });
  it.each(["FUNCTION", "PROCEDURE"] as const)("does not enable destructive source rebuilds for %s", (type) => {
    expect(supportsObjectRename("opengauss", type)).toBe(false);
    expect(supportsSourceBackedRoutineRename("opengauss", type)).toBe(false);
  });
  it("uses actual relation identity rather than schema-qualified display labels", async () => {
    const opts = options();
    expect(await executeObjectRename(opts)).toBe(true);
    expect(buildSql).toHaveBeenCalledWith({ databaseType: "opengauss", objectType: "TABLE", schema: "auth", oldName: "users", newName: "archived users" });
    expect(opts.execute).toHaveBeenCalledWith('ALTER TABLE auth.users RENAME TO "archived users";', expect.objectContaining({ schema: "auth", objectName: "users" }));
    expect(opts.onExecuted).toHaveBeenCalledOnce();
    expect(opts.node.objectName).toBe("users");
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
});
