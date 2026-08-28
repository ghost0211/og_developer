import { describe, expect, it } from "vitest";
import { canEditExistingTableRows, canUseKeylessRowPredicate, editablePrimaryKeys, editableRowIdentifierColumns, isTableDataEditable, supportsDataGridTransaction } from "@/lib/table/tableEditing";
import type { ColumnInfo, IndexInfo } from "@/types/database";

function column(name: string, isPrimaryKey = false): ColumnInfo {
  return {
    name,
    data_type: "varchar",
    is_nullable: true,
    column_default: null,
    is_primary_key: isPrimaryKey,
    extra: null,
  };
}

function index(columns: string[], isUnique = true, filter: string | null = null): IndexInfo {
  return {
    name: columns.join("_"),
    columns,
    is_unique: isUnique,
    is_primary: false,
    filter,
  };
}

describe("tableEditing", () => {
  it("treats view data tabs as readonly", () => {
    expect(isTableDataEditable("opengauss", ["id"], "VIEW")).toBe(false);
    expect(isTableDataEditable("postgres", ["id"], "VIEW")).toBe(false);
  });

  it("extracts primary keys from column definitions", () => {
    expect(editablePrimaryKeys("opengauss", [column("ID"), column("NAME")])).toEqual([]);
    expect(editablePrimaryKeys("opengauss", [column("ID", true), column("NAME")])).toEqual(["ID"]);
    expect(editablePrimaryKeys("postgres", [column("ID", true), column("NAME", true)])).toEqual(["ID", "NAME"]);
  });

  it("allows keyless row predicates only for databases that support them", () => {
    expect(canUseKeylessRowPredicate("postgres", [])).toBe(true);
    expect(canUseKeylessRowPredicate("opengauss", [])).toBe(true);
    expect(canUseKeylessRowPredicate("jdbc", [])).toBe(false);
    expect(canUseKeylessRowPredicate("postgres", ["id"])).toBe(false);
  });

  it("uses unique indexes as row identifiers when primary keys are absent", () => {
    expect(editableRowIdentifierColumns("postgres", [column("email"), column("name")], [index(["email", "name"]), index(["email"])])).toEqual(["email"]);
    expect(editableRowIdentifierColumns("postgres", [column("email"), column("name")], [index(["email"], true, "email IS NOT NULL")])).toEqual([]);
    expect(editableRowIdentifierColumns("postgres", [column("id", true), column("email")], [index(["email"])])).toEqual(["id"]);
    expect(editableRowIdentifierColumns("opengauss", [column("email"), column("name")], [index(["email"])])).toEqual(["email"]);
  });

  it("supports transactions for data grid mutations", () => {
    expect(supportsDataGridTransaction("opengauss")).toBe(true);
    expect(supportsDataGridTransaction("postgres")).toBe(true);
  });

  it("checks existing row editability based on primary key requirements", () => {
    expect(canEditExistingTableRows("opengauss", ["id"])).toBe(true);
    expect(canEditExistingTableRows("postgres", ["id"])).toBe(true);
  });
});
