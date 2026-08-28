import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  createDraftTable,
  createEmptyColumn,
  draftTableToCreateSqlOptions,
  liveTableToAlterSqlOptions,
} from "../../apps/desktop/src/lib/diagram/draft-table.ts";
import type { DiagramTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";
import { canAddTableStructureColumn, getTableStructureCapabilities } from "../../apps/desktop/src/lib/table/tableStructureCapabilities.ts";
import { supportsTableStructureEditing } from "../../apps/desktop/src/lib/database/databaseFeatureSupport.ts";
import { defaultNewColumnDataType, getDataTypeOptions } from "../../apps/desktop/src/lib/table/tableStructureEditorState.ts";
import type { DatabaseType } from "../../apps/desktop/src/types/database.ts";

const READY_DIALECTS: DatabaseType[] = ["mysql", "postgres", "sqlite", "sqlserver", "oracle"];


test("draft CREATE options match table-structure SQL API shape", () => {
  for (const dbType of READY_DIALECTS) {
    const table = createDraftTable("users", { databaseType: dbType });
    const options = draftTableToCreateSqlOptions(table, dbType, dbType === "postgres" ? "public" : undefined);
    assert.equal(options.databaseType, dbType);
    assert.equal(options.tableName, "users");
    assert.ok(Array.isArray(options.columns));
    assert.ok(Array.isArray(options.indexes));
    assert.deepEqual(options.foreignKeys, []);
    assert.deepEqual(options.triggers, []);
    assert.equal(options.columns[0]?.isPrimaryKey, true);
    assert.ok(options.columns[0]?.dataType);
  }
});

test("live ALTER options mark pending add and drop for shared change SQL API", () => {
  const table: DiagramTable = {
    name: "orders",
    columns: [
      { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "note", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ],
    foreignKeys: [],
    origin: "database",
    pendingColumnNames: ["note"],
    droppedColumnNames: ["id"],
  };
  const options = liveTableToAlterSqlOptions(table, "postgres", "public");
  assert.equal(options.databaseType, "postgres");
  assert.equal(options.tableName, "orders");
  assert.deepEqual(options.indexes, []);
  assert.deepEqual(options.foreignKeys, []);
  const pending = options.columns.find((column) => column.name === "note");
  const dropped = options.columns.find((column) => column.name === "id");
  assert.ok(pending);
  assert.equal(pending?.original, undefined);
  assert.ok(dropped?.original);
  assert.equal(dropped?.markedForDrop, true);
});

