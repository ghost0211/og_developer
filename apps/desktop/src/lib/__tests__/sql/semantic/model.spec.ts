import { describe, expect, it } from "vitest";
import { sqlSemanticCompletionScope, sqlSemanticLocalColumnsByTable, sqlSemanticProjectionAliasColumns, sqlSemanticSelectStarIsOnlyProjection, sqlSemanticSelectStarQualifierSql, sqlSemanticSelectStarTableSource } from "@/lib/sql/semantic/completion";
import { SQL_SEMANTIC_BASELINE_FIXTURES, sqlFixtureCursor } from "@/lib/sql/semantic/fixtures";
import { buildSqlSemanticModel, sqlSemanticTableNameSpans } from "@/lib/sql/semantic/model";

describe("sqlSemanticModel baseline fixtures", () => {
  for (const fixture of SQL_SEMANTIC_BASELINE_FIXTURES) {
    it(fixture.name, () => {
      const { sql, cursor } = sqlFixtureCursor(fixture.sql);
      const model = buildSqlSemanticModel(sql, cursor, { databaseType: fixture.databaseType });
      const scope = sqlSemanticCompletionScope(model);

      expect(model.statement.kind).toBe(fixture.expected.statementKind);
      expect(model.cursorIntent.kind).toBe(fixture.expected.cursorKind);
      expect(scope.kind).toBe(fixture.expected.completionScope);
      expect(model.cursorIntent.prefix).toBe(fixture.expected.prefix);
      expect(model.cursorIntent.qualifierParts).toEqual(fixture.expected.qualifierParts ?? []);
      expect(model.cursorIntent.confidence).toBe(fixture.expected.confidence);

      for (const expectedSource of fixture.expected.rowSources ?? []) {
        const expectedObject = Object.fromEntries(Object.entries(expectedSource).filter(([, value]) => value !== undefined));
        expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining(expectedObject)]));
      }

      if (fixture.expected.completionLabels) {
        const labels = [...sqlSemanticLocalColumnsByTable(model).values()].flat().map((column) => column.name);
        expect(labels).toEqual(expect.arrayContaining(fixture.expected.completionLabels));
      }
    });
  }

  it("does not treat SELECT as the qualifier of an unqualified star", () => {
    const { sql, cursor } = sqlFixtureCursor("select *| from apis as ap");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.cursorIntent).toEqual(expect.objectContaining({ kind: "star", qualifierParts: [] }));
  });

  it("retains the qualifier of a qualified star", () => {
    const { sql, cursor } = sqlFixtureCursor("select ap.*| from apis as ap");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.cursorIntent).toEqual(expect.objectContaining({ kind: "star", qualifierParts: ["ap"], targetSourceId: model.rowSources[0]?.id }));
  });

  it("does not resolve an unqualified star to the only physical table among multiple row sources", () => {
    const { sql, cursor } = sqlFixtureCursor("select *| from users u join (select 1 as x) s on 1 = 1");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.rowSources.map((source) => source.kind)).toEqual(["table", "subquery"]);
    expect(sqlSemanticSelectStarTableSource(model)).toBeUndefined();
  });

  it.each([
    ["select *| from apis", true],
    ["select distinct *| from apis", true],
    ["select ap.*| from apis ap", true],
    ["select *, 1 as extra| from apis", false],
    ["select ap.*, 1 as extra| from apis ap", false],
  ] as const)("detects whether the star is the only projection in %s", (markedSql, expected) => {
    const { sql, cursor } = sqlFixtureCursor(markedSql);

    expect(sqlSemanticSelectStarIsOnlyProjection(buildSqlSemanticModel(sql, cursor))).toBe(expected);
  });

  it("retains the original quoting of a star qualifier", () => {
    const { sql, cursor } = sqlFixtureCursor('select "Order Alias".*| from orders as "Order Alias"');

    expect(sqlSemanticSelectStarQualifierSql(buildSqlSemanticModel(sql, cursor, { databaseType: "postgres", dialect: "postgres" }))).toBe('"Order Alias"');
  });

  it("does not mix row sources from inactive statements", () => {
    const { sql, cursor } = sqlFixtureCursor("select * from users u; select * from orders o where o.|");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.rowSources.some((source) => source.name === "orders")).toBe(true);
    expect(model.rowSources.some((source) => source.name === "users")).toBe(false);
  });

  it("does not expose CTE body tables as outer query row sources", () => {
    const { sql, cursor } = sqlFixtureCursor("WITH recent_orders AS (SELECT id FROM orders) SELECT * FROM recent_orders ro WHERE ro.|");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.rowSources.some((source) => source.name === "recent_orders")).toBe(true);
    expect(model.rowSources.some((source) => source.name === "orders")).toBe(false);
  });

  it("does not expose subquery body tables as outer query row sources", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM (SELECT id FROM users) sq WHERE sq.|");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "sq", kind: "subquery" })]));
    expect(model.rowSources.some((source) => source.name === "users")).toBe(false);
  });

  it("suppresses completion inside string literals without metadata scope", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT 'u.|' FROM users");
    const model = buildSqlSemanticModel(sql, cursor);
    const scope = sqlSemanticCompletionScope(model);

    expect(model.cursorIntent.kind).toBe("suppressed");
    expect(scope.useRemoteMetadata).toBe(false);
  });

  it("classifies table references after comma-separated table lists", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM users u, ord|");
    const model = buildSqlSemanticModel(sql, cursor);
    const scope = sqlSemanticCompletionScope(model);

    expect(model.cursorIntent.kind).toBe("table");
    expect(model.cursorIntent.prefix).toBe("ord");
    expect(scope.kind).toBe("table");
  });

  it("extracts aliases from completed comma-separated table lists", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM table_a a, table_b b WHERE a.id = b.|");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "table_a", alias: "a" }), expect.objectContaining({ name: "table_b", alias: "b" })]));
    expect(model.cursorIntent).toEqual(expect.objectContaining({ kind: "alias_column", qualifierParts: ["b"] }));
  });

  it.each([
    ["table name", "SELECT orders.| FROM orders", ["orders"]],
    ["schema-qualified table name", "SELECT public.orders.| FROM public.orders", ["public", "orders"]],
  ] as const)("resolves columns through a PostgreSQL %s qualifier before FROM", (_label, markedSql, qualifierParts) => {
    const { sql, cursor } = sqlFixtureCursor(markedSql);
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres", dialect: "postgres" });

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "orders", alias: undefined })]));
    expect(model.cursorIntent).toEqual(expect.objectContaining({ kind: "alias_column", qualifierParts, targetSourceId: model.rowSources[0]?.id }));
  });

  it("consumes correlation column lists before parsing later comma-separated sources", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM table_a a(id), table_b b, table_c c WHERE c.|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres" });

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "table_a", alias: "a", columns: undefined, columnAliases: ["id"] }), expect.objectContaining({ name: "table_b", alias: "b" }), expect.objectContaining({ name: "table_c", alias: "c" })]));
    expect(model.cursorIntent).toEqual(expect.objectContaining({ kind: "alias_column", qualifierParts: ["c"] }));
  });

  it("parses generic PostgreSQL table functions and their correlation columns", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM generate_series(1, 3) g(value) WHERE g.|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres" });

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "table_function", name: "g", alias: "g", columns: ["value"] })]));
    expect(model.cursorIntent).toEqual(expect.objectContaining({ kind: "alias_column", qualifierParts: ["g"] }));
  });

  it("consumes LATERAL functions before parsing later comma-separated sources", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM users u, LATERAL generate_series(1, 3) g(value), orders o WHERE o.|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres" });

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "users", alias: "u" }), expect.objectContaining({ kind: "table_function", name: "g", alias: "g", columns: ["value"] }), expect.objectContaining({ name: "orders", alias: "o" })]));
    expect(model.cursorIntent).toEqual(expect.objectContaining({ kind: "alias_column", qualifierParts: ["o"] }));
  });

  it("consumes WITH ORDINALITY before function aliases and later sources", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM generate_series(1, 3) WITH ORDINALITY AS g(value, ord), orders o WHERE o.|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres" });

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "table_function", name: "g", alias: "g", columns: ["value", "ord"] }), expect.objectContaining({ name: "orders", alias: "o" })]));
    expect(model.cursorIntent).toEqual(expect.objectContaining({ kind: "alias_column", qualifierParts: ["o"] }));
  });

  it("parses comma-separated sources after a complete joined table", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM users u JOIN orders o ON o.user_id = u.id, audit_log a WHERE a.|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres" });

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "users", alias: "u" }), expect.objectContaining({ name: "orders", alias: "o" }), expect.objectContaining({ name: "audit_log", alias: "a" })]));
    expect(model.cursorIntent).toEqual(expect.objectContaining({ kind: "alias_column", qualifierParts: ["a"] }));
  });

  it("does not parse commas in later SELECT clauses as row sources", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM users u WINDOW w1 AS (PARTITION BY u.id), w2 AS (PARTITION BY u.id)|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres" });

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "users", alias: "u" })]));
    expect(model.rowSources.some((source) => source.name === "w2")).toBe(false);
  });

  it("keeps LATERAL subqueries available as row sources", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM users u, LATERAL (SELECT u.id AS user_id) s WHERE s.|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres" });

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "subquery", name: "s", alias: "s", columns: ["user_id"] })]));
    expect(model.cursorIntent).toEqual(expect.objectContaining({ kind: "alias_column", qualifierParts: ["s"] }));
  });

  it("keeps partial PostgreSQL correlation names separate from the source schema", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM users u(user_id) WHERE u.|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres" });

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "table", name: "users", alias: "u", columns: undefined, columnAliases: ["user_id"], metadataTarget: { table: "users" } })]));
  });

  it("classifies alias-qualified star with replacement range", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT u.*| FROM users u");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.cursorIntent.kind).toBe("star");
    expect(model.cursorIntent.prefix).toBe("*");
    expect(model.cursorIntent.qualifierParts).toEqual(["u"]);
    expect(sql.slice(model.cursorIntent.replacementRange.start, model.cursorIntent.replacementRange.end)).toBe("*");
  });

  it("returns low-confidence keyword fallback for unknown SQL", () => {
    const { sql, cursor } = sqlFixtureCursor("explain analyze |");
    const model = buildSqlSemanticModel(sql, cursor);
    const scope = sqlSemanticCompletionScope(model);

    expect(model.cursorIntent.kind).toBe("keyword");
    expect(model.cursorIntent.confidence).toBe("low");
    expect(scope.useRemoteMetadata).toBe(false);
  });

  it("exposes PostgreSQL projection aliases in ORDER BY but not WHERE", () => {
    const orderBy = sqlFixtureCursor("select total_amount as total from orders order by to|");
    const where = sqlFixtureCursor("select total_amount as total from orders where to|");

    expect(sqlSemanticProjectionAliasColumns(buildSqlSemanticModel(orderBy.sql, orderBy.cursor, { databaseType: "postgres" })).map((column) => column.name)).toContain("total");
    expect(sqlSemanticProjectionAliasColumns(buildSqlSemanticModel(where.sql, where.cursor, { databaseType: "postgres" })).map((column) => column.name)).not.toContain("total");
  });

  it("keeps PostgreSQL identifier normalization and qualifier scopes", () => {
    const postgres = sqlFixtureCursor('SELECT total AS "Order Total" FROM "Sales"."Orders" o ORDER BY "Order|');

    expect(sqlSemanticProjectionAliasColumns(buildSqlSemanticModel(postgres.sql, postgres.cursor, { databaseType: "postgres" })).map((column) => column.name)).toContain("Order Total");
  });

  it("covers PostgreSQL lower-case folding with CTEs and ORDER BY projection aliases", () => {
    const { sql, cursor } = sqlFixtureCursor("WITH RecentOrders AS (SELECT id, total FROM orders) SELECT total AS total_alias FROM RecentOrders ro ORDER BY total_|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres" });

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "recentorders", alias: "ro", columns: ["id", "total"] })]));
    expect(sqlSemanticProjectionAliasColumns(model).map((column) => column.name)).toContain("total_alias");
  });

  it("returns only concrete table-name spans for semantic highlighting", () => {
    const sql = "SELECT customer_id FROM dbo.wfAdmin AS wa WHERE wa.customer_id > 0";
    const spans = sqlSemanticTableNameSpans(sql);

    expect(spans.map((span) => sql.slice(span.start, span.end))).toEqual(["wfAdmin"]);
  });

  it("finds table names across statements, subqueries, and comma table lists", () => {
    const sql = "SELECT * FROM users u, orders o; SELECT * FROM (SELECT * FROM audit_log) a JOIN dbo.events e ON e.id = a.id";
    const spans = sqlSemanticTableNameSpans(sql);

    expect(spans.map((span) => sql.slice(span.start, span.end))).toEqual(["users", "orders", "audit_log", "events"]);
  });

  it("highlights mutation targets but ignores strings, comments, and table functions", () => {
    const sql = "UPDATE users SET name = 'FROM fake'; INSERT INTO audit_log(id) VALUES (1); -- FROM ignored\nSELECT * FROM read_csv('events.csv') e";
    const spans = sqlSemanticTableNameSpans(sql);

    expect(spans.map((span) => sql.slice(span.start, span.end))).toEqual(["users", "audit_log"]);
  });

  it("does not treat MERGE branch UPDATE as a table introducer", () => {
    const sql = "MERGE INTO target_table t USING source_table s ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.name = s.name;";
    const spans = sqlSemanticTableNameSpans(sql);
    const model = buildSqlSemanticModel(sql, sql.length - 1);

    expect(spans.map((span) => sql.slice(span.start, span.end))).toEqual(["target_table", "source_table"]);
    expect(model.rowSources.some((source) => source.name.toLowerCase() === "set")).toBe(false);
  });

  it("keeps CTE UPDATE mutation targets", () => {
    const sql = "WITH candidates AS (SELECT id FROM staging) UPDATE users SET active = 1 WHERE id IN (SELECT id FROM candidates);";
    const spans = sqlSemanticTableNameSpans(sql);
    const model = buildSqlSemanticModel(sql, sql.length - 1);

    expect(spans.map((span) => sql.slice(span.start, span.end))).toEqual(["staging", "users", "candidates"]);
    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "users", kind: "mutation_target" })]));
  });
});
