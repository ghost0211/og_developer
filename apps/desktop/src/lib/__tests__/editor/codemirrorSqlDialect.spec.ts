import { describe, expect, it } from "vitest";
import { PostgreSQL } from "@codemirror/lang-sql";
import { postgresKeywordSyntaxTerms } from "@/lib/editor/codemirrorSqlDialect";

describe("codemirrorSqlDialect", () => {
  it("keeps common PostgreSQL identifier names out of keyword highlighting", () => {
    const keywords = new Set(postgresKeywordSyntaxTerms(PostgreSQL.spec.keywords || "").split(/\s+/));

    expect(keywords.has("select")).toBe(true);
    expect(keywords.has("from")).toBe(true);
    expect(keywords.has("where")).toBe(true);
    expect(keywords.has("id")).toBe(false);
    expect(keywords.has("name")).toBe(false);
    expect(keywords.has("user")).toBe(false);
    expect(keywords.has("count")).toBe(false);
    for (const field of ["schema_name", "table_name", "column_name", "catalog_name"]) expect(keywords.has(field)).toBe(false);
    expect(keywords.has("current_schema")).toBe(true);
  });
});
