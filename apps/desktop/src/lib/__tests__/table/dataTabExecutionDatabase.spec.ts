import { describe, expect, it } from "vitest";
import { dataTabExecutionDatabase } from "@/lib/table/dataTabExecutionDatabase";
import type { ConnectionConfig } from "@/types/database";

function connection(overrides: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: "connection-1",
    name: "Test",
    db_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
    ...overrides,
  };
}

describe("dataTabExecutionDatabase", () => {
  it("keeps the tab database", () => {
    expect(dataTabExecutionDatabase(connection({ database: "configured" }), "app_db")).toBe("app_db");
    expect(dataTabExecutionDatabase(connection({ db_type: "opengauss" }), "app_db", "catalog_like_value")).toBe("app_db");
    expect(dataTabExecutionDatabase(undefined, "")).toBe("");
  });
});
