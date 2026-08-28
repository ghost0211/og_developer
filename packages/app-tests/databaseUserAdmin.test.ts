import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  connectionSupportsDatabaseUserAdmin,
  dorisAlterUserPasswordSql,
  dorisGrantPrivilegesSql,
  dorisGrantsResult,
  dorisListUsersSql,
  dorisPrivilegeTargetSql,
  dorisRevokePrivilegesSql,
  dorisUsersResult,
  grantsFromQueryResult,
  getDatabaseUserAdminProvider,
  mysqlAlterUserAccountLockSql,
  mysqlAlterUserPasswordSql,
  mysqlCreateUserSql,
  mysqlDropUserSql,
  mysqlGrantPrivilegesSql,
  mysqlPrivilegeTargetSql,
  mysqlRevokePrivilegesSql,
  mysqlShowGrantsSql,
  mysqlUserAccount,
  normalizeMySqlPrivileges,
  postgresAlterRoleLoginSql,
  postgresAlterRolePasswordSql,
  postgresCreateRoleSql,
  postgresDropRoleSql,
  postgresGrantPrivilegesSql,
  postgresListRolesSql,
  postgresPrivilegeTargetSql,
  postgresRevokePrivilegesSql,
  postgresRoleLabel,
  postgresShowGrantsSql,
  quoteMySqlIdentifier,
  quoteMySqlString,
  quotePostgresIdentifier,
  resolveDatabaseUserAdminProviderForConnection,
  starrocksGrantPrivilegesSql,
  starrocksGrantsResult,
  starrocksListUsersSql,
  starrocksPrivilegeTargetSql,
  starrocksRevokePrivilegesSql,
  starrocksUsersResult,
  usersFromMySqlGranteeResult,
  usersFromMySqlUserResult,
  usersFromPostgresRolesResult,
} from "../../apps/desktop/src/lib/database/databaseUserAdmin.ts";
import type { ConnectionConfig, QueryResult } from "../../apps/desktop/src/types/database.ts";

function result(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return {
    columns,
    rows,
    affected_rows: 0,
    execution_time_ms: 1,
  };
}





test("extracts grants from show grants result", () => {
  assert.deepEqual(grantsFromQueryResult(result(["Grants for app@%"], [["GRANT SELECT ON `app`.* TO 'app'@'%'"], [null]])), ["GRANT SELECT ON `app`.* TO 'app'@'%'"]);
});

test("builds PostgreSQL role lifecycle SQL", () => {
  const role = { user: 'report"reader', host: "LOGIN" };

  assert.equal(quotePostgresIdentifier('report"reader'), '"report""reader"');
  assert.equal(postgresRoleLabel(role), 'report"reader');
  assert.equal(postgresCreateRoleSql({ ...role, password: "it'works", canLogin: true }), "CREATE ROLE \"report\"\"reader\" LOGIN PASSWORD 'it''works';");
  assert.equal(postgresCreateRoleSql({ ...role, password: "secret", canLogin: false }), 'CREATE ROLE "report""reader" NOLOGIN PASSWORD \'secret\';');
  assert.equal(postgresAlterRolePasswordSql(role, "next"), 'ALTER ROLE "report""reader" PASSWORD \'next\';');
  assert.equal(postgresAlterRoleLoginSql(role, false), 'ALTER ROLE "report""reader" NOLOGIN;');
  assert.equal(postgresAlterRoleLoginSql(role, true), 'ALTER ROLE "report""reader" LOGIN;');
  assert.equal(postgresDropRoleSql(role), 'DROP ROLE "report""reader";');
});

test("builds PostgreSQL privilege and membership SQL", () => {
  const user = { user: "reporter", host: "LOGIN" };

  assert.equal(postgresPrivilegeTargetSql({ scope: "database", database: "analytics" }), 'DATABASE "analytics"');
  assert.equal(postgresPrivilegeTargetSql({ scope: "schema", database: "mart" }), 'SCHEMA "mart"');
  assert.equal(postgresPrivilegeTargetSql({ scope: "table", database: "mart", table: 'daily"rollup' }), 'TABLE "mart"."daily""rollup"');
  assert.equal(postgresPrivilegeTargetSql({ scope: "table", database: "mart", table: "*" }), 'ALL TABLES IN SCHEMA "mart"');
  assert.equal(
    postgresGrantPrivilegesSql({
      user,
      scope: "database",
      database: "analytics",
      privileges: ["connect", "CREATE"],
      grantOption: true,
    }),
    'GRANT CONNECT, CREATE ON DATABASE "analytics" TO "reporter" WITH GRANT OPTION;',
  );
  assert.equal(postgresRevokePrivilegesSql({ user, scope: "schema", database: "mart", privileges: ["usage"] }), 'REVOKE USAGE ON SCHEMA "mart" FROM "reporter";');
  assert.equal(
    postgresGrantPrivilegesSql({
      user,
      scope: "role",
      database: "",
      privileges: [],
      role: "readonly",
      grantOption: true,
    }),
    'GRANT "readonly" TO "reporter" WITH ADMIN OPTION;',
  );
  assert.equal(postgresRevokePrivilegesSql({ user, scope: "role", database: "", privileges: [], role: "readonly" }), 'REVOKE "readonly" FROM "reporter";');
});

test("parses PostgreSQL role rows", () => {
  assert.deepEqual(
    usersFromPostgresRolesResult(
      result(
        ["user", "host", "plugin"],
        [
          ["postgres", "LOGIN", "SUPERUSER, CREATEDB"],
          ["readonly", "ROLE", ""],
        ],
      ),
    ),
    [
      { user: "postgres", host: "LOGIN", plugin: "SUPERUSER, CREATEDB" },
      { user: "readonly", host: "ROLE", plugin: "" },
    ],
  );
});

test("builds PostgreSQL role metadata SQL without directly requiring rolbypassrls", () => {
  const listSql = postgresListRolesSql();
  const grantsSql = postgresShowGrantsSql({ user: "reporter", host: "LOGIN" });

  assert.match(listSql, /row_to_json\(r\)::text LIKE '%"rolbypassrls":true%'/);
  assert.match(grantsSql, /row_to_json\(r\)::text LIKE '%"rolbypassrls":true%'/);
  assert.doesNotMatch(listSql, /r\.rolbypassrls/);
  assert.doesNotMatch(grantsSql, /r\.rolbypassrls/);
  assert.match(grantsSql, /AS rolbypassrls/);
  assert.match(grantsSql, /n\.nspname NOT LIKE 'pg~_%' ESCAPE '~'/);
  assert.ok(!grantsSql.includes("ESCAPE '\\'"));
});









