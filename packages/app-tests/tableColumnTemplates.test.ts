import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createTableColumnTemplateDrafts, DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS, normalizeTableColumnTemplateFields, parseTableColumnTemplateFields, PRESET_FIELDS_TEMPLATE_ID, tableColumnTemplates, TABLE_COLUMN_TEMPLATE_DATABASE_TYPES } from "../../apps/desktop/src/lib/table/tableColumnTemplates.ts";

const sixCustomFields = [
  "tenant_id | mysql:bigint | postgres:uuid | default:0 | comment:Tenant",
  "request_id | mysql:varchar(64) | postgres:varchar(64)",
  "created_time | mysql:datetime | postgres:timestamp | default:CURRENT_TIMESTAMP",
  "modified_time | mysql:datetime | postgres:timestamp",
  "creator_id | mysql:bigint | postgres:bigint",
  "modifier_id | mysql:bigint | postgres:bigint | required:false",
];

test("has no built-in preset field names by default", () => {
  assert.deepEqual(DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS, []);
  assert.deepEqual(normalizeTableColumnTemplateFields(undefined), []);
  assert.deepEqual(normalizeTableColumnTemplateFields([]), []);
  assert.deepEqual(tableColumnTemplates(), [
    {
      id: PRESET_FIELDS_TEMPLATE_ID,
      labelKey: "structureEditor.presetFieldsTemplate",
      columnNames: [],
    },
  ]);
});

test("builds no preset field drafts until users configure fields", () => {
  const columns = createTableColumnTemplateDrafts({
    templateId: PRESET_FIELDS_TEMPLATE_ID,
    databaseType: "postgres",
    createId: () => "id",
  });

  assert.deepEqual(columns, []);
});


test("filters configured fields by current database type", () => {
  const columns = createTableColumnTemplateDrafts({
    templateId: PRESET_FIELDS_TEMPLATE_ID,
    databaseType: "postgres",
    columnNames: ["mysql_only | mysql:bigint", "postgres_only | postgres:uuid", "common_name | mysql:<empty> | postgres:<empty>", "common_code | mysql:varchar(64) | postgres:varchar(32)"],
    createId: () => "id",
  });

  assert.deepEqual(
    columns.map((column) => ({ name: column.name, dataType: column.dataType })),
    [
      { name: "postgres_only", dataType: "uuid" },
      { name: "common_name", dataType: "" },
      { name: "common_code", dataType: "varchar(32)" },
    ],
  );
});



