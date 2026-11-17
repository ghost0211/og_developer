import { describe, expect, it } from "vitest";
import { formatSqlSyntaxDiagnosticMessage, lintSqlSyntax, normalizeSqlFullwidthPunctuation, normalizeSqlFullwidthSemicolons } from "@/lib/sql/sqlSyntaxLint";

describe("normalizeSqlFullwidthPunctuation & normalizeSqlFullwidthSemicolons", () => {
  it("replaces top-level fullwidth semicolons and commas while preserving 1:1 string length", () => {
    const raw = "SELECT id， name， '张，三；' AS label FROM users；\nSELECT 2， 3；";
    const normalized = normalizeSqlFullwidthPunctuation(raw);
    expect(normalized).toBe("SELECT id, name, '张，三；' AS label FROM users;\nSELECT 2, 3;");
    expect(normalized.length).toBe(raw.length);
    expect(normalizeSqlFullwidthSemicolons("SELECT 1；\nSELECT 2；")).toBe("SELECT 1;\nSELECT 2;");
  });

  it("never alters fullwidth semicolons or commas inside strings, quoted identifiers, dollar strings, or comments", () => {
    const raw = ["SELECT 'a，b；''，c' AS \"col，1；\"， `col，2`，$tag$body，text；$tag$，$$raw，text$$", "FROM t_demo -- 行注释，；保持不变", "/* 块注释 /* 嵌套，；注释 */ 结束，； */", "WHERE note = E'escaped\\'，；quote'；"].join("\n");

    const normalized = normalizeSqlFullwidthPunctuation(raw);
    expect(normalized).toContain("'a，b；''，c'");
    expect(normalized).toContain('"col，1；"');
    expect(normalized).toContain("`col，2`");
    expect(normalized).toContain("$$raw，text$$");
    expect(normalized).toContain("$tag$body，text；$tag$");
    expect(normalized).toContain("-- 行注释，；保持不变");
    expect(normalized).toContain("/* 嵌套，；注释 */ 结束，； */");
    expect(normalized).toContain("E'escaped\\'，；quote'");
    expect(normalized).toContain('AS "col，1；", `col，2`,$tag$body，text；$tag$,$$raw，text$$');
    expect(normalized.endsWith(";")).toBe(true);
  });

  it("handles literal trailing backslashes in standard SQL strings without misreading quotes", () => {
    const raw = "SELECT 'C:\\', 'D:\\path'；";
    expect(normalizeSqlFullwidthSemicolons(raw)).toBe("SELECT 'C:\\', 'D:\\path';");
  });
});

describe("lintSqlSyntax — conservative identifier & literal preservation", () => {
  it("does NOT flag arbitrary table names, column names, bare aliases, or string literals", () => {
    const sql = `
      SELECT
        form,
        sel,
        stat,
        code,
        usr_id selcet_alias,
        'SELCET * FORM t；，（' AS msg,
        "WHREE；col"
      FROM my_tabel form
      LEFT JOIN ord_tabel ste ON form.id = ste.form_id
      WHERE form.stat = 1 AND ste.code = 'UDPATE'
      GROUP BY form.id, form, sel, stat, code, usr_id
      ORDER BY form.id DESC
      LIMIT 20;
    `;
    expect(lintSqlSyntax(sql)).toEqual([]);
  });

  it("does NOT flag unquoted Chinese identifiers, template parameters, or dollar-quoted string literals", () => {
    const sql = `
      SELECT 姓名, 部门名称, $$文本；内容，测试（1）$$
      FROM 员工信息表 员工
      WHERE 员工.编号 = #{userId, jdbcType=VARCHAR}
        AND 员工.租户 = \${tenantCode}
        AND 员工.状态 = :status;
    `;
    expect(lintSqlSyntax(sql)).toEqual([]);
  });

  it("does NOT flag validCREATE TABLE column names or custom domain types that resemble keywords", () => {
    const sql = `
      CREATE TABLE biz_form (
        selcet VARCHAR2(64) NOT NULL,
        whree custom_schema.form_domain DEFAULT 'ok',
        tabel NUMBER(10, 2) UNIQUE,
        CONSTRAINT pk_biz_form PRIMARY KEY (selcet)
      );
    `;
    expect(lintSqlSyntax(sql)).toEqual([]);
  });

  it("does NOT flag valid openGauss PL/SQL packages, assignments, or procedure calls", () => {
    const sql = `
      CREATE OR REPLACE PACKAGE BODY pkg_order AS
        g_version VARCHAR2(20) := '1.0；';
        PROCEDURE sync_order(p_id IN NUMBER) IS
          v_cnt NUMBER := 0;
        BEGIN
          v_cnt := v_cnt + 1;
          gms_output.put_line('count=' || v_cnt);
          refresh_cache;
          SELECT count(*) INTO form FROM t_orders WHERE id = p_id;
        END sync_order;
      END pkg_order;
    `;
    expect(lintSqlSyntax(sql)).toEqual([]);
  });

  it("does NOT flag TRUNCATE on a table whose name resembles TABLE", () => {
    expect(lintSqlSyntax("TRUNCATE tabel;")).toEqual([]);
  });
});

describe("lintSqlSyntax — fullwidth punctuation & structural checks", () => {
  it("flags fullwidth semicolon, comma, and parentheses in code regions with batch quick-fixes", () => {
    const sql = "SELECT COUNT（*），name FROM users WHERE note = '中文；，（保持'；\nSELECT 2；";
    const diagnostics = lintSqlSyntax(sql);
    expect(diagnostics.map((d) => d.code)).toEqual(["fullwidth-lparen", "fullwidth-rparen", "fullwidth-comma", "fullwidth-semicolon", "fullwidth-semicolon"]);

    const firstSemi = diagnostics.find((d) => d.code === "fullwidth-semicolon")!;
    expect(firstSemi.quickFix?.replacement).toBe(";");
    expect(firstSemi.quickFix?.replaceAllCount).toBe(2);
    expect(firstSemi.quickFix?.replaceAllChanges).toHaveLength(2);
    expect(formatSqlSyntaxDiagnosticMessage(firstSemi)).toContain("；");
  });

  it("flags unclosed quotes, comments, dollar-quotes, and unbalanced parentheses", () => {
    expect(lintSqlSyntax("SELECT 'unterminated FROM t").map((d) => d.code)).toEqual(["unclosed-single-quote"]);
    expect(lintSqlSyntax('SELECT "unterminated FROM t').map((d) => d.code)).toEqual(["unclosed-double-quote"]);
    expect(lintSqlSyntax("SELECT /* unclosed comment").map((d) => d.code)).toEqual(["unclosed-block-comment"]);
    expect(lintSqlSyntax("SELECT 1 */ FROM t").map((d) => d.code)).toEqual(["unmatched-block-comment-end"]);
    expect(lintSqlSyntax("SELECT $$unclosed").map((d) => d.code)).toEqual(["unclosed-dollar-quote"]);
    expect(lintSqlSyntax("SELECT (1 + (2 * 3) FROM t").map((d) => d.code)).toEqual(["unclosed-lparen"]);
    expect(lintSqlSyntax("SELECT 1 + 2) FROM t").map((d) => d.code)).toEqual(["unmatched-rparen"]);
  });
});

describe("lintSqlSyntax — conservative keyword & reserved-word typos", () => {
  it("catches statement-leading keyword typos and preserves user casing in suggestions", () => {
    const upper = lintSqlSyntax("SELCET * FROM users;");
    expect(upper).toHaveLength(1);
    expect(upper[0]).toMatchObject({
      code: "keyword-typo",
      token: "SELCET",
      suggestion: "SELECT",
      quickFix: { from: 0, to: 6, replacement: "SELECT" },
    });

    const lower = lintSqlSyntax("udpate users set a = 1;");
    expect(lower).toHaveLength(1);
    expect(lower[0]).toMatchObject({
      code: "keyword-typo",
      token: "udpate",
      suggestion: "update",
    });
  });

  it("suppresses prefix-in-progress keyword warnings while cursor is still on the word", () => {
    const typingSql = "SELEC";
    expect(lintSqlSyntax(typingSql, { activeCursorPos: typingSql.length })).toEqual([]);
    // Once cursor moves away, incomplete keyword is flagged
    expect(lintSqlSyntax("SELEC * FROM users", { activeCursorPos: 18 })[0]?.suggestion).toBe("SELECT");
    // Non-prefix transposition `SELCET` is flagged immediately even at cursor
    expect(lintSqlSyntax("SELCET", { activeCursorPos: 6 })[0]?.suggestion).toBe("SELECT");
  });

  it("catches clause keyword typos in SELECT / JOIN / WHERE / GROUP BY / ORDER BY / LIMIT", () => {
    const sql = "SELCET DISTNCT a, b FORM users u LFET JION orders o ON u.id = o.uid WHREE u.age BETWEN 18 ADN 60 AND u.tag IS NOT NUL GRUOP BY a, b HVING count(*) > 1 ODRER BY a DSEC LIMTI 10";
    const diagnostics = lintSqlSyntax(sql);
    const typos = diagnostics.map((d) => `${d.token}->${d.suggestion}`);
    expect(typos).toEqual(["SELCET->SELECT", "DISTNCT->DISTINCT", "FORM->FROM", "LFET->LEFT", "JION->JOIN", "WHREE->WHERE", "BETWEN->BETWEEN", "ADN->AND", "NUL->NULL", "GRUOP->GROUP", "HVING->HAVING", "ODRER->ORDER", "DSEC->DESC", "LIMTI->LIMIT"]);
  });

  it("catches INSERT / UPDATE / DELETE / DDL / CREATE TABLE constraint keyword typos", () => {
    expect(lintSqlSyntax("INSRET ITNO users (id, name) VALEUS (1, 'a')").map((d) => `${d.token}->${d.suggestion}`)).toEqual(["INSRET->INSERT", "ITNO->INTO", "VALEUS->VALUES"]);

    expect(lintSqlSyntax("DELETE FORM users WHREE id = 1").map((d) => `${d.token}->${d.suggestion}`)).toEqual(["FORM->FROM", "WHREE->WHERE"]);

    expect(lintSqlSyntax("CREATE OR REPALCE TABEL IF NOT EXSITS t1 (id INT DEFUALT 0 NOT NUL, PRIMRAY KEY (id))").map((d) => `${d.token}->${d.suggestion}`)).toEqual(["REPALCE->REPLACE", "TABEL->TABLE", "EXSITS->EXISTS", "DEFUALT->DEFAULT", "NUL->NULL", "PRIMRAY->PRIMARY"]);

    expect(lintSqlSyntax("ALTER TABEL t1 ADD COLMUN age INT").map((d) => `${d.token}->${d.suggestion}`)).toEqual(["TABEL->TABLE", "COLMUN->COLUMN"]);
  });

  it("catches typos and fullwidth semicolons inside PL/SQL blocks and $$ routine bodies", () => {
    const plsql = `
      CREATE OR REPLACE PROCEDURE p_demo(p_id NUMBER) AS
        v_cnt NUMBER;
      BEGIN
        SELCET count(*) INTO v_cnt FORM users WHREE id = p_id；
        IF v_cnt > 0 TEHN
          UDPATE users STE status = 1 WHREE id = p_id;
        END IF;
        RETUNR;
      END p_demo;
    `;
    expect(lintSqlSyntax(plsql).map((d) => `${d.token}->${d.suggestion}`)).toEqual(["SELCET->SELECT", "FORM->FROM", "WHREE->WHERE", "；->;", "TEHN->THEN", "UDPATE->UPDATE", "STE->SET", "WHREE->WHERE", "RETUNR->RETURN"]);

    const dollarFn = `
      CREATE OR REPLACE FUNCTION fn_demo() RETURNS integer AS $$
      BEGIN
        SELCET 1；
        RETUNR 1;
      END;
      $$ LANGUAGE plpgsql;
    `;
    expect(lintSqlSyntax(dollarFn).map((d) => `${d.token}->${d.suggestion}`)).toEqual(["SELCET->SELECT", "；->;", "RETUNR->RETURN"]);
  });
});
