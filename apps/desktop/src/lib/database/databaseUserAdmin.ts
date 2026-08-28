import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
import { supportsDatabaseFeature } from "@/lib/database/databaseDriverManifest";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

export type UserAdminDialect = "postgres";
export type PrivilegeScope = "database" | "schema" | "table" | "role";

export interface DatabaseUserIdentity {
  user: string;
  host: string;
  plugin?: string;
}

export interface CreatePrincipalInput extends DatabaseUserIdentity {
  password: string;
  canLogin?: boolean;
}

export interface PrivilegeChangeInput {
  user: DatabaseUserIdentity;
  privileges: string[];
  database: string;
  table?: string;
  grantOption?: boolean;
  scope?: PrivilegeScope;
  role?: string;
}

export interface PrivilegeSelectionInput {
  grants: readonly string[];
  database: string;
  table?: string;
  availablePrivileges: readonly string[];
}

export interface PrivilegeSelection {
  privileges: string[];
  grantOption: boolean;
}

export interface DatabaseUserAdminProvider {
  dialect: UserAdminDialect;
  defaultScope: PrivilegeScope;
  listUsersSql(): string;
  fallbackListUsersSql?: () => string;
  parseUsers(result: QueryResult): DatabaseUserIdentity[];
  parseFallbackUsers?: (result: QueryResult) => DatabaseUserIdentity[];
  showGrantsSql(user: DatabaseUserIdentity): string;
  parseGrants?(result: QueryResult): string[];
  createUserSql?(input: CreatePrincipalInput): string;
  alterPasswordSql?(user: DatabaseUserIdentity, password: string): string;
  alterLoginSql?(user: DatabaseUserIdentity, enabled: boolean): string;
  dropUserSql?(user: DatabaseUserIdentity): string;
  grantPrivilegesSql?(input: PrivilegeChangeInput): string;
  revokePrivilegesSql?(input: PrivilegeChangeInput): string;
  label(user: DatabaseUserIdentity): string;
  detail(user: DatabaseUserIdentity): string | undefined;
  privilegesForScope?(scope: PrivilegeScope): readonly string[];
  defaultPrivilegesForScope?(scope: PrivilegeScope): string[];
  privilegeSelectionFromGrants?(input: PrivilegeSelectionInput): PrivilegeSelection;
}

export const POSTGRES_USER_ADMIN_TYPES = new Set<DatabaseType>(["postgres", "opengauss"]);

export const POSTGRES_DATABASE_PRIVILEGES = ["CONNECT", "CREATE", "TEMPORARY"] as const;
export const POSTGRES_SCHEMA_PRIVILEGES = ["USAGE", "CREATE"] as const;
export const POSTGRES_TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

export function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quotePostgresIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function postgresRoleLabel(user: DatabaseUserIdentity): string {
  return user.user;
}

export function postgresListRolesSql(): string {
  const bypassRls = postgresRoleBypassRlsSql("r");
  return `
SELECT
  r.rolname AS user,
  CASE WHEN r.rolcanlogin THEN 'LOGIN' ELSE 'ROLE' END AS host,
  concat_ws(', ',
    CASE WHEN r.rolsuper THEN 'SUPERUSER' END,
    CASE WHEN r.rolcreatedb THEN 'CREATEDB' END,
    CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN r.rolreplication THEN 'REPLICATION' END,
    CASE WHEN ${bypassRls} THEN 'BYPASSRLS' END
  ) AS plugin
FROM pg_catalog.pg_roles r
ORDER BY r.rolname;`.trim();
}

export function usersFromPostgresRolesResult(result: QueryResult): DatabaseUserIdentity[] {
  const userIndex = columnIndex(result, "user", "User");
  const hostIndex = columnIndex(result, "host", "Host");
  const pluginIndex = columnIndex(result, "plugin", "Plugin");
  if (userIndex < 0 || hostIndex < 0) return [];
  return result.rows
    .map((row) => ({
      user: String(row[userIndex] ?? ""),
      host: String(row[hostIndex] ?? ""),
      plugin: pluginIndex >= 0 && row[pluginIndex] != null ? String(row[pluginIndex]) : undefined,
    }))
    .filter((user) => user.user || user.host);
}

export function postgresShowGrantsSql(user: DatabaseUserIdentity): string {
  const role = quoteSqlString(user.user);
  const bypassRls = postgresRoleBypassRlsSql("r");
  return `
WITH target AS (
  SELECT oid, rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, ${bypassRls} AS rolbypassrls
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = ${role}
)
SELECT line
FROM (
  SELECT 1 AS sort, 'Role: ' || quote_ident(rolname) AS line
  FROM target
  UNION ALL
  SELECT 2, 'Attributes: ' || COALESCE(NULLIF(concat_ws(', ',
    CASE WHEN rolsuper THEN 'SUPERUSER' END,
    CASE WHEN rolcreatedb THEN 'CREATEDB' END,
    CASE WHEN rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN rolcanlogin THEN 'LOGIN' ELSE 'NOLOGIN' END,
    CASE WHEN rolreplication THEN 'REPLICATION' END,
    CASE WHEN rolbypassrls THEN 'BYPASSRLS' END
  ), ''), 'none')
  FROM target
  UNION ALL
  SELECT 10, 'Member of: ' || quote_ident(parent.rolname) || CASE WHEN m.admin_option THEN ' WITH ADMIN OPTION' ELSE '' END
  FROM pg_catalog.pg_auth_members m
  JOIN target t ON t.oid = m.member
  JOIN pg_catalog.pg_roles parent ON parent.oid = m.roleid
  UNION ALL
  SELECT 20, 'Has member: ' || quote_ident(member.rolname) || CASE WHEN m.admin_option THEN ' WITH ADMIN OPTION' ELSE '' END
  FROM pg_catalog.pg_auth_members m
  JOIN target t ON t.oid = m.roleid
  JOIN pg_catalog.pg_roles member ON member.oid = m.member
  UNION ALL
  SELECT 30, 'Database: ' || quote_ident(d.datname) || ' = ' ||
    concat_ws(', ',
      CASE WHEN has_database_privilege(t.rolname, d.oid, 'CONNECT') THEN 'CONNECT' END,
      CASE WHEN has_database_privilege(t.rolname, d.oid, 'CREATE') THEN 'CREATE' END,
      CASE WHEN has_database_privilege(t.rolname, d.oid, 'TEMPORARY') THEN 'TEMPORARY' END
    )
  FROM target t
  CROSS JOIN pg_catalog.pg_database d
  WHERE has_database_privilege(t.rolname, d.oid, 'CONNECT')
     OR has_database_privilege(t.rolname, d.oid, 'CREATE')
     OR has_database_privilege(t.rolname, d.oid, 'TEMPORARY')
  UNION ALL
  SELECT 40, 'Schema: ' || quote_ident(n.nspname) || ' = ' ||
    concat_ws(', ',
      CASE WHEN has_schema_privilege(t.rolname, n.oid, 'USAGE') THEN 'USAGE' END,
      CASE WHEN has_schema_privilege(t.rolname, n.oid, 'CREATE') THEN 'CREATE' END
    )
  FROM target t
  CROSS JOIN pg_catalog.pg_namespace n
  WHERE n.nspname NOT LIKE 'pg~_%' ESCAPE '~'
    AND n.nspname <> 'information_schema'
    AND (has_schema_privilege(t.rolname, n.oid, 'USAGE') OR has_schema_privilege(t.rolname, n.oid, 'CREATE'))
  UNION ALL
  SELECT 50, 'Table: ' || quote_ident(table_schema) || '.' || quote_ident(table_name) || ' = ' ||
    string_agg(privilege_type || CASE WHEN is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END, ', ' ORDER BY privilege_type)
  FROM information_schema.role_table_grants
  WHERE grantee = ${role}
  GROUP BY table_schema, table_name
) grants
ORDER BY sort, line;`.trim();
}

export function postgresCreateRoleSql(input: CreatePrincipalInput): string {
  const login = input.canLogin === false ? "NOLOGIN" : "LOGIN";
  return `CREATE ROLE ${quotePostgresIdentifier(input.user)} ${login} PASSWORD ${quoteSqlString(input.password)};`;
}

export function postgresAlterRolePasswordSql(user: DatabaseUserIdentity, password: string): string {
  return `ALTER ROLE ${quotePostgresIdentifier(user.user)} PASSWORD ${quoteSqlString(password)};`;
}

export function postgresAlterRoleLoginSql(user: DatabaseUserIdentity, enabled: boolean): string {
  return `ALTER ROLE ${quotePostgresIdentifier(user.user)} ${enabled ? "LOGIN" : "NOLOGIN"};`;
}

export function postgresDropRoleSql(user: DatabaseUserIdentity): string {
  return `DROP ROLE ${quotePostgresIdentifier(user.user)};`;
}

export function postgresPrivilegeTargetSql(input: Pick<PrivilegeChangeInput, "scope" | "database" | "table">): string {
  const scope = input.scope || "database";
  const name = input.database.trim();
  if (scope === "database") return `DATABASE ${quotePostgresIdentifier(name || "postgres")}`;
  if (scope === "schema") return `SCHEMA ${quotePostgresIdentifier(name || "public")}`;
  const schema = name || "public";
  const table = input.table?.trim() || "*";
  if (table === "*") return `ALL TABLES IN SCHEMA ${quotePostgresIdentifier(schema)}`;
  return `TABLE ${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}`;
}

export function postgresGrantPrivilegesSql(input: PrivilegeChangeInput): string {
  if (input.scope === "role") {
    return `GRANT ${quotePostgresIdentifier(input.role?.trim() || "")} TO ${quotePostgresIdentifier(input.user.user)}${input.grantOption ? " WITH ADMIN OPTION" : ""};`;
  }
  const privileges = normalizePrivileges(input.privileges, postgresDefaultPrivilege(input.scope)).join(", ");
  return `GRANT ${privileges} ON ${postgresPrivilegeTargetSql(input)} TO ${quotePostgresIdentifier(input.user.user)}${input.grantOption ? " WITH GRANT OPTION" : ""};`;
}

export function postgresRevokePrivilegesSql(input: PrivilegeChangeInput): string {
  if (input.scope === "role") {
    return `REVOKE ${quotePostgresIdentifier(input.role?.trim() || "")} FROM ${quotePostgresIdentifier(input.user.user)};`;
  }
  const privileges = normalizePrivileges(input.privileges, postgresDefaultPrivilege(input.scope)).join(", ");
  return `REVOKE ${privileges} ON ${postgresPrivilegeTargetSql(input)} FROM ${quotePostgresIdentifier(input.user.user)};`;
}

export function grantsFromQueryResult(result: QueryResult): string[] {
  return result.rows.map((row) => String(row[0] ?? "")).filter(Boolean);
}

export function normalizePrivileges(privileges: string[], fallback = "SELECT"): string[] {
  const normalized = privileges.map((privilege) => privilege.trim().toUpperCase()).filter(Boolean);
  return Array.from(new Set(normalized.length > 0 ? normalized : [fallback]));
}

function columnIndex(result: QueryResult, ...names: string[]): number {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return result.columns.findIndex((column) => wanted.has(column.toLowerCase()));
}

function postgresDefaultPrivilege(scope: PrivilegeScope | undefined): string {
  if (scope === "schema") return "USAGE";
  if (scope === "database") return "CONNECT";
  return "SELECT";
}

function postgresPrivilegesForScope(scope: PrivilegeScope): readonly string[] {
  if (scope === "database") return POSTGRES_DATABASE_PRIVILEGES;
  if (scope === "schema") return POSTGRES_SCHEMA_PRIVILEGES;
  if (scope === "table") return POSTGRES_TABLE_PRIVILEGES;
  return [];
}

function postgresRoleBypassRlsSql(alias: string): string {
  return `row_to_json(${alias})::text LIKE '%"rolbypassrls":true%'`;
}

export const postgresUserAdminProvider: DatabaseUserAdminProvider = {
  dialect: "postgres",
  defaultScope: "database",
  listUsersSql: postgresListRolesSql,
  parseUsers: usersFromPostgresRolesResult,
  showGrantsSql: postgresShowGrantsSql,
  createUserSql: postgresCreateRoleSql,
  alterPasswordSql: postgresAlterRolePasswordSql,
  alterLoginSql: postgresAlterRoleLoginSql,
  dropUserSql: postgresDropRoleSql,
  grantPrivilegesSql: postgresGrantPrivilegesSql,
  revokePrivilegesSql: postgresRevokePrivilegesSql,
  label: postgresRoleLabel,
  detail: (user) => [user.host, user.plugin].filter(Boolean).join(" · ") || undefined,
  privilegesForScope: postgresPrivilegesForScope,
  defaultPrivilegesForScope: (scope) => (scope === "role" ? [] : [postgresDefaultPrivilege(scope)]),
};

const DATABASE_USER_ADMIN_PROVIDER_BY_TYPE = new Map<DatabaseType, DatabaseUserAdminProvider>([
  ["postgres", postgresUserAdminProvider],
  ["opengauss", postgresUserAdminProvider],
]);

export function getDatabaseUserAdminProvider(dbType: DatabaseType | undefined): DatabaseUserAdminProvider | null {
  return dbType ? (DATABASE_USER_ADMIN_PROVIDER_BY_TYPE.get(dbType) ?? null) : null;
}

export function supportsDatabaseUserAdmin(dbType: DatabaseType | undefined): boolean {
  return !!dbType && supportsDatabaseFeature(dbType, "userAdmin") && DATABASE_USER_ADMIN_PROVIDER_BY_TYPE.has(dbType);
}

export function resolveDatabaseUserAdminProviderForConnection(connection: ConnectionConfig | undefined): DatabaseUserAdminProvider | null {
  const dbType = effectiveDatabaseTypeForConnection(connection);
  return supportsDatabaseUserAdmin(dbType) ? getDatabaseUserAdminProvider(dbType) : null;
}

export function connectionSupportsDatabaseUserAdmin(connection: ConnectionConfig | undefined): boolean {
  return resolveDatabaseUserAdminProviderForConnection(connection) !== null;
}
