import { describe, expect, it } from "vitest";
import { buildOpenGaussRoutineDebugCallSql, buildOpenGaussRoutineExecutionSql, buildProcedureExecutionSqlFromValues } from "@/lib/table/routineExecutionSql";
import { routineParametersFromResult, routineParametersQuery } from "@/lib/table/routineParameters";
import type { QueryResult } from "@/types/database";

function queryResult(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

describe("MySQL routine execution SQL", () => {
  it("binds OUT parameters without requiring user input", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "mysql",
      schema: "app",
      routineName: "double_value",
      parameters: [
        { name: "p_input", dataType: "int", mode: "IN", ordinal: 1, value: "5" },
        { name: "p_output", dataType: "int", mode: "OUT", ordinal: 2, value: "ignored" },
      ],
    });

    expect(sql).toBe(["SET @dbx_output_2 = NULL;", "CALL `double_value`(5, @dbx_output_2);", "SELECT @dbx_output_2 AS `p_output`;"].join("\n"));
  });

  it("initializes INOUT variables and returns all output values", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "mysql",
      schema: "app",
      routineName: "adjust_values",
      parameters: [
        { name: "p_delta", dataType: "int", mode: "IN", ordinal: 1, value: "5" },
        { name: "p_total", dataType: "int", mode: "INOUT", ordinal: 2, value: "10" },
        { name: "p_status", dataType: "varchar(16)", mode: "OUT", ordinal: 3, value: "" },
      ],
    });

    expect(sql).toBe(["SET @dbx_output_2 = 10;", "SET @dbx_output_3 = NULL;", "CALL `adjust_values`(5, @dbx_output_2, @dbx_output_3);", "SELECT @dbx_output_2 AS `p_total`, @dbx_output_3 AS `p_status`;"].join("\n"));
  });

  it("keeps input-only procedure calls unchanged", () => {
    expect(
      buildProcedureExecutionSqlFromValues({
        databaseType: "mysql",
        schema: "app",
        routineName: "save_value",
        parameters: [{ name: "p_value", dataType: "varchar(32)", mode: "IN", ordinal: 1, value: "O'Reilly" }],
      }),
    ).toBe("CALL `save_value`('O''Reilly');");
  });

  it("uses MySQL parameter modes to generate output bindings", () => {
    const parameters = routineParametersFromResult(
      queryResult(
        ["name", "data_type", "mode", "ordinal", "has_default"],
        [
          ["p_input", "int", "IN", 1, false],
          ["p_output", "int", "OUT", 2, false],
        ],
      ),
      "mysql",
    );

    expect(parameters.map((parameter) => parameter.mode)).toEqual(["IN", "OUT"]);
    expect(
      buildProcedureExecutionSqlFromValues({
        databaseType: "mysql",
        routineName: "double_value",
        parameters: parameters.map((parameter) => ({ ...parameter, value: parameter.mode === "IN" ? "5" : "" })),
      }),
    ).toContain("CALL `double_value`(5, @dbx_output_2);");
  });
});

describe("SQL Server routine execution SQL", () => {
  it("declares and selects OUT parameters", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "sqlserver",
      schema: "dbo",
      routineName: "Sys_CreatePrimaryKeyValue",
      parameters: [
        { name: "@tableName", dataType: "varchar(64)", mode: "IN", ordinal: 1, value: "users" },
        { name: "@returnValue", dataType: "varchar(128)", mode: "OUT", ordinal: 2, value: "" },
      ],
    });

    expect(sql).toBe(["DECLARE @dbx_output_2 varchar(128);", "EXEC [dbo].[Sys_CreatePrimaryKeyValue] @tableName = 'users', @returnValue = @dbx_output_2 OUTPUT;", "SELECT @dbx_output_2 AS [returnValue];"].join("\n"));
  });

  it("initializes INOUT parameters and keeps numeric values unquoted", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "sqlserver",
      schema: "dbo",
      routineName: "adjust_amount",
      parameters: [{ name: "@amount", dataType: "decimal(18,4)", mode: "INOUT", ordinal: 1, value: "12.5000" }],
    });

    expect(sql).toBe(["DECLARE @dbx_output_1 decimal(18,4) = 12.5000;", "EXEC [dbo].[adjust_amount] @amount = @dbx_output_1 OUTPUT;", "SELECT @dbx_output_1 AS [amount];"].join("\n"));
  });

  it("preserves IN parameters and omission of requested defaults", () => {
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "sqlserver",
      schema: "dbo",
      routineName: "refresh_cache",
      parameters: [
        { name: "@scope", dataType: "varchar(32)", mode: "IN", ordinal: 1, value: "all" },
        { name: "@timeout", dataType: "int", mode: "IN", ordinal: 2, value: "30", hasDefault: true, useDefault: true },
      ],
    });

    expect(sql).toBe("EXEC [dbo].[refresh_cache] @scope = 'all';");
  });

  it("keeps no-parameter procedures valid and ignores RETURN metadata", () => {
    expect(buildProcedureExecutionSqlFromValues({ databaseType: "sqlserver", schema: "dbo", routineName: "ping", parameters: [] })).toBe("EXEC [dbo].[ping];");
    expect(
      buildProcedureExecutionSqlFromValues({
        databaseType: "sqlserver",
        schema: "dbo",
        routineName: "ping",
        parameters: [{ name: "return_status", dataType: "int", mode: "RETURN", ordinal: 0, value: "" }],
      }),
    ).toBe("EXEC [dbo].[ping];");
  });

  it("preserves SQL Server declaration lengths, MAX, and decimal precision", () => {
    const parameters = routineParametersFromResult(
      queryResult(
        ["name", "data_type", "mode", "ordinal", "has_default", "max_length", "precision", "scale", "type_schema", "is_user_defined"],
        [
          ["@short", "varchar", "OUT", 1, false, 64, 0, 0, "sys", false],
          ["@long", "varchar", "OUT", 2, false, -1, 0, 0, "sys", false],
          ["@amount", "decimal", "OUT", 3, false, 17, 18, 4, "sys", false],
        ],
      ),
      "sqlserver",
    );

    expect(parameters.map((parameter) => parameter.dataType)).toEqual(["varchar(64)", "varchar(max)", "decimal(18,4)"]);
    expect(
      buildProcedureExecutionSqlFromValues({
        databaseType: "sqlserver",
        schema: "dbo",
        routineName: "collect_outputs",
        parameters: parameters.map((parameter) => ({ ...parameter, value: "" })),
      }),
    ).toContain(["DECLARE @dbx_output_1 varchar(64);", "DECLARE @dbx_output_2 varchar(max);", "DECLARE @dbx_output_3 decimal(18,4);"].join("\n"));

    const metadataSql = routineParametersQuery({ database: "app", databaseType: "sqlserver", schema: "dbo", routineName: "save" });
    expect(metadataSql).toContain("JOIN sys.types t ON t.user_type_id = p.user_type_id");
    expect(metadataSql).toContain("p.max_length AS max_length");
    expect(metadataSql).toContain("p.precision AS precision");
    expect(metadataSql).toContain("p.scale AS scale");

    // openGauss shares the pg_proc metadata query, narrowed by routine kind.
    expect(routineParametersQuery({ database: "postgres", databaseType: "opengauss", schema: "public", routineName: "dbg_demo", routineKind: "procedure" })).toContain("p.prokind = 'p'");
    expect(routineParametersQuery({ database: "postgres", databaseType: "opengauss", schema: "public", routineName: "f", routineKind: "function" })).toContain("p.prokind = 'f'");
    expect(routineParametersQuery({ database: "postgres", databaseType: "opengauss", schema: "public", routineName: "dbg_demo" })).toContain("p.prokind IN ('p', 'f')");
  });
});

describe("openGauss graphical routine invocation", () => {
  const param = (name: string, dataType: string, mode: "IN" | "OUT" | "INOUT", ordinal: number, value = "") => ({ name, dataType, mode, ordinal, value });

  it("procedures with only IN inputs use CALL", () => {
    const sql = buildOpenGaussRoutineExecutionSql({
      databaseType: "opengauss",
      schema: "public",
      routineName: "dbg_demo",
      parameters: [param("x", "integer", "IN", 1, "1")],
    });
    expect(sql).toBe("CALL public.dbg_demo(1);");
  });

  it("procedures with OUT/INOUT params use CALL with NULL placeholders (values return as a row)", () => {
    const sql = buildOpenGaussRoutineExecutionSql({
      databaseType: "opengauss",
      schema: "public",
      routineName: "ogdev_out_demo",
      parameters: [param("x", "int", "IN", 1, "4"), param("y", "numeric", "OUT", 2), param("z", "text", "INOUT", 3, "in")],
    });
    expect(sql).toBe("CALL public.ogdev_out_demo(4, NULL, 'in');");
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
});
