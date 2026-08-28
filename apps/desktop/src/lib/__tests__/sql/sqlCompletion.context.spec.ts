import { describe, expect, it } from "vitest";
import { buildSelectStarExpansion, buildSqlCompletionItems, getSqlCompletionContext, selectStarResultColumnsMatch, shouldAutoOpenSqlCompletion } from "@/lib/sql/sqlCompletion";
import { sqlCompletionContextFromSemantic } from "@/lib/sql/semantic/completion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";

describe("sqlCompletion keyword snippets", () => {
  it("auto-opens and suggests SELECT when typing sel", () => {
    const sql = "sel";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [],
      columnsByTable: new Map(),
    });

    expect(shouldAutoOpenSqlCompletion(sql, sql.length)).toBe(true);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "select *", type: "snippet" }), expect.objectContaining({ label: "SELECT", type: "keyword" })]));
  });
});

describe("SELECT star expansion", () => {
  it("reuses completion column ordering for an unqualified star", () => {
    const sql = "SELECT * FROM apis";
    const context = getSqlCompletionContext(sql, "SELECT *".length);

    expect(
      buildSelectStarExpansion(
        context,
        new Map([
          [
            "apis",
            [
              { name: "id", table: "apis" },
              { name: "created_at", table: "apis" },
              { name: "method", table: "apis" },
            ],
          ],
        ]),
      ),
    ).toBe("id, created_at, method");
  });

  it("preserves an alias while replacing only the star", () => {
    const sql = "SELECT ap.* FROM apis AS ap";
    const cursor = "SELECT ap.*".length;
    const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, cursor), getSqlCompletionContext(sql, cursor));

    expect(
      buildSelectStarExpansion(
        context,
        new Map([
          [
            "apis",
            [
              { name: "id", table: "apis" },
              { name: "created_at", table: "apis" },
            ],
          ],
        ]),
      ),
    ).toBe("id, ap.created_at");
  });

  it.each([
    ["postgres", "postgres", '"Order Alias"', '"created at"'],
    ["opengauss", "postgres", '"Order Alias"', '"created at"'],
  ] as const)("preserves a quoted %s alias for every expanded column", (databaseType, dialect, qualifierSql, quotedColumn) => {
    const sql = `SELECT ${qualifierSql}.* FROM orders AS ${qualifierSql}`;
    const cursor = sql.indexOf("*") + 1;
    const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, cursor, { databaseType, dialect }), getSqlCompletionContext(sql, cursor, { databaseType, dialect }));

    expect(
      buildSelectStarExpansion(
        context,
        new Map([
          [
            "orders",
            [
              { name: "id", table: "orders" },
              { name: "created at", table: "orders" },
            ],
          ],
        ]),
        dialect,
        qualifierSql,
        databaseType,
      ),
    ).toBe(`id, ${qualifierSql}.${quotedColumn}`);
  });

  it("expands an unqualified star from result columns when the table has an alias", () => {
    const sql = "select *\nfrom apis as ap\nlimit 100;";
    const cursor = "select *".length;
    const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, cursor), getSqlCompletionContext(sql, cursor));

    expect(
      buildSelectStarExpansion(
        context,
        new Map([
          [
            "apis",
            [
              { name: "id", table: "apis" },
              { name: "created_at", table: "apis" },
              { name: "updated_at", table: "apis" },
              { name: "deleted_at", table: "apis" },
              { name: "method", table: "apis" },
            ],
          ],
        ]),
      ),
    ).toBe("id, created_at, updated_at, deleted_at, method");
  });

  it("accepts result columns only when their source still contains the target star", () => {
    const currentSql = "select * from apis;\nselect * from users;";
    const sourceStatement = "select * from users";
    const sourceFrom = currentSql.lastIndexOf("select");
    const targetFrom = currentSql.lastIndexOf("*");

    expect(selectStarResultColumnsMatch({ currentSql, targetFrom, targetTo: targetFrom + 1, statementSql: sourceStatement, sourceStatement, sourceFrom, sourceTo: sourceFrom + sourceStatement.length })).toBe(true);
    expect(selectStarResultColumnsMatch({ currentSql, targetFrom: currentSql.indexOf("*"), targetTo: currentSql.indexOf("*") + 1, statementSql: "select * from apis", sourceStatement, sourceFrom, sourceTo: sourceFrom + sourceStatement.length })).toBe(false);
  });

  it("rejects stale and incomplete result source metadata", () => {
    expect(selectStarResultColumnsMatch({ currentSql: "select * from users", targetFrom: 7, targetTo: 8, statementSql: "select * from users", sourceStatement: "select * from apis" })).toBe(false);
    expect(selectStarResultColumnsMatch({ currentSql: "select * from users", targetFrom: 7, targetTo: 8, statementSql: "select * from users", sourceStatement: "select * from users", sourceFrom: 0 })).toBe(false);
  });
});

describe("sqlCompletion quoted schema qualifiers", () => {
  it("parses quoted PostgreSQL schema names before a dot", () => {
    const sql = 'SELECT *\nFROM "order-management".';
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.qualifier).toBe("order-management");
    expect(context.prefix).toBe("");
    expect(context.suggestTables).toBe(true);
    expect(context.exclusiveColumnSuggestions).toBe(false);
  });

  it("suggests tables after a quoted schema qualifier", () => {
    const sql = 'SELECT *\nFROM "order-management".';
    const items = buildSqlCompletionItems(sql, sql.length, {
      dialect: "postgres",
      tables: [
        { name: "orders", schema: "order-management", type: "table" },
        { name: "shipments", schema: "order-management", type: "table" },
      ],
      columnsByTable: new Map(),
    });

    expect(items.some((item) => item.label === "orders" && item.type === "table")).toBe(true);
    expect(items.some((item) => item.label === "shipments" && item.type === "table")).toBe(true);
  });
});

describe("sqlCompletion table targets", () => {
  it("does not suggest aliases while completing an empty FROM target before LIMIT", () => {
    const sql = "SELECT *\nFROM \nLIMIT 100;";
    const cursor = "SELECT *\nFROM ".length;
    const items = buildSqlCompletionItems(sql, cursor, {
      tables: [{ name: "users", type: "table" }],
      columnsByTable: new Map(),
    });

    expect(items.some((item) => item.type === "snippet" && item.detail === "alias for LIMIT")).toBe(false);
    expect(items.some((item) => item.type === "table" && item.label === "users")).toBe(true);
  });
});

describe("sqlCompletion table aliases", () => {
  it("uses initials from all words for generated aliases", () => {
    const sql = "SELECT * FROM mat";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "materials_order_item", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "materials_order_item" && item.type === "table");
    expect(table?.apply).toBe("materials_order_item AS moi");
  });

  it("uses every word initial for longer multi-word names", () => {
    const sql = "SELECT * FROM sup";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "super_long_customer_order_history_archive_snapshot_daily_replica", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "super_long_customer_order_history_archive_snapshot_daily_replica" && item.type === "table");
    expect(table?.apply).toBe("super_long_customer_order_history_archive_snapshot_daily_replica AS slcohasdr");
  });

  it("applies generated aliases to table completions when enabled", () => {
    const sql = "SELECT * FROM ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items AS oi");
  });

  it("keeps plain table completions when generated aliases are disabled", () => {
    const sql = "SELECT * FROM ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: false,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items");
  });

  it("uses a numbered alias when the generated table alias already exists", () => {
    const sql = "SELECT * FROM order_items oi JOIN ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items AS oi2");
  });

  it("applies generated aliases in comma-separated FROM table lists", () => {
    const sql = "SELECT * FROM users u, ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items AS oi");
  });

  it("does not apply generated aliases to non-query table completions", () => {
    const sql = "INSERT INTO ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items");
  });
});

describe("sqlCompletion scoped context classification", () => {
  it("classifies JOIN table contexts", () => {
    const sql = "SELECT * FROM users u JOIN ";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("join");
    expect(context.suggestTables).toBe(true);
    expect(context.exclusiveTableSuggestions).toBe(true);
  });

  it("classifies alias-qualified column contexts", () => {
    const sql = "SELECT * FROM users u WHERE u.";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("alias_column");
    expect(context.qualifier).toBe("u");
    expect(context.suggestColumns).toBe(true);
  });

  it("keeps alias-qualified column context after select-list subqueries", () => {
    const sql = `
      SELECT
        p.id,
        p.create_user_name 'creator',
        (SELECT t."code" FROM sys_user t WHERE t.user_id = p.apply_user_id) 'creator_code',
        p.
      FROM sys_process p
      LIMIT 10
    `;
    const cursor = sql.indexOf("p.\n      FROM");
    const context = getSqlCompletionContext(sql, cursor + 2);

    expect(context.contextKind).toBe("alias_column");
    expect(context.qualifier).toBe("p");
    expect(context.suggestTables).toBe(false);
    expect(context.exclusiveTableSuggestions).toBe(false);
    expect(context.suggestColumns).toBe(true);
  });

  it("suggests alias columns after select-list subqueries instead of tables", () => {
    const sql = `
      SELECT
        p.id,
        p.create_user_name 'creator',
        (SELECT t."code" FROM sys_user t WHERE t.user_id = p.apply_user_id) 'creator_code',
        p.
      FROM sys_process p
      LIMIT 10
    `;
    const cursor = sql.indexOf("p.\n      FROM") + 2;
    const items = buildSqlCompletionItems(sql, cursor, {
      dialect: "postgres",
      tables: [
        { name: "act_evt_log", type: "table" },
        { name: "sys_process", type: "table" },
        { name: "sys_user", type: "table" },
      ],
      columnsByTable: new Map([
        [
          "sys_process",
          [
            { name: "id", table: "sys_process" },
            { name: "create_user_name", table: "sys_process" },
            { name: "apply_user_id", table: "sys_process" },
          ],
        ],
        ["sys_user", [{ name: "code", table: "sys_user" }]],
      ]),
    });

    const columnLabels = items.filter((item) => item.type === "column").map((item) => item.label);
    expect(columnLabels).toEqual(expect.arrayContaining(["id", "create_user_name", "apply_user_id"]));
    expect(items[0]?.type).toBe("column");
    expect(items.some((item) => item.type === "table")).toBe(false);
    expect(items.some((item) => item.type === "keyword")).toBe(false);
  });

  it("classifies unqualified WHERE field input as column context", () => {
    const sql = "SELECT * FROM A1User WHERE userc";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("column");
    expect(context.prefix).toBe("userc");
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "A1User" })]));
    expect(context.suggestColumns).toBe(true);
    expect(context.suggestRoutines).toBe(true);
  });

  it("auto-opens column completion after WHERE whitespace before LIMIT", () => {
    const sql = "SELECT *\nFROM t_0001 AS t0 WHERE \nLIMIT 100;";
    const cursor = "SELECT *\nFROM t_0001 AS t0 WHERE ".length;
    const context = getSqlCompletionContext(sql, cursor);

    expect(context.contextKind).toBe("column");
    expect(context.prefix).toBe("");
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "t_0001", alias: "t0" })]));
    expect(context.suggestColumns).toBe(true);
    expect(shouldAutoOpenSqlCompletion(sql, cursor)).toBe(true);
  });

  it("classifies CALL routine contexts", () => {
    const sql = "CALL usp_";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("exec");
    expect(context.suggestRoutines).toBe(true);
    expect(context.exclusiveRoutineSuggestions).toBe(true);
  });

  it("classifies INSERT column-list contexts", () => {
    const sql = "INSERT INTO dbo.Users (";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("column");
    expect(context.insertSchema).toBe("dbo");
    expect(context.insertTable).toBe("Users");
    expect(context.exclusiveColumnSuggestions).toBe(true);
  });

  it("classifies UPDATE SET column contexts", () => {
    const sql = "UPDATE dbo.Users SET ";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("column");
    expect(context.updateTarget).toEqual({ schema: "dbo", table: "Users" });
    expect(context.suggestColumns).toBe(true);
  });

  it("extracts statement-local table aliases", () => {
    const sql = "SELECT * FROM dbo.Users u JOIN Orders AS o ON o.user_id = u.id WHERE u.";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ schema: "dbo", name: "Users", alias: "u" }), expect.objectContaining({ name: "Orders", alias: "o" })]));
  });

  it("treats schema-qualified table prefixes in FROM as table completion input", () => {
    const sql = "SELECT * FROM dws_game_sdk_base.di";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.qualifier).toBe("dws_game_sdk_base");
    expect(context.prefix).toBe("di");
    expect(context.suggestTables).toBe(true);
    expect(context.exclusiveTableSuggestions).toBe(true);
    expect(context.suggestColumns).toBe(true);
  });

  it("exposes CTEs as table-like referenced tables", () => {
    const sql = "WITH recent_orders(id, total) AS (SELECT id, total FROM orders) SELECT * FROM recent_orders ro WHERE ro.";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "recent_orders", columns: ["id", "total"] }), expect.objectContaining({ name: "recent_orders", alias: "ro" })]));
  });

  it("extracts subquery aliases and projected columns", () => {
    const sql = "SELECT * FROM (SELECT id, name AS user_name FROM users) sq WHERE sq.";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "sq", alias: "sq", columns: ["id", "user_name"] })]));
  });
});

describe("sqlCompletion scoped metadata ranking", () => {
  it("ranks exact and prefix table matches ahead of contains/fuzzy matches", () => {
    const sql = "SELECT * FROM Temp";
    const items = buildSqlCompletionItems(sql, sql.length, {
      dialect: "postgres",
      tables: [
        { name: "ArchiveTempTable", schema: "public", type: "table" },
        { name: "TempAudit", schema: "public", type: "table" },
        { name: "Temp", schema: "public", type: "table" },
        { name: "Template", schema: "public", type: "table" },
      ],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(items.map((item) => item.label).slice(0, 3)).toEqual(["Temp", "Template", "TempAudit"]);
    expect(items.some((item) => item.label === "ArchiveTempTable")).toBe(true);
  });

  it("keeps large table catalogs bounded", () => {
    const tables = Array.from({ length: 500 }, (_, index) => ({ name: `TempTable_${String(index).padStart(3, "0")}`, schema: "public", type: "table" as const }));
    const sql = "SELECT * FROM Temp";
    const items = buildSqlCompletionItems(sql, sql.length, { dialect: "postgres", tables, columnsByTable: new Map() }).filter((item) => item.type === "table");

    expect(items.length).toBeLessThanOrEqual(200);
    expect(items[0]?.label).toBe("TempTable_000");
  });

  it("qualifies same-name PostgreSQL tables from different schemas", () => {
    const sql = "SELECT * FROM shared";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "postgres",
      dialect: "postgres",
      tables: [
        { name: "shared", schema: "public", type: "table" },
        { name: "shared", schema: "reporting", type: "table" },
      ],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.apply).sort()).toEqual(["public.shared", "reporting.shared"]);
  });

  it("qualifies same-name tables for generic metadata providers", () => {
    const sql = "SELECT * FROM orders";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [
        { name: "orders", schema: "archive", type: "table" },
        { name: "orders", schema: "sales", type: "table" },
      ],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(items.map((item) => item.apply).sort()).toEqual(["archive.orders", "sales.orders"]);
  });
});
