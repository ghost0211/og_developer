import { describe, expect, it } from "vitest";
import { postgresUserAdminProvider } from "@/lib/database/databaseUserAdmin";
import { authorizationPlanSql, buildCreateDatabaseAuthorizationPlan, buildCreateUserAuthorizationPlan, executeAuthorizationPlan } from "@/lib/database/databaseAuthorizationPlan";

describe("database authorization plans", () => {
  it("grants PostgreSQL presets across user schemas and future objects", () => {
    const plan = buildCreateUserAuthorizationPlan({
      provider: postgresUserAdminProvider,
      principal: { user: "app_user", host: "LOGIN", password: "secret", canLogin: true },
      accountType: "standard",
      databases: [
        {
          database: "app_db",
          preset: "readWrite",
          schemas: ["public", "app", "pg_catalog", "information_schema", "SYS_CATALOG"],
        },
      ],
    });
    const sql = authorizationPlanSql(plan);

    expect(sql).toContain('GRANT USAGE, CREATE ON SCHEMA "public" TO "app_user";');
    expect(sql).toContain('GRANT USAGE, CREATE ON SCHEMA "app" TO "app_user";');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA "app" TO "app_user";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO "app_user";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES GRANT USAGE, CREATE ON SCHEMAS TO "app_user";');
    expect(sql).toContain('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "app" TO "app_user";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO "app_user";');
    expect(sql).not.toContain('SCHEMA "pg_catalog"');
    expect(sql).not.toContain('SCHEMA "information_schema"');
    expect(sql).not.toContain('SCHEMA "SYS_CATALOG"');
  });

  it("includes current and future PostgreSQL object grants after database creation", () => {
    const plan = buildCreateDatabaseAuthorizationPlan({
      provider: postgresUserAdminProvider,
      database: "app_db",
      createSql: 'CREATE DATABASE "app_db";',
      users: [{ user: "app_user", host: "LOGIN" }],
    });
    const sql = authorizationPlanSql(plan);

    expect(sql).toContain('GRANT ALL PRIVILEGES ON DATABASE "app_db" TO "app_user";');
    expect(sql).toContain('GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA "public" TO "app_user";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES GRANT ALL PRIVILEGES ON SCHEMAS TO "app_user";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES GRANT ALL PRIVILEGES ON TABLES TO "app_user";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES GRANT ALL PRIVILEGES ON SEQUENCES TO "app_user";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES GRANT ALL PRIVILEGES ON FUNCTIONS TO "app_user";');
  });

  it("cross-grants future PostgreSQL schemas and objects between linked users", () => {
    const plan = buildCreateDatabaseAuthorizationPlan({
      provider: postgresUserAdminProvider,
      database: "app_db",
      createSql: 'CREATE DATABASE "app_db";',
      users: [
        { user: "alice", host: "LOGIN" },
        { user: "bob", host: "LOGIN" },
      ],
    });
    const sql = authorizationPlanSql(plan);

    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "alice" GRANT ALL PRIVILEGES ON SCHEMAS TO "bob";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "alice" GRANT ALL PRIVILEGES ON TABLES TO "bob";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "bob" GRANT ALL PRIVILEGES ON SEQUENCES TO "alice";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "bob" GRANT ALL PRIVILEGES ON FUNCTIONS TO "alice";');
    expect(plan.steps.every((step) => !step.sql.includes("\n"))).toBe(true);
  });

  it("keeps PostgreSQL read-only sequence access non-mutating", () => {
    const plan = buildCreateUserAuthorizationPlan({
      provider: postgresUserAdminProvider,
      principal: { user: "reader", host: "LOGIN", password: "secret", canLogin: true },
      accountType: "standard",
      databases: [{ database: "app_db", preset: "readOnly", schemas: ["app"] }],
    });
    const sql = authorizationPlanSql(plan);

    expect(sql).toContain('GRANT SELECT ON ALL SEQUENCES IN SCHEMA "app" TO "reader";');
    expect(sql).not.toContain('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "app" TO "reader";');
  });

  it("keeps creation plans usable when authorization capabilities are unavailable", () => {
    const createOnlyProvider = { ...postgresUserAdminProvider, grantPrivilegesSql: undefined };
    const databasePlan = buildCreateDatabaseAuthorizationPlan({
      provider: createOnlyProvider,
      database: "app_db",
      createSql: 'CREATE DATABASE "app_db";',
      users: [{ user: "app", host: "LOGIN" }],
    });
    const unsupportedUserPlan = buildCreateUserAuthorizationPlan({
      provider: { ...createOnlyProvider, createUserSql: undefined },
      principal: { user: "app", host: "LOGIN", password: "secret" },
      accountType: "standard",
      databases: [{ database: "app_db", preset: "readOnly" }],
    });

    expect(databasePlan.steps.map((step) => step.operation)).toEqual(["createDatabase"]);
    expect(unsupportedUserPlan.steps).toEqual([]);
  });

  it("reports PostgreSQL object grants independently", async () => {
    const plan = buildCreateDatabaseAuthorizationPlan({
      provider: postgresUserAdminProvider,
      database: "app_db",
      createSql: 'CREATE DATABASE "app_db";',
      users: [{ user: "app_user", host: "LOGIN" }],
    });
    const results = await executeAuthorizationPlan(plan, async (step) => {
      if (step.operation === "grantCurrentObjects" && step.objectScope === "tables") {
        return [{ columns: ["error"], rows: [["table grant failed"]], affected_rows: 0, execution_time_ms: 0, execution_error: true }];
      }
      return [];
    });

    expect(results.find((result) => result.step.operation === "grantCurrentObjects" && result.step.objectScope === "tables")?.status).toBe("failed");
    expect(results.find((result) => result.step.operation === "grantCurrentObjects" && result.step.objectScope === "sequences")?.status).toBe("success");
  });

  it("skips dependent grants after a failed creation step", async () => {
    const plan = buildCreateDatabaseAuthorizationPlan({
      provider: postgresUserAdminProvider,
      database: "app_db",
      createSql: 'CREATE DATABASE "app_db";',
      users: [{ user: "app", host: "LOGIN" }],
    });
    const results = await executeAuthorizationPlan(plan, async (step) => {
      if (step.id === "create-database") throw new Error("create failed");
      return [];
    });

    expect(results[0]?.status).toBe("failed");
    expect(results.slice(1).every((result) => result.status === "skipped")).toBe(true);
  });
});
