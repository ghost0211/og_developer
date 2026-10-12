import { describe, expect, it } from "vitest";
import { formatSqlText } from "@/lib/sql/sqlFormatter";
import { alignSqlKeywords } from "@/lib/sql/sqlKeywordAlignment";

const screenshotSql = `select t1.domain_code, t1.datatype_name, t1.suffix_code, t2.physical_type_code
from ddd.ldm_datatype t1 join ddd.pdm_typemapping t2 on t1.datatype_id=t2.datatype_id
where t1.delete_flag=0 and t2.delete_flag=0 and (t1.suffix_code like 'txt' or t2.physical_type_code='text');`;
const leftScreenshot = [
  "select",
  "  t1.domain_code,",
  "  t1.datatype_name,",
  "  t1.suffix_code,",
  "  t2.physical_type_code",
  "from ddd.ldm_datatype t1",
  "join ddd.pdm_typemapping t2 on t1.datatype_id = t2.datatype_id",
  "where t1.delete_flag = 0",
  "and t2.delete_flag = 0",
  "and (t1.suffix_code like 'txt'",
  "or t2.physical_type_code = 'text');",
].join("\n");
const rightScreenshot = [
  "select t1.domain_code,",
  "       t1.datatype_name,",
  "       t1.suffix_code,",
  "       t2.physical_type_code",
  "  from ddd.ldm_datatype t1",
  "  join ddd.pdm_typemapping t2 on t1.datatype_id = t2.datatype_id",
  " where t1.delete_flag = 0",
  "   and t2.delete_flag = 0",
  "   and (t1.suffix_code like 'txt'",
  "    or t2.physical_type_code = 'text');",
].join("\n");

function format(sql: string, keywordAlignment: "left" | "right", extra = {}) {
  return formatSqlText(sql, "postgres", { keywordCase: "lower", keywordAlignment, ...extra });
}

describe("SQL whole-query keyword alignment", () => {
  it("matches screenshot 1: all keywords left, SELECT fields newline/indented", async () => {
    expect(await format(screenshotSql, "left")).toBe(leftScreenshot);
  });
  it("matches screenshot 2: actual longest keyword column, first SELECT field inline", async () => {
    expect(await format(screenshotSql, "right")).toBe(rightScreenshot);
  });
  it.each([
    ["tabularLeft", leftScreenshot],
    ["tabularRight", rightScreenshot],
  ] as const)("repairs the user's legacy %s setting with default keyword alignment", async (indentStyle, expected) => {
    for (const keywordAlignment of [undefined, "none"] as const) {
      const output = await formatSqlText(leftScreenshot, "postgres", { keywordCase: "lower", indentStyle, keywordAlignment, clauseInline: true });
      expect(output).toBe(expected);
      expect(output.startsWith("select")).toBe(true);
      expect(output).not.toMatch(/^(?:from|join|where|and|or) {2,}/m);
    }
  });
  it("legacy right alignment leaves the actual longest composite keyword at column zero", async () => {
    const output = await formatSqlText("select a,b from t1 left outer join t2 on t1.id=t2.id where a=1;", "postgres", { keywordCase: "lower", indentStyle: "tabularRight", keywordAlignment: "none" });
    expect(output).toContain("\nleft outer join t2 on t1.id = t2.id\n");
    expect(output).not.toMatch(/^ +left outer join/m);
  });
  it.each(["left", "right"] as const)("is idempotent for screenshot mode %s", async (mode) => {
    const first = await format(screenshotSql, mode);
    expect(await format(first, mode)).toBe(first);
  });
  it("treats a long composite JOIN as a single keyword, not only LEFT", async () => {
    const sql = "select a,b from t1 left outer join t2 on t1.id=t2.id where a=1 order by b;";
    expect(await format(sql, "right")).toBe(["         select a,", "                b", "           from t1", "left outer join t2 on t1.id = t2.id", "          where a = 1", "       order by b;"].join("\n"));
  });
  it("aligns GROUP BY/HAVING/ORDER BY and condition operators in left mode", async () => {
    expect(await format("select a,count(*) from t where a=1 or a=2 group by a having count(*)>1 and count(*)<10 order by a limit 5;", "left")).toBe(
      ["select", "  a,", "  count(*)", "from t", "where a = 1", "or a = 2", "group by a", "having count(*) > 1", "and count(*) < 10", "order by a", "limit 5;"].join("\n"),
    );
  });
  it("nested SELECTs have their own width and level, independent of outer long JOIN", async () => {
    expect(await format("select a from t1 left outer join (select x,y from t2 where x=1 or y=2) s on s.x=t1.x where a=1;", "right")).toBe(
      ["         select a", "           from t1", "left outer join (", "  select x,", "         y", "    from t2", "   where x = 1", "      or y = 2", ") s on s.x = t1.x", "          where a = 1;"].join("\n"),
    );
  });
  it("anchors right-aligned nested query bodies and closing parens to the padded opening keyword", async () => {
    expect(await format("select a from (select x,y from t2) s where a=1;", "right")).toBe(["select a", "  from (", "    select x,", "           y", "      from t2", "  ) s", " where a = 1;"].join("\n"));
    expect(await format("select a from t1 join (select x from t2) s on s.x=t1.x where a=1;", "right")).toBe(["select a", "  from t1", "  join (", "    select x", "      from t2", "  ) s on s.x = t1.x", " where a = 1;"].join("\n"));
  });
  it("aligns inner keywords in derived, scalar and EXISTS subqueries", async () => {
    const sql = "select a,(select b from t2 where b>1) b from (select c from t3 join t4 on t3.id=t4.id where x=1 and y=2) s where exists (select d from t5 where z=1 or z=2);";
    expect(await format(sql, "left")).toBe(
      [
        "select",
        "  a,",
        "  (",
        "    select",
        "      b",
        "    from t2",
        "    where b > 1",
        "  ) b",
        "from (",
        "  select",
        "    c",
        "  from t3",
        "  join t4 on t3.id = t4.id",
        "  where x = 1",
        "  and y = 2",
        ") s",
        "where exists (",
        "  select",
        "    d",
        "  from t5",
        "  where z = 1",
        "  or z = 2",
        ");",
      ].join("\n"),
    );
  });
  it("keeps CTE and UNION branches independently aligned", async () => {
    const output = await format("with x as (select a,b from t where a=1) select a from x union all select a,b from t2 where b=2;", "right");
    expect(output).toContain("     with x as (\n       select a,\n              b\n         from t\n        where a = 1\n     )");
    expect(output).toContain("   select a\n     from x\nunion all\nselect a,\n       b\n  from t2\n where b = 2;");
  });
  it("separate statements do not inherit keyword widths", async () => {
    const output = await format("select a from t1 left outer join t2 on t1.id=t2.id; select a,b from t;", "right");
    expect(output).toContain("left outer join t2 on t1.id = t2.id;");
    expect(output).toContain("\n\nselect a,\n       b\n  from t;");
  });
  it.each(["left", "right"] as const)("keeps complex query formatting idempotent in %s mode", async (mode) => {
    const cases = [
      "select a,(select b from t2 where b>1) b from (select c from t3 where x=1 and y=2) s where exists (select d from t5 where z=1 or z=2);",
      "with x as (select a,b from t where a=1), y as (select c from t2) select x.a,y.c from x join y on x.a=y.c union all select a,c from q;",
      "select a from t1 left outer join t2 on t1.id=t2.id and (t2.x=1 or t2.y=2) where (a=1 and (b=2 or c=3)) group by a having count(*)>1 order by a;",
      "select case when a=1 and b=2 then (select c from t2 where (x=1 or y=2)) else null end as x,sum(v) over (partition by a order by b) from t where x=1;",
    ];
    for (const sql of cases) {
      const first = await format(sql, mode);
      expect(await format(first, mode)).toBe(first);
    }
  });
  it("aligns a subquery inside CASE without flattening the surrounding CASE condition", async () => {
    const output = await format("select case when a=1 and b=2 then (select c from t2 where (x=1 or y=2)) else null end as x from t;", "left");
    expect(output).toContain("    and b = 2 then (");
    expect(output).toContain("      select\n        c\n      from t2\n      where (x = 1\n      or y = 2)");
    expect(output).toContain("  end as x\nfrom t;");
  });
  it("AND in BETWEEN and CASE conditions is not a clause-level alignment keyword", async () => {
    const output = await format("select case when a=1 and b=2 then 'yes' else 'no' end as x,count(*) from t where a between 1 and 2 and x is not null;", "left");
    expect(output).toBe(["select", "  case", "    when a = 1", "    and b = 2 then 'yes'", "    else 'no'", "  end as x,", "  count(*)", "from t", "where a between 1 and 2", "and x is not null;"].join("\n"));
  });
  it.each(["left", "right"] as const)("preserves multiline literals and quoted identifier bytes in %s mode", async (mode) => {
    const literal = "'one\nfrom\n  join something\nwhere\n  and x\nthree'";
    const dollar = "$body$one\nselect\n  from\njoin\n  or$body$";
    const escaped = "E'one\\\'\nfrom\n  join t\nend'";
    const quoted = '"from\n  where\njoin"';
    const sql = `select ${literal} as s,${dollar} as d,${escaped} as e,${quoted} from t where a=1 and b=2;`;
    const output = await format(sql, mode);
    for (const text of [literal, dollar, escaped, quoted]) expect(output).toContain(text);
  });
  it("does not merge through comments or let a line comment swallow closing parentheses", async () => {
    const sql = "select a,b from\n-- from comment\nt where (a=1 and b=2 -- predicate\n or c=3 -- keep paren below\n);";
    const output = await format(sql, "left");
    expect(output).toContain("-- from comment\n");
    expect(output).toContain("-- predicate\n");
    expect(output).toContain("-- keep paren below\n");
    expect(output).toMatch(/-- keep paren below\n\s*\);/);
    expect(await format(output, "left")).toBe(output);
  });
  it("never treats keyword-like lines in multiline comments as clauses", async () => {
    const comment = "/* guard\nfrom\n  join x\nwhere\n  and y\n*/";
    const standard = ["select", "  a", comment, "from", "  t", "where", "  a = 1", "  and b = 2;"].join("\n");
    const output = alignSqlKeywords(standard, "left", {}, "postgres");
    expect(output).toContain(comment);
    expect(output).toContain("where a = 1\nand b = 2;");
  });
  it("protects nested block comment content and MySQL escapes in the alignment pass", () => {
    const comment = "/* outer\n /* nested */\nfrom\n join t\n*/";
    const sql = `select\n  a\n${comment}\nfrom\n  t\nwhere\n  a = 1\n  and b = 2;`;
    expect(alignSqlKeywords(sql, "left", {}, "postgres")).toContain(comment);
    const mysqlLiteral = "'a\\'\nfrom\n join q\nwhere\\\\end'";
    const mysql = `select\n  ${mysqlLiteral} as x\nfrom\n  t\nwhere\n  a = 1\n  and b = 2;`;
    expect(alignSqlKeywords(mysql, "right", {}, "mysql")).toContain(mysqlLiteral);
  });
  it("preserves CRLF line boundaries during clause/boolean merges, including literal bytes", () => {
    const input = ["select", "  a,", "  b", "from", "  t", "where", "  (", "    a = 1", "    or b = 2", "  );", ""].join("\r\n");
    expect(alignSqlKeywords(input, "right", {}, "postgres")).toBe(["select a,", "       b", "  from t", " where (a = 1", "    or b = 2);", ""].join("\r\n"));
    const literal = "'first\r\nfrom\r\n join q\r\nlast'";
    const withLiteral = ["select", `  ${literal} as x`, "from", "  t", "where", "  a = 1", "  and b = 2;"].join("\r\n");
    expect(alignSqlKeywords(withLiteral, "left", {}, "postgres")).toContain(literal);
    expect(alignSqlKeywords(withLiteral, "left", {}, "postgres")).toContain("where a = 1\r\nand b = 2;");
  });
  it("protects ClickHouse backslash-escaped quotes before keyword-like literal lines", async () => {
    const literal = "'Don\\'t change\nfrom\n join q\nwhere\n  or x'";
    const output = await formatSqlText(`select ${literal} as x from t where a=1 and b=2;`, "clickhouse", { keywordCase: "lower", keywordAlignment: "left" });
    expect(output).toContain(literal);
    expect(output).toContain("from t\nwhere a = 1\nand b = 2;");
  });
  it("honors sql-formatter disabled regions verbatim", async () => {
    const sql = "/* sql-formatter-disable */\nselect a,b from t where x=1 and y=2;\n/* sql-formatter-enable */";
    expect(await format(sql, "left")).toBe(sql);
    expect(await format(sql, "right")).toBe(sql);
  });
  it("tabs/4-space SELECT indentation work; right keyword padding remains spaces", async () => {
    expect(await format("select a,b from t where a=1 and b=2;", "left", { useTabs: true })).toBe("select\n\ta,\n\tb\nfrom t\nwhere a = 1\nand b = 2;");
    expect(await format("select a,b from t;", "left", { tabWidth: 4 })).toBe("select\n    a,\n    b\nfrom t;");
    expect(await format("select a,b from t;", "right", { useTabs: true })).toBe("select a,\n       b\n  from t;");
  });
  it.each(["left", "right"] as const)("does not restyle a non-SELECT statement just because it starts with WITH in %s mode", async (mode) => {
    const sql = "with x as (values (1)) update t set a=2 where a=1 and b=2;";
    const standard = await formatSqlText(sql, "postgres", { keywordCase: "lower" });
    expect(await format(sql, mode)).toBe(standard);
    const cte = "with x as (select a from t1 where a=1) update t2 set a=2 where a=1 and b=2;";
    const baseline = await formatSqlText(cte, "postgres", { keywordCase: "lower" });
    const output = await format(cte, mode);
    expect(output.slice(output.indexOf("update"))).toBe(baseline.slice(baseline.indexOf("update")));
  });
  it("active alignment overrides tabular style/after-newline and clause toggles", async () => {
    expect(await format(screenshotSql, "left", { indentStyle: "tabularRight", logicalOperatorNewline: "after", clauseInline: false })).toBe(leftScreenshot);
  });
  it("preserves keyword case and SELECT DISTINCT modifiers", async () => {
    expect(await format("select distinct a,b from t where a=1 and b=2;", "left", { keywordCase: "upper" })).toBe("SELECT DISTINCT\n  a,\n  b\nFROM t\nWHERE a = 1\nAND b = 2;");
  });
  it.each(["mysql", "sqlite", "sqlserver", "clickhouse", "generic"] as const)("formats the basic query for %s", async (dialect) => {
    expect(await formatSqlText("select a,b from t where a=1 and b=2;", dialect, { keywordCase: "lower", keywordAlignment: "left" })).toBe("select\n  a,\n  b\nfrom t\nwhere a = 1\nand b = 2;");
  });
});
