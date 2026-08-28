import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  DBX_NEO4J_ELEMENT_ID_COLUMN,
  DBX_ROWID_COLUMN,
  DBX_TDENGINE_TBNAME_COLUMN,
  canEditExistingTableRows,
  canInsertTableRows,
  editablePrimaryKeys,
  hasCompleteTdengineRowIdentity,
  hiveTablePropertiesIndicateTransactional,
  isHiddenGridColumn,
  isTdengineExistingRowReadonlyColumn,
  isTableDataEditable,
  supportsDataGridTransaction,
  usesSyntheticRowIdKey,
} from "../../apps/desktop/src/lib/table/tableEditing.ts";
import type { ColumnInfo } from "../../apps/desktop/src/types/database.ts";

function column(name: string, isPrimaryKey = false): ColumnInfo {
  return {
    name,
    data_type: "VARCHAR2",
    is_nullable: true,
    column_default: null,
    is_primary_key: isPrimaryKey,
    extra: null,
  };
}


test("keeps declared primary keys ahead of Oracle ROWID fallback", () => {
  assert.deepEqual(editablePrimaryKeys("oracle", [column("ID", true), column("CITY")]), ["ID"]);
});

test("does not synthesize ROWID for non-Oracle keyless tables", () => {
  assert.deepEqual(editablePrimaryKeys("mysql", [column("ID"), column("CITY")]), []);
});










