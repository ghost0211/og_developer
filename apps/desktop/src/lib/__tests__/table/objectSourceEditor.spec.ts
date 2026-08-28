import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { executeObjectSourceSave, formatObjectSourceSaveError } from "@/lib/table/objectSourceEditor";

vi.mock("@/lib/backend/api", () => ({
  executeInTransaction: vi.fn().mockResolvedValue({}),
  executeQuery: vi.fn().mockResolvedValue({}),
  executeScript: vi.fn().mockResolvedValue({}),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeObjectSourceSave", () => {
  it("executes source save statements sequentially", async () => {
    await executeObjectSourceSave("conn-1", "app", "opengauss", ["CREATE OR REPLACE VIEW v AS SELECT 1", "", "COMMENT ON VIEW v IS 'test'"], "public");

    expect(api.executeQuery).toHaveBeenCalledTimes(2);
    expect(api.executeQuery).toHaveBeenNthCalledWith(1, "conn-1", "app", "CREATE OR REPLACE VIEW v AS SELECT 1", "public");
    expect(api.executeQuery).toHaveBeenNthCalledWith(2, "conn-1", "app", "COMMENT ON VIEW v IS 'test'", "public");
  });
});

describe("formatObjectSourceSaveError", () => {
  const hint = "Keep existing view columns unchanged and append new columns at the end.";

  it.each(["ERROR: cannot drop columns from view", 'ERROR: cannot change name of view column "old_name" to "new_name"', 'ERROR: cannot change data type of view column "amount" from integer to bigint', "ERROR: ビューからは列を削除できません", "错误：无法从视图中删除列"])(
    "appends guidance for PostgreSQL/openGauss view column replacement errors: %s",
    (message) => {
      expect(formatObjectSourceSaveError(new Error(message), "postgres", "VIEW", hint)).toBe(`${message}\n\n${hint}`);
      expect(formatObjectSourceSaveError(new Error(message), "opengauss", "VIEW", hint)).toBe(`${message}\n\n${hint}`);
    },
  );

  it("leaves unrelated errors unchanged", () => {
    expect(formatObjectSourceSaveError(new Error("syntax error at or near SELECT"), "postgres", "VIEW", hint)).toBe("syntax error at or near SELECT");
    expect(formatObjectSourceSaveError(new Error("SQLSTATE 42P16"), "postgres", "PROCEDURE", hint)).toBe("SQLSTATE 42P16");
  });

  it.each(["Agent RPC error: SQLSTATE 42P16", "ERROR: ON COMMIT can only be used on temporary tables (SQLSTATE 42P16)"])("does not treat unrelated invalid_table_definition errors as view column changes: %s", (message) => {
    expect(formatObjectSourceSaveError(new Error(message), "postgres", "VIEW", hint)).toBe(message);
  });

  it("does not append the same guidance twice", () => {
    const formatted = formatObjectSourceSaveError("ERROR: cannot drop columns from view", "postgres", "VIEW", hint);
    expect(formatObjectSourceSaveError(formatted, "postgres", "VIEW", hint)).toBe(formatted);
  });
});
