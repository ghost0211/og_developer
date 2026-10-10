import { describe, expect, it } from "vitest";
import { formatSqlForDisplay, formatSqlText, inlineClauseContents, MAX_SQL_FORMAT_CHARS, sqlFormatDialectForDbType, UnsupportedStructuredInputError } from "@/lib/sql/sqlFormatter";

describe("sqlFormatter", () => {
  it("maps PostgreSQL-compatible database types to the postgres formatter dialect", () => {
    for (const dbType of ["postgres", "kwdb", "gaussdb", "opengauss", "questdb", "kingbase", "highgo", "vastbase", "redshift"]) {
      expect(sqlFormatDialectForDbType(dbType)).toBe("postgres");
    }
  });

  it("maps SQLite-compatible database types to the sqlite formatter dialect", () => {
    for (const dbType of ["sqlite", "rqlite", "turso", "cloudflare-d1"]) {
      expect(sqlFormatDialectForDbType(dbType)).toBe("sqlite");
    }
  });

  it("preserves ClickHouse lambda arrows when formatting issue #3573 SQL", async () => {
    const sql = `
      WITH industry_code_donghua_id_RYCzfD AS (SELECT id
      FROM cd.industry_code_donghua
      WHERE cd.industry_code_donghua.code IN ('INB0709', 'INB0004'))
      SELECT id,ent_short,arrayMap(x->dictGet(cd.industry_donghua_dict,'name',x),prefer_industry) as prefer_industry_name,org_type,company_id,arrayCount(\`investment.be_company_id\` -> 1, \`investment.be_company_id\`) as be_company_count
      FROM search_donghua.investor
      WHERE arrayExists(x -> x IN industry_code_donghua_id_RYCzfD, prefer_industry)
      ORDER BY be_company_count DESC,id ASC
      LIMIT 0,10
    `;

    const formatted = await formatSqlText(sql, sqlFormatDialectForDbType("clickhouse"));

    expect(formatted).toContain("x -> dictGet");
    expect(formatted).not.toContain("- >");
  });
  it("preserves DBX brace placeholders in generic and MySQL SQL", async () => {
    const sql = "SELECT ${x} AS shell_value, #{x} AS mybatis_value, '${date}' AS quoted_value";

    for (const dialect of ["generic", "mysql"] as const) {
      const formatted = await formatSqlText(sql, dialect);

      expect(formatted).toContain("${x}");
      expect(formatted).toContain("#{x}");
      expect(formatted).toContain("'${date}'");
    }
  });

  it("falls back to the postgres formatter when the generic dialect cannot parse SQL", async () => {
    const formatted = await formatSqlText("SELECT 1::int AS id;", "generic");

    expect(formatted).toContain("1::int");
    expect(formatted).toContain("AS id");
  });

  it("keeps FROM/WHERE on their own lines by default", async () => {
    const formatted = await formatSqlText("select a from t1 where a = 1;", "postgres");

    expect(formatted).toMatch(/FROM\n {2}t1/);
    expect(formatted).toMatch(/WHERE\n {2}a = 1;/);
  });

  it("inlines FROM/WHERE content when clauseInline is enabled", async () => {
    const sql = "select t1.domain_code, t1.datatype_name from ddd.ldm_datatype t1 join ddd.pdm_typemapping t2 on t1.datatype_id = t2.datatype_id where suffix_code = '_code';";

    const formatted = await formatSqlText(sql, "postgres", { keywordCase: "lower", clauseInline: true });

    expect(formatted).toBe(["select", "  t1.domain_code,", "  t1.datatype_name", "from ddd.ldm_datatype t1", "  join ddd.pdm_typemapping t2 on t1.datatype_id = t2.datatype_id", "where suffix_code = '_code';"].join("\n"));
  });

  it("inlines clauses inside subqueries at every nesting depth", async () => {
    const sql = "select x from (select y from (select z from t3 where z > 0) t2 where y > 1) t1 where x > 2;";

    const formatted = await formatSqlText(sql, "postgres", { keywordCase: "lower", clauseInline: true });

    expect(formatted).toBe(["select", "  x", "from", "  (", "    select", "      y", "    from", "      (", "        select", "          z", "        from t3", "        where z > 0", "      ) t2", "    where y > 1", "  ) t1", "where x > 2;"].join("\n"));
  });

  it("never merges a keyword into a multi-line parenthesized group, but merges one that closes inline", async () => {
    // Derived tables / grouped conditions stay structurally intact...
    const derived = await formatSqlText("select a from (select 1 as a) s where (a = 1 or b = 2);", "postgres", { keywordCase: "lower", clauseInline: true });
    expect(derived).toMatch(/from\n {2}\(\n {4}select/);
    expect(derived).toMatch(/where\n {2}\(\n {4}a = 1/);

    // ...while a parenthesized group that fits on one line still inlines.
    const singleLine = await formatSqlText("select a from t where (a = 1);", "postgres", { keywordCase: "lower", clauseInline: true });
    expect(singleLine).toContain("where (a = 1);");
  });

  it("preserves AND/OR newline placement around inlined WHERE content", async () => {
    const sql = "select a from t where a = 1 and b = 2 or c = 3;";

    const formatted = await formatSqlText(sql, "postgres", { keywordCase: "lower", clauseInline: true, logicalOperatorNewline: "before" });

    expect(formatted).toContain("where a = 1");
    expect(formatted).toMatch(/\n {2}and b = 2/);
    expect(formatted).toMatch(/\n {2}or c = 3/);
  });

  it("does not merge a line comment between the keyword and its content", async () => {
    const formatted = await formatSqlText("select a\nfrom\n-- pick source table\napp.t1\nwhere x = 1;", "postgres", { keywordCase: "lower", clauseInline: true });

    expect(formatted).toMatch(/from\n {2}-- pick source table\n {2}app\.t1/);
    expect(formatted).toContain("where x = 1;");
  });

  it("merges a closed single-line block comment but never an unterminated one", async () => {
    const closed = await formatSqlText("select a from t1 where /* guard */ a = 1;", "postgres", { keywordCase: "lower", clauseInline: true });
    expect(closed).toContain("where /* guard */ a = 1;");

    const unterminated = inlineClauseContents(["select", "  a", "from", "  /* multi", "     line */ t1"].join("\n"), {});
    expect(unterminated).toBe(["select", "  a", "from", "  /* multi", "     line */ t1"].join("\n"));
  });

  it("inlines with tab indentation and keeps deeper-than-one-unit content untouched", async () => {
    const tabbed = inlineClauseContents(["from", "\tddd.t1", "where", "\ta = 1"].join("\n"), { useTabs: true });
    expect(tabbed).toBe(["from ddd.t1", "where a = 1"].join("\n"));

    const tooDeep = inlineClauseContents(["from", "    ddd.t1"].join("\n"), { useTabs: false, tabWidth: 2 });
    expect(tooDeep).toBe(["from", "    ddd.t1"].join("\n"));

    const tabWidth4 = inlineClauseContents(["from", "    ddd.t1"].join("\n"), { useTabs: false, tabWidth: 4 });
    expect(tabWidth4).toBe("from ddd.t1");
  });

  it("is a no-op for tabular indent styles where content is already inline", async () => {
    const sql = "select a from t1 where a = 1;";
    const withoutInline = await formatSqlText(sql, "postgres", { keywordCase: "lower", indentStyle: "tabularLeft" });
    const withInline = await formatSqlText(sql, "postgres", { keywordCase: "lower", indentStyle: "tabularLeft", clauseInline: true });

    expect(withInline).toBe(withoutInline);
    expect(withInline).toContain("from      t1");
  });

  it("keeps keyword case from the formatter output when inlining", async () => {
    const formatted = await formatSqlText("select a from t1 where a = 1;", "postgres", { keywordCase: "upper", clauseInline: true });

    expect(formatted).toContain("FROM t1");
    expect(formatted).toContain("WHERE a = 1;");
  });

  it("aligns JOIN lines with FROM when dedentJoin is enabled", async () => {
    const sql = "select a from t1 join t2 on t1.id = t2.id left join t3 on t2.x = t3.x where a = 1;";

    const formatted = await formatSqlText(sql, "postgres", { keywordCase: "lower", clauseInline: true, dedentJoin: true });

    expect(formatted).toBe(["select", "  a", "from t1", "join t2 on t1.id = t2.id", "left join t3 on t2.x = t3.x", "where a = 1;"].join("\n"));
  });

  it("dedents multi-line ON continuations together with their JOIN", async () => {
    const sql = "select a from t1 join t2 on t1.id = t2.id and t1.tenant_id = t2.tenant_id and t1.version_no = t2.version_no where a = 1;";

    const formatted = await formatSqlText(sql, "postgres", { keywordCase: "lower", clauseInline: true, dedentJoin: true });

    expect(formatted).toBe(["select", "  a", "from t1", "join t2 on t1.id = t2.id", "and t1.tenant_id = t2.tenant_id", "and t1.version_no = t2.version_no", "where a = 1;"].join("\n"));
  });

  it("shifts a join subquery as one block and aligns its inner clauses", async () => {
    const sql = "select a.id from app.accounts a join (select id, name from app.users where status = 'on') s on s.id = a.user_id where a.deleted = 0;";

    const formatted = await formatSqlText(sql, "postgres", { keywordCase: "lower", clauseInline: true, dedentJoin: true });

    expect(formatted).toBe(["select", "  a.id", "from app.accounts a", "join (", "  select", "    id,", "    name", "  from app.users", "  where status = 'on'", ") s on s.id = a.user_id", "where a.deleted = 0;"].join("\n"));
  });

  it("aligns an inner JOIN with its own inner FROM inside a join subquery", async () => {
    const sql = "select a from t1 join (select u.id from u join r on r.uid = u.id where u.x = 1) s on s.id = t1.id where a = 1;";

    const formatted = await formatSqlText(sql, "postgres", { keywordCase: "lower", clauseInline: true, dedentJoin: true });

    expect(formatted).toBe(["select", "  a", "from t1", "join (", "  select", "    u.id", "  from u", "  join r on r.uid = u.id", "  where u.x = 1", ") s on s.id = t1.id", "where a = 1;"].join("\n"));
  });

  it("keeps comma-separated table lists indented and does not treat them as JOINs", async () => {
    const formatted = await formatSqlText("select a from t1, t2 where t1.id = t2.id;", "postgres", { keywordCase: "lower", clauseInline: true, dedentJoin: true });

    expect(formatted).toBe(["select", "  a", "from t1,", "  t2", "where t1.id = t2.id;"].join("\n"));
  });

  it("does not dedent JOINs when clauseInline is off or dedentJoin is off", async () => {
    const sql = "select a from t1 join t2 on t1.id = t2.id where a = 1;";

    const inlineOnly = await formatSqlText(sql, "postgres", { keywordCase: "lower", clauseInline: true });
    expect(inlineOnly).toContain("from t1\n  join t2");

    const joinOnly = await formatSqlText(sql, "postgres", { keywordCase: "lower", dedentJoin: true });
    expect(joinOnly).toContain("from\n  t1\n  join t2");
  });

  it("dedents JOINs with tab indentation", async () => {
    const formatted = await formatSqlText("select a from t1 join t2 on t1.id = t2.id where a = 1;", "postgres", { keywordCase: "lower", clauseInline: true, dedentJoin: true, useTabs: true });

    expect(formatted).toBe(["select", "\ta", "from t1", "join t2 on t1.id = t2.id", "where a = 1;"].join("\n"));
  });

  it("returns the original SQL for display when formatting fails", async () => {
    const oversizedSql = "x".repeat(MAX_SQL_FORMAT_CHARS + 1);

    await expect(formatSqlText(oversizedSql, "postgres")).rejects.toThrow("SQL is too large to format safely.");
    await expect(formatSqlForDisplay(oversizedSql, "postgres")).resolves.toBe(oversizedSql);
  });

  it("refuses to format XML-looking input instead of corrupting it (regression: silent rewrite)", async () => {
    const xml = `<root><item id="1">value</item></root>`;

    // The SQL formatter previously accepted this and rewrote it into corrupted
    // output (`< root > < item id = "1" > ...`). It must now be refused so no
    // caller can ever write sql-formatter output back over the user's text.
    await expect(formatSqlText(xml, "generic")).rejects.toBeInstanceOf(UnsupportedStructuredInputError);
    await expect(formatSqlText(xml, "postgres")).rejects.toBeInstanceOf(UnsupportedStructuredInputError);
  });

  it("still formats selected SQL Server bracket-quoted identifiers", async () => {
    await expect(formatSqlText(`[dbo].[orders]`, "sqlserver")).resolves.toBe(`[dbo].[orders]`);
  });

  it("still formats selected SQL comparison fragments", async () => {
    await expect(formatSqlText(`< 10`, "postgres")).resolves.toBe(`< 10`);
    await expect(formatSqlText(`< 10 AND score > 2`, "postgres")).resolves.toBe(`< 10\nAND score > 2`);
  });

  it("keeps display formatting lossless for XML/JSON-looking input", async () => {
    const xml = `<root><item id="1">value</item></root>`;
    const json = `{"a":1}`;

    await expect(formatSqlForDisplay(xml, "generic")).resolves.toBe(xml);
    await expect(formatSqlForDisplay(json, "generic")).resolves.toBe(json);
  });

  it("still formats genuine SQL that starts with a non-structured token", async () => {
    const formatted = await formatSqlText(`SELECT '{"a":1}'::jsonb AS j FROM t`, "postgres");

    expect(formatted).toContain("SELECT");
    expect(formatted).toContain("::jsonb");
  });
});
