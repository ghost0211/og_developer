import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildProcedureExecutionSql, buildProcedureExecutionSqlFromValues } from "../../apps/desktop/src/lib/table/routineExecutionSql.ts";
import { routineParametersFromResult, routineParametersQuery } from "../../apps/desktop/src/lib/table/routineParameters.ts";



test("omits parameters that use database defaults", () => {
  assert.equal(
    buildProcedureExecutionSqlFromValues({
      databaseType: "postgres",
      schema: "public",
      routineName: "refresh_stats",
      parameters: [
        {
          name: "p_message",
          dataType: "text",
          mode: "IN",
          ordinal: 1,
          value: "",
          hasDefault: true,
          useDefault: true,
        },
      ],
    }),
    'CALL "public"."refresh_stats"();',
  );
});


test("maps routine parameter query results into form metadata", () => {
  const parameters = routineParametersFromResult({
    columns: ["name", "data_type", "mode", "ordinal", "has_default"],
    rows: [
      ["p_message", "text", "IN", 1, true],
      ["p_total", "integer", "OUT", 2, false],
    ],
    affected_rows: 0,
    execution_time_ms: 1,
  });

  assert.deepEqual(parameters, [
    { name: "p_message", dataType: "text", mode: "IN", ordinal: 1, hasDefault: true },
    { name: "p_total", dataType: "integer", mode: "OUT", ordinal: 2, hasDefault: false },
  ]);
});


