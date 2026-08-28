import { describe, expect, it } from "vitest";
import { filterSchemaNamesForConnection, filterSchemaNamesForVisiblePicker, isSystemSchemaName } from "@/lib/database/visibleDatabases";

describe("visibleDatabases schema filtering", () => {
  it("hides openGauss system schemas and prefixes while keeping user schemas", () => {
    expect(filterSchemaNamesForVisiblePicker(["blockchain", "cstore", "db4ai", "dbe_perf", "dbe_pldeveloper", "dbe_sql_util", "information_schema", "pg_catalog", "public", "snapshot", "sqladvisor", "xmltype"], { db_type: "opengauss", username: "app_user" })).toEqual(["public"]);
  });

  it("hides PostgreSQL system schemas by default", () => {
    expect(filterSchemaNamesForVisiblePicker(["information_schema", "pg_catalog", "pg_toast", "public", "app_schema"], { db_type: "postgres", username: "app_user" })).toEqual(["public", "app_schema"]);
  });

  it("keeps all schemas visible when show-system-schemas is enabled", () => {
    expect(filterSchemaNamesForConnection(["blockchain", "db4ai", "public", "test2", "xmltype"], { db_type: "opengauss", show_system_schemas: true }, "postgres")).toEqual(["blockchain", "db4ai", "public", "test2", "xmltype"]);
  });

  it("respects explicit visible schema configuration after default filtering", () => {
    expect(
      filterSchemaNamesForConnection(
        ["public", "reporting", "analytics"],
        {
          db_type: "opengauss",
          visible_schemas: { test: ["reporting"] },
        },
        "test",
      ),
    ).toEqual(["reporting"]);
  });

  it("matches prefix-based system schema rules", () => {
    expect(isSystemSchemaName("opengauss", "dbe_pldeveloper")).toBe(true);
    expect(isSystemSchemaName("opengauss", "dbe_perf")).toBe(true);
    expect(isSystemSchemaName("opengauss", "public")).toBe(false);
    expect(isSystemSchemaName("postgres", "pg_catalog")).toBe(true);
    expect(isSystemSchemaName("postgres", "public")).toBe(false);
  });
});
