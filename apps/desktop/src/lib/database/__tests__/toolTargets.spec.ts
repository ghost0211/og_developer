import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { connectionSupportsTool, pickToolConnection, toolConnections } from "@/lib/database/toolTargets";

function connection(id: string, dbType: ConnectionConfig["db_type"], extra: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { id, name: id, db_type: dbType, host: "localhost", port: 0, username: "u", password: "", ...extra } as ConnectionConfig;
}

const connections = [connection("pg", "postgres"), connection("og", "opengauss"), connection("og-jdbc", "jdbc", { driver_profile: "opengauss-jdbc" }), connection("mysql", "mysql"), connection("sqlite", "sqlite")];

describe("toolTargets", () => {
  it("filters process-list connections by driver availability", () => {
    const ids = toolConnections(connections, "processlist").map((c) => c.id);
    expect(ids).toContain("pg");
    expect(ids).toContain("og");
    expect(ids).not.toContain("sqlite");
  });

  it("limits pg-stats tools to postgres and openGauss, including JDBC channels", () => {
    const ids = toolConnections(connections, "pg-stats").map((c) => c.id);
    expect(ids).toEqual(["pg", "og", "og-jdbc"]);
  });

  it("limits table import to drivers with the tableImport capability", () => {
    const ids = toolConnections(connections, "table-import").map((c) => c.id);
    expect(ids).toContain("pg");
    expect(ids).toContain("mysql");
    expect(ids).toContain("sqlite");
  });

  it("prefers the requested connection, then the active one, then the first eligible", () => {
    expect(pickToolConnection(connections, "pg-stats", ["og", "pg"])?.id).toBe("og");
    // An ineligible preferred id is skipped rather than silently accepted.
    expect(pickToolConnection(connections, "pg-stats", ["mysql", "og"])?.id).toBe("og");
    expect(pickToolConnection(connections, "pg-stats", [null, undefined])?.id).toBe("pg");
    expect(pickToolConnection([], "pg-stats", ["pg"])).toBeUndefined();
  });

  it("rejects missing connections", () => {
    expect(connectionSupportsTool(undefined, "sql")).toBe(false);
  });
});
