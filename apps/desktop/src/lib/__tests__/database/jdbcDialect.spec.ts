import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import {
  OPENGAUSS_JDBC_DRIVER_CLASS,
  connectionObjectTreeNodeSchema,
  connectionObjectTreeQuerySchema,
  connectionQueryExecutionSchema,
  connectionShouldDiscoverJdbcSchemas,
  connectionShouldLoadIdentifierQuote,
  connectionUsesDatabaseObjectTreeMode,
  codeMirrorSqlDialectForConnection,
  effectiveDatabaseTypeForConnection,
  opengaussConnectionMode,
  gaussdbIdentifierQuoteOverride,
  gaussdbIdentifierQuoteStyle,
  inferJdbcDialect,
  setOpengaussConnectionMode,
  setGaussdbIdentifierQuoteStyle,
  supportsGaussdbIdentifierQuoteStyle,
} from "@/lib/database/jdbcDialect";

describe("jdbc dialect inference", () => {
  it("detects openGauss JDBC connections as schema-aware", () => {
    const opengaussConnection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:opengauss://localhost:5432/postgres",
      jdbc_driver_class: "org.opengauss.Driver",
    };

    expect(inferJdbcDialect(opengaussConnection)).toBe("opengauss");
    expect(connectionUsesDatabaseObjectTreeMode(opengaussConnection)).toBe(false);
  });

  it("detects PostgreSQL JDBC connections", () => {
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        connection_string: "jdbc:postgresql://localhost:5432/postgres",
        jdbc_driver_class: "org.postgresql.Driver",
      }),
    ).toBe("postgres");
    expect(
      effectiveDatabaseTypeForConnection({
        db_type: "jdbc",
        connection_string: "jdbc:postgresql://localhost:5432/postgres",
      }),
    ).toBe("postgres");
  });

  it("returns undefined for unrecognized JDBC connections", () => {
    expect(inferJdbcDialect({ db_type: "jdbc", connection_string: "jdbc:unknown://localhost/db" })).toBeUndefined();
    expect(inferJdbcDialect({ db_type: "postgres" })).toBeUndefined();
  });

  it("loads driver-reported identifier quotes for compatible JDBC connections", () => {
    expect(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", jdbc_driver_class: "org.opengauss.Driver" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", jdbc_driver_class: "org.postgresql.Driver" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "opengauss" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "postgres" })).toBe(false);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", connection_string: "jdbc:unknown://localhost/db" })).toBe(false);
    expect(
      connectionShouldLoadIdentifierQuote({
        db_type: "jdbc",
        jdbc_driver_class: "org.postgresql.Driver",
        external_config: { gaussdbIdentifierQuoteStyle: "backtick" },
      }),
    ).toBe(false);
  });

  it("discovers schemas only for generic JDBC connections", () => {
    expect(connectionShouldDiscoverJdbcSchemas({ db_type: "jdbc", connection_string: "jdbc:unknown://localhost/db" })).toBe(true);
    expect(connectionShouldDiscoverJdbcSchemas({ db_type: "jdbc", jdbc_driver_class: "org.postgresql.Driver" })).toBe(false);
    expect(connectionShouldDiscoverJdbcSchemas({ db_type: "opengauss" })).toBe(false);
  });

  it("supports persisted openGauss identifier quote overrides", () => {
    const native = { db_type: "opengauss" as const, external_config: undefined as unknown };
    const jdbc = { db_type: "jdbc" as const, jdbc_driver_class: "org.opengauss.Driver", external_config: { retained: true } as unknown };

    expect(supportsGaussdbIdentifierQuoteStyle(native)).toBe(true);
    expect(gaussdbIdentifierQuoteStyle(native)).toBe("auto");
    expect(gaussdbIdentifierQuoteOverride(native)).toBeUndefined();

    setGaussdbIdentifierQuoteStyle(native, "backtick");
    expect(gaussdbIdentifierQuoteStyle(native)).toBe("backtick");
    expect(gaussdbIdentifierQuoteOverride(native)).toBe("`");

    setGaussdbIdentifierQuoteStyle(jdbc, "double");
    expect(jdbc.external_config).toEqual({ retained: true, gaussdbIdentifierQuoteStyle: "double" });
    expect(gaussdbIdentifierQuoteOverride(jdbc)).toBe('"');
    expect(connectionShouldLoadIdentifierQuote(jdbc)).toBe(false);

    setGaussdbIdentifierQuoteStyle(jdbc, "auto");
    expect(jdbc.external_config).toEqual({ retained: true });
    expect(connectionShouldLoadIdentifierQuote(jdbc)).toBe(true);
  });
});

describe("openGauss connection mode", () => {
  it("defaults to native and configures the official JDBC driver for jdbc mode", () => {
    const connection = { db_type: "opengauss", driver_profile: "opengauss", driver_label: "openGauss" } as ConnectionConfig;

    expect(opengaussConnectionMode(connection)).toBe("native");
    setOpengaussConnectionMode(connection, "jdbc");
    expect(connection.driver_profile).toBe("opengauss-jdbc");
    expect(connection.jdbc_driver_class).toBe(OPENGAUSS_JDBC_DRIVER_CLASS);
    expect(opengaussConnectionMode(connection)).toBe("jdbc");

    setOpengaussConnectionMode(connection, "native");
    expect(connection.driver_profile).toBe("opengauss");
    expect(connection.jdbc_driver_class).toBeUndefined();
    expect(opengaussConnectionMode(connection)).toBe("native");
  });

  it("does not switch other database types to jdbc mode", () => {
    const postgres = { db_type: "postgres", driver_profile: "postgres" } as ConnectionConfig;
    setOpengaussConnectionMode(postgres, "jdbc");
    expect(postgres.driver_profile).toBe("postgres");
    expect(opengaussConnectionMode(postgres)).toBe("native");
  });

  it("adapts the editor SQL dialect to the compatibility mode", () => {
    expect(codeMirrorSqlDialectForConnection({ db_type: "opengauss" })).toBe("postgres");
    expect(codeMirrorSqlDialectForConnection({ db_type: "opengauss", database_info: { sqlCompatibility: "A" } })).toBe("postgres");
    expect(codeMirrorSqlDialectForConnection({ db_type: "opengauss", database_info: { sqlCompatibility: "PG" } })).toBe("postgres");
    expect(codeMirrorSqlDialectForConnection({ db_type: "postgres" })).toBe("postgres");
  });
});

describe("query execution schema", () => {
  it("prefers an explicit schema for PostgreSQL", () => {
    expect(connectionQueryExecutionSchema({ db_type: "postgres" }, "app", "reporting", false)).toBe("reporting");
  });

  it("prefers an explicit schema for openGauss query execution", () => {
    expect(connectionQueryExecutionSchema({ db_type: "opengauss" }, "app", "sdy_smartsite", false)).toBe("sdy_smartsite");
  });

  it("does not send a schema without an explicit selection", () => {
    expect(connectionQueryExecutionSchema({ db_type: "postgres" }, "app", undefined, false)).toBeUndefined();
  });

  it("does not change data-tab execution context", () => {
    expect(connectionQueryExecutionSchema({ db_type: "postgres" }, "app", "reporting", true)).toBeUndefined();
  });
});

describe("object tree node schema", () => {
  it("qualifies openGauss tables with the schema", () => {
    expect(connectionObjectTreeQuerySchema({ db_type: "opengauss" }, "postgres", "public")).toBe("public");
    expect(connectionObjectTreeNodeSchema({ db_type: "opengauss" }, "postgres", "public")).toBe("public");
    expect(connectionObjectTreeNodeSchema({ db_type: "opengauss" }, "postgres")).toBe("postgres");
  });

  it("qualifies PostgreSQL tables with the schema", () => {
    expect(connectionObjectTreeQuerySchema({ db_type: "postgres" }, "app", "reporting")).toBe("reporting");
    expect(connectionObjectTreeNodeSchema({ db_type: "postgres" }, "app", "reporting")).toBe("reporting");
  });
});
