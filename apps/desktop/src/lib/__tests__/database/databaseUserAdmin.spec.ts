import { describe, expect, it } from "vitest";
import { getDatabaseUserAdminProvider } from "@/lib/database/databaseUserAdmin";

describe("database user admin providers", () => {
  it("resolves the shared Postgres provider for postgres and openGauss", () => {
    const postgresProvider = getDatabaseUserAdminProvider("postgres");
    const opengaussProvider = getDatabaseUserAdminProvider("opengauss");

    expect(postgresProvider).not.toBeNull();
    expect(opengaussProvider).toBe(postgresProvider);
    expect(postgresProvider?.dialect).toBe("postgres");
    expect(postgresProvider?.defaultScope).toBe("database");
    expect(postgresProvider?.privilegeSelectionFromGrants).toBeUndefined();
    expect(postgresProvider?.defaultPrivilegesForScope?.("database")).toEqual(["CONNECT"]);
    expect(postgresProvider?.defaultPrivilegesForScope?.("schema")).toEqual(["USAGE"]);
  });

  it("uses pg_catalog for role metadata", () => {
    const provider = getDatabaseUserAdminProvider("postgres");

    expect(provider?.listUsersSql()).toContain("FROM pg_catalog.pg_roles r");
    expect(provider?.showGrantsSql({ user: "role'o", host: "LOGIN" })).toContain("WHERE r.rolname = 'role''o'");
  });

  it("has no provider for generic JDBC connections", () => {
    expect(getDatabaseUserAdminProvider("jdbc")).toBeNull();
    expect(getDatabaseUserAdminProvider(undefined)).toBeNull();
  });
});
