import { describe, expect, it } from "vitest";
import { executionCandidateForMode } from "@/lib/sql/sqlExecutionTarget";
import { buildExecutionCandidates, currentExecutableStatementRange, executableStatementRanges, fullSqlRange, hasMultipleExecutionTargets, splitSqlStatementRanges, statementRangeAtCursor, supportsExecutionTargetPicker } from "@/lib/sql/sqlStatementRanges";

function indexOf(sql: string, needle: string, occurrence = 1): number {
  let from = 0;
  let idx = -1;
  for (let i = 0; i < occurrence; i += 1) {
    idx = sql.indexOf(needle, from);
    if (idx === -1) return -1;
    from = idx + needle.length;
  }
  return idx;
}

function rangeSqlTexts(ranges: Array<{ sql: string }>): string[] {
  return ranges.map((range) => range.sql.trim());
}

function candidateKinds(candidates: Array<{ kind: string }>): string[] {
  return candidates.map((candidate) => candidate.kind);
}

function candidateLabels(candidates: Array<{ label: string }>): string[] {
  return candidates.map((candidate) => candidate.label);
}

function candidateSummaries(candidates: Array<{ kind: string; sql: string }>): string[] {
  return candidates.map((candidate) => `${candidate.kind}:${candidate.sql.trim()}`);
}

const oraclePlSqlFixture = `DECLARE
  v_order_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_order_count
  FROM "DBX_TEST"."ORDERS_10K";

  IF v_order_count = 0 THEN
    INSERT INTO "DBX_TEST"."STORES"
      ("ID", "STORE_CODE", "STORE_NAME", "CITY", "OPENED_AT")
    SELECT 10001, 'TEST_STORE_001', '测试门店', '上海', SYSDATE
    FROM DUAL
    WHERE NOT EXISTS (
      SELECT 1 FROM "DBX_TEST"."STORES" WHERE "ID" = 10001
    );

    INSERT INTO "DBX_TEST"."PRODUCTS"
      ("ID", "SKU", "PRODUCT_NAME", "CATEGORY", "PRICE")
    SELECT 10001, 'TEST_SKU_001', '测试商品', '测试分类', 99.90
    FROM DUAL
    WHERE NOT EXISTS (
      SELECT 1 FROM "DBX_TEST"."PRODUCTS" WHERE "ID" = 10001
    );

    INSERT INTO "DBX_TEST"."ORDERS_10K"
      ("ID", "ORDER_NO", "STORE_ID", "PRODUCT_ID", "CUSTOMER_NAME", "QUANTITY", "AMOUNT", "ORDER_STATUS", "CREATED_AT")
    SELECT 10001, 'TEST_ORDER_001', 10001, 10001, '测试客户', 2, 199.80, 'PAID', SYSDATE
    FROM DUAL
    WHERE NOT EXISTS (
      SELECT 1 FROM "DBX_TEST"."ORDERS_10K" WHERE "ORDER_NO" = 'TEST_ORDER_001'
    );

    COMMIT;
  END IF;
END;
/
SELECT 1;`;

const oracleIssue2405PlSql = `DECLARE
   PRE_TRD_DATE   INTEGER ;
BEGIN
   SELECT 1 + 2 INTO PRE_TRD_DATE FROM DUAL;
END;`;

const gaussDbNestedProcedure = `CREATE OR REPLACE PROCEDURE public.dbx_issue_4318()
AS
BEGIN
  BEGIN
    NULL;
  END;
  NULL;
END;`;

const gaussDbDollarQuotedFunctionScript = `DROP FUNCTION IF EXISTS dbx_issue_4572_tmp_md5_uuid;

CREATE OR REPLACE FUNCTION dbx_issue_4572_tmp_md5_uuid (v_str IN TEXT) RETURNS varchar(36) LANGUAGE PLPGSQL IMMUTABLE AS $function$
DECLARE
    str1 TEXT;
BEGIN
    str1 := md5(v_str);
    RETURN CAST(str1 AS varchar(36));
END$function$;

DROP FUNCTION IF EXISTS dbx_issue_4572_tmp_missing;`;

const gaussDbIssue4573Script = `CREATE OR REPLACE PROCEDURE createIndex (
  dbName IN VARCHAR(32),
  tableName IN VARCHAR(64),
  indexInfo IN VARCHAR(64),
  indexColumns IN VARCHAR(128)
) AS
DECLARE STMT TEXT;

DECLARE flag int;

BEGIN
SELECT
  count(*) INTO flag
FROM
  PG_CATALOG.PG_INDEXES
WHERE
  schemaname = dbName
  AND TABLENAME = tableName
  AND INDEXNAME = indexInfo;

IF flag = 0 THEN STMT := 'CREATE INDEX ' || indexInfo || ' ON ' || dbName || '.' || tableName || '(' || indexColumns || ')';

EXECUTE STMT;

END IF;

END;

SELECT 1 AS after_procedure;
SELECT 2 AS final_statement;`;

describe("splitSqlStatementRanges", () => {
  it("splits multiple top-level statements", () => {
    const sql = "SELECT 1;\nSELECT 2;\nSELECT 3;";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("keeps a trailing statement without a semicolon", () => {
    const sql = "SELECT 1;\nSELECT 2";
    const ranges = splitSqlStatementRanges(sql);
    expect(rangeSqlTexts(ranges)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons inside single-quoted strings", () => {
    const sql = "INSERT INTO t VALUES ('a;b;c');\nSELECT 1";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["INSERT INTO t VALUES ('a;b;c')", "SELECT 1"]);
  });

  it("handles doubled single quotes as escaped quotes", () => {
    const sql = "SELECT 'it''s; ok';\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT 'it''s; ok'", "SELECT 2"]);
  });

  it("ignores semicolons inside double-quoted identifiers", () => {
    const sql = 'SELECT "a;b";\nSELECT 2';
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(['SELECT "a;b"', "SELECT 2"]);
  });

  it("ignores semicolons in line comments", () => {
    const sql = "SELECT 1 -- a; b\n;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps MyBatis placeholders instead of treating them as hash comments", () => {
    const sql = "SELECT * FROM yd_org_decla_detail WHERE clr_ym = #{ym};\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql, "opengauss"))).toEqual(["SELECT * FROM yd_org_decla_detail WHERE clr_ym = #{ym}", "SELECT 2"]);
  });

  it("treats malformed or disabled MyBatis prefixes as hash comments", () => {
    expect(rangeSqlTexts(splitSqlStatementRanges("SELECT 1; #{1ym};\nSELECT 2", "opengauss"))).toEqual(["SELECT 1", "SELECT 2"]);
    expect(rangeSqlTexts(splitSqlStatementRanges("SELECT 1; #{ym};\nSELECT 2", "opengauss", { enabledSyntaxes: ["shell"] }))).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons in block comments", () => {
    const sql = "SELECT /* a; b */ 1;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT /* a; b */ 1", "SELECT 2"]);
  });

  it("handles Postgres dollar quoting", () => {
    const sql = "SELECT $$ a; b $$;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT $$ a; b $$", "SELECT 2"]);
  });

  it("keeps openGauss Oracle-compatible PL/SQL blocks together and treats slash lines as delimiters", () => {
    const ranges = splitSqlStatementRanges(oraclePlSqlFixture, "opengauss");
    expect(rangeSqlTexts(ranges)).toEqual([oraclePlSqlFixture.slice(0, oraclePlSqlFixture.indexOf("\n/")), "SELECT 1"]);
    expect(ranges[0].sql).toContain("v_order_count NUMBER;");
    expect(ranges[0].sql).toContain("END;");
    expect(ranges[0].sql).not.toContain("\n/");
  });

  it("keeps issue #2405 openGauss Oracle-compatible PL/SQL block together without a slash delimiter", () => {
    expect(rangeSqlTexts(splitSqlStatementRanges(oracleIssue2405PlSql, "opengauss"))).toEqual([oracleIssue2405PlSql]);
  });

  it("keeps nested openGauss procedure blocks together", () => {
    expect(rangeSqlTexts(splitSqlStatementRanges(gaussDbNestedProcedure, "opengauss"))).toEqual([gaussDbNestedProcedure]);
  });

  it("keeps an openGauss AS-bodied procedure with inner semicolons as one statement", () => {
    const openGaussProcedure = `CREATE OR REPLACE PROCEDURE estab.checkestabbusinesslicense(
  pRowUuid uuid,
  pSocialCreditCode VARCHAR(60),
  oResultCode out int
)
AS
DECLARE
  v_count INT := 0;
begin
  if pRowUuid is null then
    oResultCode := 0;
    RAISE EXCEPTION 'pRowUuid不能为空!';
  end if;
  SELECT COUNT(1) INTO v_count FROM def_estab WHERE social_credit_code = pSocialCreditCode AND delete_flag = 0 AND row_uuid <> pRowUuid;
  IF v_count > 0 then
    oResultCode := 0;
    RAISE EXCEPTION '统一社会信用代码不允许重复,请检查数据!';
  else
    oResultCode := 1;
  END IF;
END;`;
    expect(rangeSqlTexts(splitSqlStatementRanges(openGaussProcedure, "opengauss"))).toEqual([openGaussProcedure]);
    expect(rangeSqlTexts(splitSqlStatementRanges(`${openGaussProcedure}\n\nSELECT 1`, "opengauss"))).toEqual([openGaussProcedure, "SELECT 1"]);
  });

  it("separates openGauss dollar-quoted functions from surrounding statements", () => {
    const ranges = splitSqlStatementRanges(gaussDbDollarQuotedFunctionScript, "opengauss");
    expect(rangeSqlTexts(ranges)).toEqual([
      "DROP FUNCTION IF EXISTS dbx_issue_4572_tmp_md5_uuid",
      gaussDbDollarQuotedFunctionScript.slice(gaussDbDollarQuotedFunctionScript.indexOf("CREATE"), gaussDbDollarQuotedFunctionScript.lastIndexOf(";\n\nDROP")),
      "DROP FUNCTION IF EXISTS dbx_issue_4572_tmp_missing",
    ]);
  });

  it("separates the issue #4573 openGauss procedure from following statements", () => {
    expect(rangeSqlTexts(splitSqlStatementRanges(gaussDbIssue4573Script, "opengauss"))).toEqual([gaussDbIssue4573Script.slice(0, gaussDbIssue4573Script.indexOf("\n\nSELECT 1")), "SELECT 1 AS after_procedure", "SELECT 2 AS final_statement"]);
  });
});

describe("statementRangeAtCursor", () => {
  it("returns the first statement when the cursor is inside it", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const pos = indexOf(sql, "1");
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("returns the second statement when the cursor is inside it", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const pos = indexOf(sql, "2");
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("returns the statement when the cursor is in indentation before it", () => {
    const sql = "SELECT 1;\n    SELECT 2;";
    const indentationPos = sql.indexOf("    SELECT 2") + 2;
    const range = statementRangeAtCursor(sql, indentationPos);
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("returns the previous statement when the cursor is in same-line whitespace after its semicolon", () => {
    const sql = "SELECT 1;   SELECT 2;";
    const gapPos = sql.indexOf(";") + 2;
    const range = statementRangeAtCursor(sql, gapPos);
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("returns the previous statement when the cursor is just after its semicolon before a later statement", () => {
    const sql = "SELECT *\nFROM system_dept;\n\nSELECT *\nFROM sys;";
    const gapPos = sql.indexOf(";") + 1;
    const range = statementRangeAtCursor(sql, gapPos);
    expect(range?.sql.trim()).toBe("SELECT *\nFROM system_dept");
  });

  it("keeps a semicolon-line-end cursor on the current multi-line statement", () => {
    const sql = "SELECT *\nFROM system_dept;";
    const gapPos = sql.indexOf(";") + 1;
    const range = statementRangeAtCursor(sql, gapPos);
    expect(range?.sql.trim()).toBe("SELECT *\nFROM system_dept");
  });

  it("keeps a standalone next-line semicolon cursor on the current multi-line statement", () => {
    const sql = "SELECT *\nFROM system_dept\n;\n\nSELECT * FROM sys;";
    const delimiterPos = sql.indexOf(";");

    expect(statementRangeAtCursor(sql, delimiterPos)?.sql.trim()).toBe("SELECT *\nFROM system_dept");
    expect(statementRangeAtCursor(sql, delimiterPos + 1)?.sql.trim()).toBe("SELECT *\nFROM system_dept");
  });

  it("assigns a standalone trailing semicolon to the final soft statement", () => {
    const sql = 'SELECT * FROM "t_0001"\nSELECT * FROM "t_0001" LIMIT 1\n;';
    const delimiterPos = sql.lastIndexOf(";");

    expect(statementRangeAtCursor(sql, delimiterPos, "opengauss")?.sql).toBe('SELECT * FROM "t_0001" LIMIT 1');
    expect(statementRangeAtCursor(sql, delimiterPos + 1, "opengauss")?.sql).toBe('SELECT * FROM "t_0001" LIMIT 1');
  });

  it("returns the next same-line statement when the cursor is inside it", () => {
    const sql = "SELECT 1;   SELECT 2;";
    const pos = indexOf(sql, "SELECT 2") + 1;
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("returns a statement even without a trailing semicolon", () => {
    const sql = "SELECT 1";
    const pos = indexOf(sql, "1");
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("stops at the next top-level statement start when the cursor statement has no semicolon", () => {
    const sql = "SELECT 1\nSELECT 2;\nSELECT 3;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "1"));
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("returns the later top-level statement when earlier statements are missing semicolons", () => {
    const sql = "SELECT 1\nSELECT 2;\nSELECT 3;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "2"));
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("keeps newline set-operation SELECT operands with the cursor statement", () => {
    const sql = "select * from tbA\nunion\nselect * from tbB";
    const expected = "select * from tbA\nunion\nselect * from tbB";

    expect(statementRangeAtCursor(sql, indexOf(sql, "tbA"))?.sql.trim()).toBe(expected);
    expect(statementRangeAtCursor(sql, indexOf(sql, "tbB"))?.sql.trim()).toBe(expected);
  });

  it("keeps newline set-operation operands with ALL modifiers together", () => {
    const sql = "select * from tbA\nunion all\nselect * from tbB\nSELECT * FROM logs;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "tbA"));

    expect(range?.sql.trim()).toBe("select * from tbA\nunion all\nselect * from tbB");
  });

  it("keeps a multi-line select together when continuation lines do not start statements", () => {
    const sql = "SELECT id,\n  name\nFROM users\nWHERE active = 1\nSELECT * FROM logs;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "name"));
    expect(range?.sql.trim()).toBe("SELECT id,\n  name\nFROM users\nWHERE active = 1");
  });

  it("keeps a CTE main query with its WITH statement", () => {
    const sql = "WITH active_users AS (\n  SELECT * FROM users\n)\nSELECT * FROM active_users\nSELECT * FROM logs;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "active_users", 2));
    expect(range?.sql.trim()).toBe("WITH active_users AS (\n  SELECT * FROM users\n)\nSELECT * FROM active_users");
  });

  it("keeps update assignments with the UPDATE statement", () => {
    const sql = "UPDATE users\nSET name = 'a'\nWHERE id = 1\nSELECT * FROM users;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "name"));
    expect(range?.sql.trim()).toBe("UPDATE users\nSET name = 'a'\nWHERE id = 1");
  });

  it("does not merge standard COMMENT ON statements into preceding CREATE TABLE statements", () => {
    const sql = "CREATE TABLE users (id int)\nCOMMENT ON TABLE users IS 'Users';";

    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual(["CREATE TABLE users (id int)", "COMMENT ON TABLE users IS 'Users'"]);
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual(["CREATE TABLE users (id int)", "COMMENT ON TABLE users IS 'Users'"]);
  });

  it("keeps a line-start comment column inside a select projection", () => {
    const sql = "SELECT\n  id,\n  comment,\n  created_at\nFROM project_info\nWHERE deleted = 0;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "comment"))?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps standalone truncate table statements separate from preceding alter statements", () => {
    const sql = "ALTER TABLE events ADD COLUMN source varchar(100)\nTRUNCATE TABLE events;";

    expect(rangeSqlTexts(executableStatementRanges(sql, "opengauss"))).toEqual(["ALTER TABLE events ADD COLUMN source varchar(100)", "TRUNCATE TABLE events"]);
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual(["ALTER TABLE events ADD COLUMN source varchar(100)", "TRUNCATE TABLE events"]);
  });

  it("keeps insert-select with the INSERT statement", () => {
    const sql = "INSERT INTO archived_users (id, name)\nSELECT id, name FROM users\nUPDATE users SET archived = 1;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "archived_users"));
    expect(range?.sql.trim()).toBe("INSERT INTO archived_users (id, name)\nSELECT id, name FROM users");
  });

  it("keeps explain target SQL with the EXPLAIN statement", () => {
    const sql = "EXPLAIN\nSELECT * FROM users\nSELECT * FROM logs;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "EXPLAIN"));
    expect(range?.sql.trim()).toBe("EXPLAIN\nSELECT * FROM users");
  });

  it("keeps issue #3567 EXPLAIN options and CTE target as one statement", () => {
    const sql = "explain (analyze,buffers)\nwith tmp as(select* from test.tt)\nselect * from tmp;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "explain"), "postgres")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(statementRangeAtCursor(sql, indexOf(sql, "select * from tmp"), "postgres")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([sql.slice(0, -1)]);
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps EXPLAIN ANALYZE with a CTE main query as one statement", () => {
    const sql = "explain analyze\nwith tmp as (select 1)\nselect * from tmp;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "explain"), "postgres")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps a plain EXPLAIN CTE target as one statement without merging later queries", () => {
    const sql = "EXPLAIN\nWITH tmp AS (SELECT 1)\nSELECT * FROM tmp\nSELECT * FROM logs;";
    const expected = "EXPLAIN\nWITH tmp AS (SELECT 1)\nSELECT * FROM tmp";

    expect(statementRangeAtCursor(sql, indexOf(sql, "EXPLAIN"))?.sql.trim()).toBe(expected);
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([expected, "SELECT * FROM logs"]);
  });

  it("does not merge a query after an inline EXPLAIN options CTE statement", () => {
    const sql = "EXPLAIN (ANALYZE) WITH tmp AS (SELECT 1)\nSELECT * FROM tmp\nSELECT 2;";
    const expected = "EXPLAIN (ANALYZE) WITH tmp AS (SELECT 1)\nSELECT * FROM tmp";

    expect(statementRangeAtCursor(sql, indexOf(sql, "EXPLAIN"), "postgres")?.sql.trim()).toBe(expected);
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([expected, "SELECT 2"]);
  });

  it("keeps EXPLAIN options CTE UPDATE assignments as one statement", () => {
    const sql = "EXPLAIN (ANALYZE)\nWITH tmp AS (SELECT 1)\nUPDATE t\nSET x = 1;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "SET"), "postgres")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([sql.slice(0, -1)]);
  });

  it("keeps CTE INSERT ... SELECT with the WITH statement", () => {
    const sql = "WITH tmp AS (SELECT 1)\nINSERT INTO t (id)\nSELECT * FROM tmp;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "INSERT"))?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([sql.slice(0, -1)]);
  });

  it("does not merge a query after a CTE INSERT ... SELECT statement", () => {
    const sql = "WITH tmp AS (SELECT 1)\nINSERT INTO t (id)\nSELECT * FROM tmp\nSELECT 2;";
    const expected = "WITH tmp AS (SELECT 1)\nINSERT INTO t (id)\nSELECT * FROM tmp";

    expect(statementRangeAtCursor(sql, indexOf(sql, "INSERT"))?.sql.trim()).toBe(expected);
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([expected, "SELECT 2"]);
  });

  it("does not merge a query after an INSERT with a CTE source query", () => {
    const sql = "INSERT INTO t (id)\nWITH tmp AS (SELECT 1)\nSELECT * FROM tmp\nSELECT 2;";
    const expected = "INSERT INTO t (id)\nWITH tmp AS (SELECT 1)\nSELECT * FROM tmp";

    expect(statementRangeAtCursor(sql, indexOf(sql, "INSERT"))?.sql.trim()).toBe(expected);
    expect(rangeSqlTexts(executableStatementRanges(sql))).toEqual([expected, "SELECT 2"]);
  });

  it("skips block comments inside EXPLAIN options when resolving the target", () => {
    const sql = "EXPLAIN (ANALYZE /* ) */) UPDATE t\nSET x = 1;";

    expect(statementRangeAtCursor(sql, indexOf(sql, "SET"), "postgres")?.sql.trim()).toBe(sql.slice(0, -1));
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([sql.slice(0, -1)]);
  });

  it("recovers later statements from an unclosed EXPLAIN option list", () => {
    const sql = "EXPLAIN (ANALYZE\nSELECT 1\nSELECT 2;";
    const explainSql = "EXPLAIN (ANALYZE\nSELECT 1";

    expect(statementRangeAtCursor(sql, indexOf(sql, "EXPLAIN"), "postgres")?.sql.trim()).toBe(explainSql);
    expect(statementRangeAtCursor(sql, indexOf(sql, "SELECT 2"), "postgres")?.sql.trim()).toBe("SELECT 2");
    expect(rangeSqlTexts(executableStatementRanges(sql, "postgres"))).toEqual([explainSql, "SELECT 2"]);
  });

  it("does not include comments between soft statement blocks", () => {
    const sql = "SELECT 1\n-- explain the next query\n/* still next query notes */\nSELECT 2;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "1"));
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("detects a soft statement start after a leading block comment on the same line", () => {
    const sql = "SELECT 1\n/* next */ SELECT 2;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "2"));
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("uses database-specific soft statement keywords", () => {
    const sql = "SELECT 1\nDO $$ BEGIN RAISE NOTICE 'x'; END $$;";
    expect(statementRangeAtCursor(sql, indexOf(sql, "1"))?.sql.trim()).toBe("SELECT 1\nDO $$ BEGIN RAISE NOTICE 'x'; END $$");
    expect(statementRangeAtCursor(sql, indexOf(sql, "1"), "postgres")?.sql.trim()).toBe("SELECT 1");
    expect(statementRangeAtCursor(sql, indexOf(sql, "DO"), "postgres")?.sql.trim()).toBe("DO $$ BEGIN RAISE NOTICE 'x'; END $$");
  });

  it("returns null when the cursor is on a blank line", () => {
    const sql = "SELECT 1;\n\nSELECT 2;";
    const blankLinePos = sql.indexOf("\n") + 1;
    expect(statementRangeAtCursor(sql, blankLinePos)).toBeNull();
  });

  it("returns null for an empty document", () => {
    expect(statementRangeAtCursor("", 0)).toBeNull();
  });

  it("does not treat comment semicolons as delimiters", () => {
    const sql = "SELECT 1; -- drop; this\nSELECT 2;";
    const pos = indexOf(sql, "2");
    expect(statementRangeAtCursor(sql, pos)?.sql.trim()).toBe("SELECT 2");
  });

  it("exposes offsets aligned to the statement body", () => {
    const sql = "  SELECT 1;\nSELECT 2;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "1"));
    expect(range?.from).toBe(2);
    expect(range?.sql).toBe("SELECT 1");
  });

  it("returns the full openGauss Oracle-compatible PL/SQL block for cursors inside nested statements", () => {
    const range = statementRangeAtCursor(oraclePlSqlFixture, indexOf(oraclePlSqlFixture, "ORDERS_10K", 2), "opengauss");
    expect(range?.sql.trim()).toBe(oraclePlSqlFixture.slice(0, oraclePlSqlFixture.indexOf("\n/")));
  });

  it("returns the full issue #2405 openGauss Oracle-compatible PL/SQL block for cursors inside the block", () => {
    for (const cursor of [indexOf(oracleIssue2405PlSql, "PRE_TRD_DATE"), indexOf(oracleIssue2405PlSql, "SELECT 1 + 2"), indexOf(oracleIssue2405PlSql, "END;")]) {
      expect(statementRangeAtCursor(oracleIssue2405PlSql, cursor, "opengauss")?.sql.trim()).toBe(oracleIssue2405PlSql);
    }
  });

  it("returns the full openGauss procedure for cursors after a nested block", () => {
    const outerNull = indexOf(gaussDbNestedProcedure, "NULL;", 2);
    expect(statementRangeAtCursor(gaussDbNestedProcedure, outerNull, "opengauss")?.sql.trim()).toBe(gaussDbNestedProcedure);
  });

  it("returns only the issue #4573 openGauss procedure for a gutter cursor", () => {
    const expected = gaussDbIssue4573Script.slice(0, gaussDbIssue4573Script.indexOf("\n\nSELECT 1"));
    expect(statementRangeAtCursor(gaussDbIssue4573Script, indexOf(gaussDbIssue4573Script, "count(*)"), "opengauss")?.sql.trim()).toBe(expected);
  });
});

describe("executableStatementRanges", () => {
  it("returns statement ranges starting only at statement starts", () => {
    const sql = "SELECT *\nFROM users\nWHERE active = 1;\nSELECT 2;";
    const ranges = executableStatementRanges(sql);
    expect(rangeSqlTexts(ranges)).toEqual(["SELECT *\nFROM users\nWHERE active = 1", "SELECT 2"]);
    expect(ranges.map((range) => range.from)).toEqual([0, sql.indexOf("SELECT 2")]);
  });

  it("does not split executable openGauss Oracle-compatible PL/SQL ranges at inner statement starts", () => {
    expect(rangeSqlTexts(executableStatementRanges(oraclePlSqlFixture, "opengauss"))).toEqual([oraclePlSqlFixture.slice(0, oraclePlSqlFixture.indexOf("\n/")), "SELECT 1"]);
  });

  it("returns the issue #2405 openGauss Oracle-compatible PL/SQL block as one executable range", () => {
    expect(rangeSqlTexts(executableStatementRanges(oracleIssue2405PlSql, "opengauss"))).toEqual([oracleIssue2405PlSql]);
  });
});

describe("currentExecutableStatementRange", () => {
  it("uses the current SQL statement range for multi-line DDL", () => {
    const sql = "ALTER TABLE `yb_course_order`\n  ADD COLUMN `audit_status` tinyint(4) DEFAULT NULL\n    COMMENT '审核状态：0-待审核，1-已通过，2-已拒绝',\n  ADD COLUMN `close_reason` varchar(30) DEFAULT NULL\n    COMMENT '关闭原因：timeout-超时关闭，cancel-取消关闭，refund-退款关闭';\nSELECT 1;";

    expect(currentExecutableStatementRange(sql, indexOf(sql, "close_reason"), "opengauss")?.sql.trim()).toBe(sql.slice(0, sql.indexOf(";\nSELECT")));
  });

  it("returns null on blank and pure comment lines", () => {
    const sql = "SELECT 1;\n-- comment\n\nSELECT 2;";

    expect(currentExecutableStatementRange(sql, indexOf(sql, "comment"), "opengauss")).toBeNull();
    expect(currentExecutableStatementRange(sql, sql.indexOf("\n\n") + 1, "opengauss")).toBeNull();
  });
});

describe("fullSqlRange", () => {
  it("returns the trimmed full document", () => {
    const sql = "  SELECT 1;  \n";
    const range = fullSqlRange(sql);
    expect(range?.sql).toBe("SELECT 1;");
  });

  it("returns null for an empty/whitespace document", () => {
    expect(fullSqlRange("   \n  ")).toBeNull();
  });
});

describe("buildExecutionCandidates", () => {
  it("returns a single candidate when only the cursor statement exists", () => {
    const sql = "SELECT 1";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "1"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("all");
  });

  it("returns current + all in order for multiple statements", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "2"));
    expect(candidateKinds(candidates)).toEqual(["cursor", "all"]);
  });

  it("preserves leading optimizer hints in current statement candidates", () => {
    const hintedSql = "/*+ SET(polar_csi.enable_query on) SET(polar_csi.cost_threshold 0)*/\nselect count(1) from xxx";
    const sql = `select 1;\n${hintedSql};`;
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "count"), "postgres");

    expect(candidates[0].sql).toBe(hintedSql);
  });

  it("preserves leading tenant routing hints in current statement candidates", () => {
    const hintedSql = "/*@global:true*/\nSELECT * FROM tenant_table";
    const sql = `SELECT 1;\n${hintedSql};`;
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "tenant_table"), "opengauss");

    expect(candidates[0].sql).toBe(hintedSql);
    expect(splitSqlStatementRanges("/*@global:true*/", "opengauss")).toEqual([]);
  });

  it("uses the cursor statement for the first candidate when there is no selection", () => {
    const sql = "SELECT *\nFROM users\nWHERE active = 1";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "users"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("all");
  });

  it("uses the whole set-operation statement for cursor execution candidates", () => {
    const sql = "select * from tbA\nunion\nselect * from tbB\nSELECT * FROM logs;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "tbA"));

    expect(candidateSummaries(candidates)).toEqual(["cursor:select * from tbA\nunion\nselect * from tbB", "all:select * from tbA\nunion\nselect * from tbB\nSELECT * FROM logs;"]);
  });

  it("returns current + all when the cursor is in indentation before a statement", () => {
    const sql = "SELECT 1;\n    SELECT 2;";
    const indentationPos = sql.indexOf("    SELECT 2") + 2;
    const candidates = buildExecutionCandidates(sql, indentationPos);
    expect(candidateSummaries(candidates)).toEqual(["cursor:SELECT 2", "all:SELECT 1;\n    SELECT 2;"]);
    expect(candidateLabels(candidates)).toEqual(["currentStatement", "allStatements"]);
  });

  it("uses the current statement when the cursor is immediately after its semicolon before a blank line", () => {
    const sql = "select 1;\n\nselect 2;";
    const cursorAfterFirstSemicolon = sql.indexOf(";") + 1;
    const candidates = buildExecutionCandidates(sql, cursorAfterFirstSemicolon);
    expect(candidateSummaries(candidates)).toEqual(["cursor:select 1", "all:select 1;\n\nselect 2;"]);
  });

  it("uses the final soft statement when the cursor follows trailing EOF whitespace", () => {
    const sql = "SELECT 1\nSELECT 2 ";
    const candidates = buildExecutionCandidates(sql, sql.length);
    expect(candidateSummaries(candidates)).toEqual(["cursor:SELECT 2", "all:SELECT 1\nSELECT 2"]);
  });

  it("uses the final soft statement when the cursor is on a standalone trailing semicolon", () => {
    const sql = 'SELECT * FROM "t_0001"\nSELECT * FROM "t_0001" LIMIT 1\n;';
    const candidates = buildExecutionCandidates(sql, sql.lastIndexOf(";"), "opengauss");

    expect(candidateSummaries(candidates)).toEqual(['cursor:SELECT * FROM "t_0001" LIMIT 1', `all:${sql}`]);
  });

  it("dedupes when the cursor statement equals the full document", () => {
    const sql = "SELECT 1;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "1"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("all");
  });

  it("returns only 'all' when the cursor is on a blank line", () => {
    const sql = "SELECT 1;\n\nSELECT 2;";
    const candidates = buildExecutionCandidates(sql, sql.indexOf("\n") + 1);
    expect(candidateKinds(candidates)).toEqual(["all"]);
    expect(candidates[0].supportedKinds).toEqual(["all"]);
    expect(executionCandidateForMode(candidates, "current")).toBeNull();
    expect(executionCandidateForMode(candidates, "all")).toBe(candidates[0]);
  });

  it("marks a deduplicated single-statement candidate as both current and all", () => {
    const sql = "SELECT 1;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "1"));

    expect(candidates[0].supportedKinds).toEqual(["cursor", "all"]);
  });

  it("returns no candidates for an empty document", () => {
    expect(buildExecutionCandidates("", 0)).toEqual([]);
  });

  it("returns only 'all' when the cursor has no statement but the document has SQL", () => {
    // Cursor past the end on a trailing blank line.
    const sql = "SELECT 1;\nSELECT 2;\n";
    const candidates = buildExecutionCandidates(sql, sql.length);
    expect(candidateKinds(candidates)).toEqual(["all"]);
  });
});

describe("hasMultipleExecutionTargets", () => {
  it("returns false for a single SQL statement", () => {
    expect(hasMultipleExecutionTargets("SELECT 1;")).toBe(false);
  });

  it("returns true for multiple SQL statements", () => {
    expect(hasMultipleExecutionTargets("SELECT 1;\nSELECT 2;")).toBe(true);
  });

  it("ignores comments when counting SQL statements", () => {
    expect(hasMultipleExecutionTargets("-- check one thing\nSELECT 1;")).toBe(false);
  });
});

describe("supportsExecutionTargetPicker", () => {
  it("enables the picker for configured SQL database connections", () => {
    expect(supportsExecutionTargetPicker("opengauss")).toBe(true);
    expect(supportsExecutionTargetPicker("postgres")).toBe(true);
    expect(supportsExecutionTargetPicker("jdbc")).toBe(true);
    expect(supportsExecutionTargetPicker(undefined)).toBe(false);
  });
});
