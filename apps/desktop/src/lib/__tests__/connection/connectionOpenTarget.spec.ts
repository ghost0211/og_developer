import { describe, expect, it } from "vitest";
import { quickConnectionOpenTarget } from "@/lib/connection/connectionOpenTarget";
import type { ConnectionConfig } from "@/types/database";

function connection(dbType: ConnectionConfig["db_type"]): ConnectionConfig {
  return {
    id: "conn",
    name: "conn",
    db_type: dbType,
    host: "127.0.0.1",
    port: 0,
    user: "",
    password: "",
    database: "",
    readonly: false,
    read_only: false,
    ssl_mode: "disabled",
    color: "#888",
  } as ConnectionConfig;
}

describe("quickConnectionOpenTarget", () => {
  it("opens connections in a query tab on the configured database", () => {
    expect(quickConnectionOpenTarget({ ...connection("postgres"), database: "app" })).toEqual({
      kind: "query",
      database: "app",
    });
  });

  it("falls back to the default openGauss database", () => {
    expect(quickConnectionOpenTarget(connection("opengauss"))).toEqual({
      kind: "query",
      database: "postgres",
    });
  });
});
