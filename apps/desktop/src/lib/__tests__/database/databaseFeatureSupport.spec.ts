import { describe, expect, it } from "vitest";
import { connectionNamespaceCreationTarget, databaseNodeNamespaceCreationTarget } from "@/lib/database/databaseNamespaceCreation";
import { editableDatabasePropertyGroups, editableSchemaPropertyGroups } from "@/lib/database/databasePropertyEditing";
import { buildGetDatabaseCommentSql } from "@/lib/database/dbAdminSql";
import { isSchemaAware, supportsDatabaseNameCompletion, supportsDatabaseSchemaQualifier, supportsSqlInListPaste, supportsTableImport, supportsTransaction } from "@/lib/database/databaseFeatureSupport";

describe("schema awareness", () => {
  it("marks openGauss, Postgres, and JDBC as schema aware", () => {
    expect(isSchemaAware("opengauss")).toBe(true);
    expect(isSchemaAware("postgres")).toBe(true);
    expect(isSchemaAware("jdbc")).toBe(true);
    expect(isSchemaAware(undefined)).toBe(false);
  });
});

describe("database and schema qualifiers", () => {
  it.each(["opengauss", "postgres", "jdbc"] as const)("does not widen three-part completion for %s", (databaseType) => {
    expect(supportsDatabaseSchemaQualifier(databaseType)).toBe(false);
  });

  it.each(["opengauss", "postgres", "jdbc"] as const)("does not add database name completion for %s", (databaseType) => {
    expect(supportsDatabaseNameCompletion(databaseType)).toBe(false);
  });
});

describe("supportsTransaction", () => {
  it("returns true for openGauss and Postgres", () => {
    expect(supportsTransaction("opengauss")).toBe(true);
    expect(supportsTransaction("postgres")).toBe(true);
  });

  it("returns false for undefined input", () => {
    expect(supportsTransaction(undefined)).toBe(false);
  });
});

describe("supportsSqlInListPaste", () => {
  it("allows openGauss, Postgres, and JDBC editors", () => {
    expect(supportsSqlInListPaste(undefined)).toBe(true);
    expect(supportsSqlInListPaste("opengauss")).toBe(true);
    expect(supportsSqlInListPaste("postgres")).toBe(true);
    expect(supportsSqlInListPaste("jdbc")).toBe(true);
  });
});

describe("supportsTableImport", () => {
  it("enables openGauss and Postgres table import", () => {
    expect(supportsTableImport("opengauss")).toBe(true);
    expect(supportsTableImport("postgres")).toBe(true);
  });
});

describe("database property editing", () => {
  it("allows PostgreSQL and openGauss comment edits on supported database and schema nodes", () => {
    expect(editableDatabasePropertyGroups({ db_type: "postgres" }, { type: "database", database: "postgres" })).toEqual(["databaseComment"]);
    expect(editableDatabasePropertyGroups({ db_type: "opengauss" }, { type: "database", database: "postgres" })).toEqual(["databaseComment"]);
    expect(editableSchemaPropertyGroups({ db_type: "postgres" }, { type: "schema", database: "postgres", schema: "public" })).toEqual(["schemaComment"]);
    expect(editableSchemaPropertyGroups({ db_type: "opengauss" }, { type: "schema", database: "postgres", schema: "public" })).toEqual(["schemaComment"]);
  });

  it("hides property editing for read-only and wrong tree nodes", () => {
    expect(editableDatabasePropertyGroups({ db_type: "postgres", read_only: true }, { type: "database", database: "postgres" })).toEqual([]);
    expect(editableDatabasePropertyGroups({ db_type: "postgres" }, { type: "connection" })).toEqual([]);
    expect(editableSchemaPropertyGroups({ db_type: "postgres", read_only: true }, { type: "schema", database: "postgres", schema: "public" })).toEqual([]);
    expect(editableSchemaPropertyGroups({ db_type: "postgres" }, { type: "database", database: "postgres" })).toEqual([]);
  });

  it("queries PostgreSQL database comments from shared object descriptions", () => {
    expect(buildGetDatabaseCommentSql({ databaseType: "postgres", name: "app" })).toContain("shobj_description(db.oid, 'pg_database')");
  });
});

describe("database namespace creation", () => {
  it("allows connection-level database creation for openGauss and Postgres", () => {
    expect(connectionNamespaceCreationTarget({ db_type: "opengauss" })).toBe("database");
    expect(connectionNamespaceCreationTarget({ db_type: "postgres" })).toBe("database");
    expect(connectionNamespaceCreationTarget({ db_type: "jdbc" })).toBeNull();
  });

  it("hides creation for read-only targets", () => {
    expect(connectionNamespaceCreationTarget({ db_type: "opengauss", read_only: true })).toBeNull();
    expect(connectionNamespaceCreationTarget({ db_type: "postgres", read_only: true })).toBeNull();
  });

  it("allows schema creation on writable database nodes with schema targets", () => {
    expect(databaseNodeNamespaceCreationTarget({ db_type: "postgres" }, { type: "database", database: "postgres" })).toBe("schema");
    expect(databaseNodeNamespaceCreationTarget({ db_type: "opengauss" }, { type: "database", database: "postgres" })).toBe("schema");
    expect(databaseNodeNamespaceCreationTarget({ db_type: "postgres", read_only: true }, { type: "database", database: "postgres" })).toBeNull();
    expect(databaseNodeNamespaceCreationTarget({ db_type: "postgres" }, { type: "connection" })).toBeNull();
    expect(databaseNodeNamespaceCreationTarget({ db_type: "jdbc" }, { type: "database", database: "main" })).toBeNull();
  });
});
