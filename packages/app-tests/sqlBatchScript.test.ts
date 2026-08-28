import { strict as assert } from "node:assert";
import { test } from "vitest";
import { joinSqlStatementsForScript } from "../../apps/desktop/src/lib/sql/sqlBatchScript.ts";

const statements = [
  "ALTER TABLE [dbo].[GOODS] ADD [FYLKH] nvarchar(255);",
  "IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE name = N'MS_Description') EXEC sys.sp_dropextendedproperty @name=N'MS_Description';",
  "EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'用料款号';",
];



test("keeps a single SQL Server statement without GO", () => {
  assert.equal(joinSqlStatementsForScript([statements[0]], "sqlserver"), statements[0]);
});

test("joins statements with newlines for other database types", () => {
  assert.equal(joinSqlStatementsForScript(statements, "mysql"), statements.join("\n"));
  assert.equal(joinSqlStatementsForScript(statements, undefined), statements.join("\n"));
});

test("returns an empty script for an empty statement list", () => {
  assert.equal(joinSqlStatementsForScript([], "sqlserver"), "");
  assert.equal(joinSqlStatementsForScript([], "mysql"), "");
});

