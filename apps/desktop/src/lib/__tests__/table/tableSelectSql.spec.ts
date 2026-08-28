import { describe, expect, it } from "vitest";
import { qualifiedTableName, quoteTableDataIdentifier, quoteTableIdentifier } from "@/lib/table/tableSelectSql";

describe("qualifiedTableName", () => {
  it("qualifies a PostgreSQL table with its schema", () => {
    expect(qualifiedTableName({ databaseType: "postgres", schema: "public", tableName: "orders" })).toBe('"public"."orders"');
  });

  it("qualifies an openGauss table with its schema", () => {
    expect(qualifiedTableName({ databaseType: "opengauss", schema: "public", tableName: "orders" })).toBe('"public"."orders"');
  });

  it("uses the connection-reported quote for openGauss table-data identifiers", () => {
    expect(qualifiedTableName({ databaseType: "opengauss", identifierQuote: '"', schema: "public", tableName: "MixedCase" })).toBe('public."MixedCase"');
  });

  it("passes JDBC table names through unqualified and unquoted", () => {
    expect(qualifiedTableName({ databaseType: "jdbc", schema: "public", tableName: "orders" })).toBe("orders");
  });
});

describe("quoteTableIdentifier", () => {
  it("double-quotes postgres identifiers", () => {
    expect(quoteTableIdentifier("postgres", "orders")).toBe('"orders"');
    expect(quoteTableIdentifier("postgres", 'a"b')).toBe('"a""b"');
  });

  it("keeps explicitly quoted openGauss identifiers untouched", () => {
    expect(quoteTableIdentifier("opengauss", '"AlreadyQuoted"')).toBe('"AlreadyQuoted"');
    expect(quoteTableIdentifier("opengauss", "orders")).toBe('"orders"');
  });

  it("passes JDBC identifiers through unquoted", () => {
    expect(quoteTableIdentifier("jdbc", "orders")).toBe("orders");
  });
});

describe("quoteTableDataIdentifier", () => {
  it("selectively quotes openGauss/PostgreSQL identifiers with the driver-reported quote", () => {
    for (const databaseType of ["postgres", "opengauss"] as const) {
      expect(quoteTableDataIdentifier(databaseType, "table_01", "`")).toBe("table_01");
      expect(quoteTableDataIdentifier(databaseType, "MixedCase", "`")).toBe("`MixedCase`");
      expect(quoteTableDataIdentifier(databaseType, "order", "`")).toBe("`order`");
      expect(quoteTableDataIdentifier(databaseType, "order detail", "`")).toBe("`order detail`");
      expect(quoteTableDataIdentifier(databaseType, "`AlreadyQuoted`", "`")).toBe("`AlreadyQuoted`");
      expect(quoteTableDataIdentifier(databaseType, "MixedCase", '"')).toBe('"MixedCase"');
    }
  });

  it("preserves native openGauss quoting behavior without a driver quote", () => {
    expect(quoteTableDataIdentifier("opengauss", "table_01")).toBe('"table_01"');
    expect(quoteTableDataIdentifier("opengauss", "MixedCase")).toBe('"MixedCase"');
    expect(quoteTableDataIdentifier("opengauss", '"AlreadyQuoted"')).toBe('"AlreadyQuoted"');
  });
});
