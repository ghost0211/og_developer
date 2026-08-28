import { describe, expect, it } from "vitest";
import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";

describe("sqlSemanticDialectFor", () => {
  it("resolves postgres dialect for postgres and opengauss", () => {
    const pgDialect = sqlSemanticDialectFor({ databaseType: "postgres" });
    expect(pgDialect.id).toBe("postgres");
    expect(pgDialect.identifierQuotes).toEqual([{ open: '"', close: '"' }]);
    expect(pgDialect.normalizeIdentifier("EventName")).toBe("eventname");
    expect(pgDialect.normalizeIdentifier("EventName", true)).toBe("EventName");
    expect(pgDialect.quoteIdentifier('event"name')).toBe('"event""name"');

    const ogDialect = sqlSemanticDialectFor({ databaseType: "opengauss" });
    expect(ogDialect.id).toBe("postgres");

    const explicitDialect = sqlSemanticDialectFor({ dialect: "postgres" });
    expect(explicitDialect.id).toBe("postgres");
  });

  it("resolves generic dialect by default", () => {
    const dialect = sqlSemanticDialectFor({});
    expect(dialect.id).toBe("generic");
    expect(dialect.identifierQuotes).toEqual([{ open: '"', close: '"' }]);
    expect(dialect.normalizeIdentifier("EventName")).toBe("EventName");
    expect(dialect.quoteIdentifier('event"name')).toBe('"event""name"');
  });
});
