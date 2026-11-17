import { describe, expect, it } from "vitest";
import { buildPackageMemberCallSql, parsePlSqlOutline } from "@/lib/sql/plsqlOutline";

describe("plsqlOutline", () => {
  it("extracts package specification symbols with parameters, signatures, and line ranges", () => {
    const sql = [
      "CREATE OR REPLACE PACKAGE hr.emp_pkg IS",
      "  g_version CONSTANT VARCHAR2(16) := '2.0';",
      "  g_trace_enabled BOOLEAN := FALSE;",
      "  e_invalid_salary EXCEPTION;",
      "  PRAGMA EXCEPTION_INIT(e_invalid_salary, -20001);",
      "  TYPE emp_rec_t IS RECORD (id INT, name VARCHAR2(100));",
      "  SUBTYPE dept_code_t IS VARCHAR2(10);",
      "  CURSOR cur_by_dept(p_dept INT) RETURN emp_rec_t;",
      "  PROCEDURE hire_emp(p_id INT, p_name VARCHAR2 DEFAULT 'N/A', o_code OUT INT);",
      "  FUNCTION get_bonus(p_id IN INT, io_rate IN OUT NUMERIC(5, 2)) RETURN NUMERIC;",
      "END emp_pkg;",
    ].join("\n");

    const items = parsePlSqlOutline(sql);
    expect(items.map((item) => ({ name: item.name, kind: item.kind, line: item.line, endLine: item.endLine }))).toEqual([
      { name: "emp_pkg", kind: "package", line: 1, endLine: 11 },
      { name: "g_version", kind: "constant", line: 2, endLine: 2 },
      { name: "g_trace_enabled", kind: "variable", line: 3, endLine: 3 },
      { name: "e_invalid_salary", kind: "exception", line: 4, endLine: 4 },
      { name: "emp_rec_t", kind: "type", line: 6, endLine: 6 },
      { name: "dept_code_t", kind: "type", line: 7, endLine: 7 },
      { name: "cur_by_dept", kind: "cursor", line: 8, endLine: 8 },
      { name: "hire_emp", kind: "procedure", line: 9, endLine: 9 },
      { name: "get_bonus", kind: "function", line: 10, endLine: 10 },
    ]);

    const hireProc = items.find((i) => i.name === "hire_emp")!;
    expect(hireProc.isExecutableSubprogram).toBe(true);
    expect(hireProc.isForwardDeclaration).toBeUndefined();
    expect(hireProc.signature).toBe("(p_id INT, p_name VARCHAR2, o_code OUT INT)");
    expect(hireProc.parameters).toEqual([
      { name: "p_id", dataType: "INT" },
      { name: "p_name", dataType: "VARCHAR2" },
      { name: "o_code", mode: "OUT", dataType: "INT" },
    ]);

    const bonusFn = items.find((i) => i.name === "get_bonus")!;
    expect(bonusFn.isExecutableSubprogram).toBe(true);
    expect(bonusFn.signature).toBe("(p_id INT, io_rate INOUT NUMERIC(5, 2)) RETURN NUMERIC");
    expect(bonusFn.parameters).toEqual([
      { name: "p_id", mode: "IN", dataType: "INT" },
      { name: "io_rate", mode: "INOUT", dataType: "NUMERIC(5, 2)" },
    ]);
  });

  it("distinguishes forward declarations from full definitions in PACKAGE BODY and tracks endLine across nested blocks", () => {
    const sql = [
      "CREATE OR REPLACE PACKAGE BODY hr.emp_pkg IS",
      "  g_call_count INT := 0;",
      "  PROCEDURE internal_log(p_msg VARCHAR2);",
      "",
      "  PROCEDURE hire_emp(p_id INT, p_name VARCHAR2, o_code OUT INT) IS",
      "    v_exists INT;",
      "    PROCEDURE bump_counter IS",
      "    BEGIN",
      "      g_call_count := g_call_count + 1;",
      "    END bump_counter;",
      "  BEGIN",
      "    SELECT CASE WHEN p_id > 0 THEN 1 ELSE 0 END INTO v_exists;",
      "    IF v_exists = 1 THEN",
      "      bump_counter();",
      "      internal_log('ok');",
      "    END IF;",
      "    o_code := 0;",
      "  EXCEPTION",
      "    WHEN OTHERS THEN",
      "      o_code := -1;",
      "  END hire_emp;",
      "",
      "  PROCEDURE internal_log(p_msg VARCHAR2) IS",
      "  BEGIN",
      "    NULL;",
      "  END internal_log;",
      "BEGIN",
      "  g_call_count := 0;",
      "END emp_pkg;",
    ].join("\n");

    const items = parsePlSqlOutline(sql);

    const pkgBody = items[0];
    expect(pkgBody.kind).toBe("package-body");
    expect(pkgBody.name).toBe("emp_pkg");
    expect(pkgBody.line).toBe(1);
    expect(pkgBody.endLine).toBe(29);
    expect(pkgBody.isExecutableSubprogram).toBe(false);

    const forwardDecl = items.find((i) => i.name === "internal_log" && i.line === 3)!;
    expect(forwardDecl.isForwardDeclaration).toBe(true);
    expect(forwardDecl.isExecutableSubprogram).toBe(false);
    expect(forwardDecl.endLine).toBe(3);

    const hireDef = items.find((i) => i.name === "hire_emp")!;
    expect(hireDef.isForwardDeclaration).toBeUndefined();
    expect(hireDef.isExecutableSubprogram).toBe(true);
    expect(hireDef.line).toBe(5);
    expect(hireDef.endLine).toBe(21);

    const nestedProc = items.find((i) => i.name === "bump_counter")!;
    expect(nestedProc.isExecutableSubprogram).toBe(false);
    expect(nestedProc.line).toBe(7);
    expect(nestedProc.endLine).toBe(10);

    const fullLogDef = items.find((i) => i.name === "internal_log" && i.line === 23)!;
    expect(fullLogDef.isForwardDeclaration).toBeUndefined();
    expect(fullLogDef.isExecutableSubprogram).toBe(true);
    expect(fullLogDef.line).toBe(23);
    expect(fullLogDef.endLine).toBe(26);
  });

  it("scans inside dollar-quoted FUNCTION, PACKAGE, and DO bodies with accurate source line numbers and offsets", () => {
    const sql = [
      "CREATE OR REPLACE FUNCTION app.audit_trg_fn() RETURNS trigger AS $body$",
      "DECLARE",
      "  v_user TEXT := current_user;",
      "  cur_items SCROLL CURSOR (p_limit INT) FOR SELECT 1;",
      "BEGIN",
      "  EXECUTE $sql$ CREATE PROCEDURE should_not_appear() IS BEGIN NULL; END; $sql$;",
      "  RETURN NEW;",
      "END;",
      "$body$ LANGUAGE plpgsql;",
    ].join("\n");

    const items = parsePlSqlOutline(sql);
    expect(items.map((i) => ({ name: i.name, kind: i.kind, line: i.line }))).toEqual([
      { name: "audit_trg_fn", kind: "function", line: 1 },
      { name: "v_user", kind: "variable", line: 3 },
      { name: "cur_items", kind: "cursor", line: 4 },
    ]);

    expect(items[0].endLine).toBe(9);
    expect(items[0].signature).toBe("() RETURN trigger");
    expect(sql.slice(items[1].offset, items[1].offset + 6)).toBe("v_user");
    expect(items[2].signature).toBe("(p_limit INT)");
  });

  it("supports openGauss dollar-quoted PACKAGE and PACKAGE BODY syntax", () => {
    const sql = ["CREATE OR REPLACE PACKAGE app.math_pkg AS $pkg$", "  FUNCTION add_num(a INT, b INT) RETURN INT;", "$pkg$;", "CREATE OR REPLACE PACKAGE BODY app.math_pkg AS $pkg$", "  FUNCTION add_num(a INT, b INT) RETURN INT IS", "  BEGIN", "    RETURN a + b;", "  END;", "$pkg$;"].join("\n");

    const items = parsePlSqlOutline(sql);
    expect(items.map((i) => `${i.kind}:${i.name}@${i.line}-${i.endLine}`)).toEqual(["package:math_pkg@1-3", "function:add_num@2-2", "package-body:math_pkg@4-9", "function:add_num@5-8"]);
  });

  it("ignores keywords inside line comments, nested block comments, string literals, and unquotes quoted identifiers", () => {
    const sql = [
      "-- PROCEDURE comment_proc(x INT);",
      "/* outer comment /* nested FUNCTION nested_fake() RETURN INT; */ still comment",
      "   PACKAGE fake_pkg IS END; */",
      'CREATE OR REPLACE PROCEDURE "AppSchema"."SyncOrder"("p_OrderId" IN BIGINT) IS',
      "  v_sql VARCHAR2(200) := 'PROCEDURE str_fake(a INT) IS BEGIN NULL; END;';",
      "  v_q VARCHAR2(200) := q'[FUNCTION q_fake() RETURN INT IS BEGIN RETURN 1; END;]';",
      "BEGIN",
      "  NULL;",
      "END;",
    ].join("\n");

    const items = parsePlSqlOutline(sql);
    expect(items).toHaveLength(3);
    expect(items[0].name).toBe("SyncOrder");
    expect(items[0].kind).toBe("procedure");
    expect(items[0].parameters).toEqual([{ name: "p_OrderId", mode: "IN", dataType: "BIGINT" }]);
    expect(items[1].name).toBe("v_sql");
    expect(items[2].name).toBe("v_q");
  });

  it("parses triggers and anonymous blocks while ignoring plain SQL cursors and transactions", () => {
    const triggerAndAnon = ["CREATE TRIGGER trg_emp_bi BEFORE INSERT ON hr.emp FOR EACH ROW", "DECLARE", "  v_ts TIMESTAMP;", "BEGIN", "  v_ts := now();", "END;", "", "DECLARE cur CURSOR FOR SELECT * FROM hr.emp;", "BEGIN; SELECT 1; COMMIT;"].join("\n");

    const items = parsePlSqlOutline(triggerAndAnon);
    expect(items.map((i) => ({ name: i.name, kind: i.kind }))).toEqual([
      { name: "trg_emp_bi", kind: "trigger" },
      { name: "v_ts", kind: "variable" },
    ]);
  });

  it("builds executable call SQL for package procedures and functions with IN, OUT, and INOUT parameters", () => {
    const sql = ["CREATE OR REPLACE PACKAGE hr.emp_pkg IS", "  FUNCTION get_ver RETURN VARCHAR2;", "  PROCEDURE set_dept(p_emp_id INT, p_dept VARCHAR2);", "  PROCEDURE load_summary(p_emp_id INT, o_name OUT VARCHAR2, io_tag IN OUT VARCHAR2);", "END emp_pkg;"].join("\n");

    const items = parsePlSqlOutline(sql);
    const getVer = items.find((i) => i.name === "get_ver")!;
    const setDept = items.find((i) => i.name === "set_dept")!;
    const loadSummary = items.find((i) => i.name === "load_summary")!;

    expect(buildPackageMemberCallSql({ schema: "hr", packageName: "emp_pkg", item: getVer })).toContain("SELECT hr.emp_pkg.get_ver();");

    expect(buildPackageMemberCallSql({ schema: "hr", packageName: "emp_pkg", item: setDept })).toContain("CALL hr.emp_pkg.set_dept(\n  NULL, /* p_emp_id: INT */\n  NULL /* p_dept: VARCHAR2 */\n);");

    const outBlock = buildPackageMemberCallSql({ schema: "hr", packageName: "emp_pkg", item: loadSummary });
    expect(outBlock).toContain("DECLARE\n  v_o_name VARCHAR2(4000);\n  v_io_tag VARCHAR2(4000) := NULL;\nBEGIN");
    expect(outBlock).toContain("hr.emp_pkg.load_summary(");
    expect(outBlock).toContain("RAISE NOTICE 'o_name = %, io_tag = %', v_o_name, v_io_tag;");
  });
});
