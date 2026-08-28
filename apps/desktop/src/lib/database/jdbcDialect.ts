import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { isSchemaAware, usesDatabaseObjectTreeMode, usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";
import type { CodeMirrorSqlDialectName } from "@/lib/editor/codemirrorSqlDialect";

type JdbcDialectConnection = Pick<ConnectionConfig, "db_type"> & Partial<Pick<ConnectionConfig, "driver_profile" | "driver_label" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths" | "database_info" | "external_config">>;

export type OpengaussConnectionMode = "native" | "jdbc";
export type GaussdbIdentifierQuoteStyle = "auto" | "double" | "backtick";

const GAUSSDB_IDENTIFIER_QUOTE_STYLE_KEY = "gaussdbIdentifierQuoteStyle";

function externalConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

// OG Developer: openGauss can route through the official JDBC driver, whose
// SHA256 password authentication the native PostgreSQL wire protocol lacks.
// The auto-provisioned Maven artifact org.opengauss:opengauss-jdbc keeps
// upstream pgJDBC branding (org.postgresql.Driver + jdbc:postgresql://).
export const OPENGAUSS_JDBC_DRIVER_PROFILE = "opengauss-jdbc";
export const OPENGAUSS_JDBC_DRIVER_CLASS = "org.postgresql.Driver";
export const OPENGAUSS_JDBC_DRIVER_COORDINATE = "org.opengauss:opengauss-jdbc:6.0.0";

const JDBC_DIALECT_MATCHERS: Array<{ type: DatabaseType; patterns: RegExp[] }> = [
  { type: "opengauss", patterns: [/jdbc:opengauss:/i, /org\.opengauss/i, /opengauss/i] },
  { type: "postgres", patterns: [/jdbc:postgresql:/i, /postgres/i] },
];

export function inferJdbcDialect(connection?: JdbcDialectConnection): DatabaseType | undefined {
  if (!connection || connection.db_type !== "jdbc") return undefined;
  const haystack = [connection.driver_profile, connection.driver_label, connection.connection_string, connection.jdbc_driver_class, ...(connection.jdbc_driver_paths ?? []), connection.database_info?.productName, connection.database_info?.serverComment, connection.database_info?.driverName]
    .filter(Boolean)
    .join("\n");
  if (!haystack) return undefined;
  return JDBC_DIALECT_MATCHERS.find((matcher) => matcher.patterns.some((pattern) => pattern.test(haystack)))?.type;
}

export function effectiveDatabaseTypeForConnection(connection?: JdbcDialectConnection): DatabaseType | undefined {
  if (!connection) return undefined;
  if (connection.db_type !== "jdbc") return connection.db_type;
  return inferJdbcDialect(connection) ?? "jdbc";
}

export function connectionShouldLoadIdentifierQuote(connection: JdbcDialectConnection | undefined): boolean {
  if (!connection) return false;
  if (gaussdbIdentifierQuoteStyle(connection) !== "auto") return false;
  if (connection.db_type === "opengauss") return true;
  if (connection.db_type !== "jdbc") return false;
  return ["opengauss", "postgres"].includes(inferJdbcDialect(connection) ?? "");
}

export function supportsGaussdbIdentifierQuoteStyle(connection: JdbcDialectConnection | undefined): boolean {
  return effectiveDatabaseTypeForConnection(connection) === "opengauss";
}

export function gaussdbIdentifierQuoteStyle(connection: JdbcDialectConnection | undefined): GaussdbIdentifierQuoteStyle {
  const external = externalConfigRecord(connection?.external_config);
  const style = external[GAUSSDB_IDENTIFIER_QUOTE_STYLE_KEY];
  return style === "double" || style === "backtick" ? style : "auto";
}

export function gaussdbIdentifierQuoteOverride(connection: JdbcDialectConnection | undefined): string | undefined {
  const style = gaussdbIdentifierQuoteStyle(connection);
  if (style === "double") return '"';
  if (style === "backtick") return "`";
  return undefined;
}

export function setGaussdbIdentifierQuoteStyle(
  connection: Pick<ConnectionConfig, "db_type"> & Partial<Pick<ConnectionConfig, "driver_profile" | "driver_label" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths" | "database_info" | "external_config">>,
  style: GaussdbIdentifierQuoteStyle,
) {
  const external = externalConfigRecord(connection.external_config);
  if (style === "auto") {
    delete external[GAUSSDB_IDENTIFIER_QUOTE_STYLE_KEY];
  } else {
    external[GAUSSDB_IDENTIFIER_QUOTE_STYLE_KEY] = style;
  }
  connection.external_config = Object.keys(external).length > 0 ? external : undefined;
}

export function opengaussConnectionMode(connection: JdbcDialectConnection | undefined): OpengaussConnectionMode {
  return connection?.db_type === "opengauss" && connection.driver_profile?.toLowerCase() === OPENGAUSS_JDBC_DRIVER_PROFILE ? "jdbc" : "native";
}

export function setOpengaussConnectionMode(connection: JdbcDialectConnection, mode: OpengaussConnectionMode) {
  if (connection.db_type !== "opengauss") return;
  connection.driver_profile = mode === "jdbc" ? OPENGAUSS_JDBC_DRIVER_PROFILE : "opengauss";
  connection.driver_label = "openGauss";
  connection.jdbc_driver_class = mode === "jdbc" ? OPENGAUSS_JDBC_DRIVER_CLASS : undefined;
  connection.connection_string = undefined;
}

export function sqlSnippetDatabaseTypeForConnection(connection?: JdbcDialectConnection): DatabaseType | undefined {
  return effectiveDatabaseTypeForConnection(connection);
}

export function tableStructureDatabaseTypeForConnection(connection?: JdbcDialectConnection): DatabaseType | undefined {
  return effectiveDatabaseTypeForConnection(connection);
}

export function connectionUsesDatabaseObjectTreeMode(connection?: JdbcDialectConnection): boolean {
  if (!connection) return false;
  if (connection.db_type !== "jdbc") return usesDatabaseObjectTreeMode(effectiveDatabaseTypeForConnection(connection));
  const dialect = inferJdbcDialect(connection);
  if (!dialect) return true;
  return !usesTreeSchemaMode(dialect);
}

export function connectionShouldDiscoverJdbcSchemas(connection?: JdbcDialectConnection): boolean {
  return connection?.db_type === "jdbc" && !inferJdbcDialect(connection);
}

export function connectionQueryExecutionSchema(connection: JdbcDialectConnection | undefined, _database: string | undefined, schema: string | undefined, dataMode: boolean): string | undefined {
  if (dataMode || connectionUsesDatabaseObjectTreeMode(connection)) return undefined;
  if (schema) return schema;
  return undefined;
}

export function connectionObjectTreeQuerySchema(connection: JdbcDialectConnection | undefined, database: string, schema?: string): string {
  if (connectionUsesDatabaseObjectTreeMode(connection)) return "";
  return schema || database;
}

export function metadataSchemaForConnection(connection: JdbcDialectConnection | undefined, database: string, schema?: string): string {
  return connectionObjectTreeQuerySchema(connection, database, schema);
}

export function connectionObjectTreeNodeSchema(connection: JdbcDialectConnection | undefined, database: string, schema?: string): string | undefined {
  if (connectionUsesDatabaseObjectTreeMode(connection)) return undefined;
  const type = effectiveDatabaseTypeForConnection(connection);
  if (!type) return schema;
  return isSchemaAware(type) ? schema || database : undefined;
}

/** Maps a database type to the corresponding CodeMirror SQL dialect name used by QueryEditor and DdlViewDialog. */
export function codeMirrorSqlDialect(dbType: DatabaseType | undefined): "postgres" {
  void dbType;
  return "postgres";
}

export function codeMirrorSqlDialectForConnection(connection?: JdbcDialectConnection): CodeMirrorSqlDialectName {
  return codeMirrorSqlDialect(effectiveDatabaseTypeForConnection(connection));
}
