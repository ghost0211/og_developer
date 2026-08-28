import { describe, expect, it } from "vitest";
import { appendConnectionErrorHints } from "@/lib/connection/connectionErrorHints";
import type { ConnectionConfig } from "@/types/database";

function jdbcConfig(): ConnectionConfig {
  return {
    id: "jdbc-test",
    name: "openGauss JDBC",
    db_type: "jdbc",
    host: "127.0.0.1",
    port: 5432,
    username: "dbx",
    password: "",
    database: "postgres",
    ssl: false,
  };
}

function postgresConfig(): ConnectionConfig {
  return {
    id: "postgres-test",
    name: "Postgres",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: undefined,
    ssl: false,
  };
}

const t = (key: string) => {
  if (key === "connection.jdbcMissingRuntimeDependencyHint") return "Install from Maven or import every dependency JAR.";
  return key;
};

describe("appendConnectionErrorHints", () => {
  it("adds an installation hint when a custom JDBC driver is missing a runtime dependency", () => {
    const error = "Missing Java class com.alibaba.fastjson.JSONException. Install the required runtime dependency.";
    const message = appendConnectionErrorHints(jdbcConfig(), error, t);

    expect(message).toContain(error);
    expect(message).toContain("Install from Maven or import every dependency JAR.");
  });

  it("does not add the JDBC dependency hint to non-JDBC connections", () => {
    const error = "Missing Java class com.alibaba.fastjson.JSONException. Install the required runtime dependency.";

    expect(appendConnectionErrorHints(postgresConfig(), error, t)).toBe(error);
  });

  it("does not add hints to unrelated JDBC errors", () => {
    expect(appendConnectionErrorHints(jdbcConfig(), "Connection refused", t)).toBe("Connection refused");
  });

  it("returns the message unchanged without a config", () => {
    expect(appendConnectionErrorHints(undefined, "boom", t)).toBe("boom");
  });
});
