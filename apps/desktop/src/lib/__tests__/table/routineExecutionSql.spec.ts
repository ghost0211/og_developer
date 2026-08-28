import { describe, expect, it } from "vitest";
import { buildOpenGaussRoutineDebugCallSql, buildOpenGaussRoutineExecutionSql, buildProcedureExecutionSqlFromValues } from "@/lib/table/routineExecutionSql";
import { routineParametersFromResult, routineParametersQuery } from "@/lib/table/routineParameters";
import type { QueryResult } from "@/types/database";

function queryResult(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

describe("openGauss graphical routine invocation", () => {
  it("filters overloaded routines by identity arguments", () => {
    const bySignature = routineParametersQuery({
      database: "postgres",
      databaseType: "opengauss",
      schema: "public",
      routineName: "add_emp",
      signature: "p_id integer, p_name text",
    });
    expect(bySignature).toContain("pg_get_function_identity_arguments(p.oid) = 'p_id integer, p_name text'");

    const packageMember = routineParametersQuery({
      database: "postgres",
      databaseType: "opengauss",
      schema: "public",
      routineName: "ogtest_pkg.add_emp",
      signature: "p_id integer, p_name text, p_salary numeric",
    });
    expect(packageMember).toContain("pkg.pkgname = 'ogtest_pkg'");
    expect(packageMember).toContain("p.proname = 'add_emp'");
    expect(packageMember).toContain("pg_get_function_identity_arguments(p.oid) = 'p_id integer, p_name text, p_salary numeric'");
  });

  it("keeps standalone routines apart from same-named package members", () => {
    const standalone = routineParametersQuery({
      database: "postgres",
      databaseType: "opengauss",
      schema: "public",
      routineName: "show_count",
      signature: "a integer",
    });
    expect(standalone).toContain("(p.propackageid = 0 OR p.propackageid IS NULL)");
    const packageMember = routineParametersQuery({
      database: "postgres",
      databaseType: "opengauss",
      schema: "public",
      routineName: "pkg_init.show_count",
    });
    expect(packageMember).not.toContain("propackageid = 0");
  });

  const param = (name: string, dataType: string, mode: "IN" | "OUT" | "INOUT", ordinal: number, value = "") => ({ name, dataType, mode, ordinal, value });

  it("procedures always run as a DECLARE...BEGIN...END anonymous block (PL/SQL Developer style)", () => {
    const sql = buildOpenGaussRoutineExecutionSql({
      databaseType: "opengauss",
      schema: "public",
      routineName: "dbg_demo",
      parameters: [param("x", "integer", "IN", 1, "1")],
    });
    expect(sql).toBe("DECLARE\n  x integer := 1;\nBEGIN\n  public.dbg_demo(x);\nEND;");
    expect(sql).not.toContain("CALL ");
  });

  it("declares parameters without an initializer until a value is entered", () => {
    const sql = buildOpenGaussRoutineExecutionSql({
      databaseType: "opengauss",
      schema: "hr_app",
      routineName: "adjust_dept_salary",
      parameters: [param("p_dept_id", "numeric", "IN", 1), param("p_percent", "numeric", "IN", 2)],
    });
    expect(sql).toBe("DECLARE\n  p_dept_id numeric;\n  p_percent numeric;\nBEGIN\n  hr_app.adjust_dept_salary(p_dept_id, p_percent);\nEND;");
  });

  it("procedures with OUT/INOUT params generate a PL/SQL block with RAISE NOTICE output captures", () => {
    const sql = buildOpenGaussRoutineExecutionSql({
      databaseType: "opengauss",
      schema: "public",
      routineName: "ogdev_out_demo",
      parameters: [param("x", "int", "IN", 1, "4"), param("y", "numeric", "OUT", 2), param("z", "text", "INOUT", 3, "in")],
    });
    expect(sql).toBe("DECLARE\n  x int := 4;\n  y numeric;\n  z text := 'in';\nBEGIN\n  public.ogdev_out_demo(x, y, z);\n\n  -- Output variable capture\n  RAISE NOTICE '[DBX_OUT] y=%', y;\n  RAISE NOTICE '[DBX_OUT] z=%', z;\nEND;");
  });

  it("functions use SELECT * FROM", () => {
    const sql = buildOpenGaussRoutineExecutionSql({
      databaseType: "opengauss",
      schema: "public",
      routineName: "emp_pkg.get_salary",
      parameters: [param("emp_id", "integer", "IN", 1, "7")],
      isFunction: true,
    });
    expect(sql).toBe("SELECT * FROM public.emp_pkg.get_salary(7);");
  });

  it("scalar-returning functions receive the result into a variable and print it via RAISE NOTICE", () => {
    const sql = buildOpenGaussRoutineExecutionSql({
      databaseType: "opengauss",
      schema: "hr_app",
      routineName: "calc_annual_compensation",
      parameters: [param("p_emp_id", "numeric", "IN", 1, "7")],
      isFunction: true,
      functionReturn: { returnType: "numeric", isSetof: false },
    });
    expect(sql).toBe("DECLARE\n  p_emp_id numeric := 7;\n  v_result numeric;\nBEGIN\n  v_result := hr_app.calc_annual_compensation(p_emp_id);\n\n  RAISE NOTICE '[DBX_OUT] result=%', v_result;\nEND;");
  });

  it("setof-returning functions keep the SELECT * FROM grid form", () => {
    const sql = buildOpenGaussRoutineExecutionSql({
      databaseType: "opengauss",
      schema: "hr_app",
      routineName: "list_emps",
      parameters: [],
      isFunction: true,
      functionReturn: { returnType: "SETOF text", isSetof: true },
    });
    expect(sql).toBe("SELECT * FROM hr_app.list_emps();");
  });

  it("mixed-case routine names stay quoted", () => {
    const sql = buildOpenGaussRoutineExecutionSql({
      databaseType: "opengauss",
      schema: "public",
      routineName: "EmpPkg.getSalary",
      parameters: [param("emp_id", "integer", "IN", 1, "7")],
      isFunction: true,
    });
    expect(sql).toBe('SELECT * FROM public."EmpPkg"."getSalary"(7);');
  });

  it("debug calls use an anonymous block with DECLAREd variables for OUT/INOUT params", () => {
    const sql = buildOpenGaussRoutineDebugCallSql({
      databaseType: "opengauss",
      schema: "public",
      routineName: "ogdev_out_demo",
      parameters: [param("x", "int", "IN", 1, "4"), param("y", "numeric", "OUT", 2), param("z", "text", "INOUT", 3, "in")],
    });
    expect(sql).toBe("DECLARE\n  v_arg_2 numeric;\n  v_arg_3 text := 'in';\nBEGIN\n  public.ogdev_out_demo(4, v_arg_2, v_arg_3);\nEND;");
  });

  it("debug calls without output params skip the DECLARE section", () => {
    const sql = buildOpenGaussRoutineDebugCallSql({
      databaseType: "opengauss",
      schema: "public",
      routineName: "dbg_demo",
      parameters: [param("x", "integer", "IN", 1, "1")],
    });
    expect(sql).toBe("BEGIN\n  public.dbg_demo(1);\nEND;");
  });

  it("builds standard procedure call SQL", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "opengauss",
      schema: "public",
      routineName: "calc_total",
      parameters: [param("val", "integer", "IN", 1, "10")],
    });
    expect(sql).toBe('CALL "public"."calc_total"(10);');
  });
});
