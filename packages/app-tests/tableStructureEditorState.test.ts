import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  applyManticoreDdlColumnExtras,
  buildStructureTargetLabel,
  canEditManticoreColumnProperties,
  combineDataTypeForDatabase,
  createColumnDrafts,
  createIndexDrafts,
  dataTypeLengthInputValue,
  filterStructureIndexColumnOptions,
  generateIndexName,
  generateUniqueIndexName,
  getColumnEditorControls,
  getDataTypeOptions,
  isProtectedManticoreIdColumn,
  isDamengIdentityCompatibleDataType,
  isMysqlEnumDataType,
  isSqlServerIdentityCompatibleDataType,
  mysqlEnumDataType,
  normalizeDataTypeParams,
  normalizeStructureIndexType,
  parseExtraToColumnExtra,
  rehydrateColumnDraftsFromMetadata,
  resolveInsertColumnIndex,
  sameStructureIndexType,
  toColumnNames,
} from "../../apps/desktop/src/lib/table/tableStructureEditorState.ts";
import { firstStructureMetadataTab, isStructureMetadataTabSupported } from "../../apps/desktop/src/lib/table/tableMetadataCapabilities.ts";
import type { ColumnInfo, IndexInfo, TableInfoTab } from "../../apps/desktop/src/types/database.ts";

const columns: ColumnInfo[] = [
  {
    name: "id",
    data_type: "bigint",
    is_nullable: false,
    column_default: null,
    is_primary_key: true,
    extra: "auto_increment",
    comment: "identifier",
  },
  {
    name: "name",
    data_type: "varchar(120)",
    is_nullable: true,
    column_default: "'guest'",
    is_primary_key: false,
    extra: null,
    comment: null,
  },
];

const indexes: IndexInfo[] = [
  { name: "PRIMARY", columns: ["id"], is_unique: true, is_primary: true },
  { name: "idx_name", columns: ["name"], is_unique: false, is_primary: false },
];

test("resolves insert index after the selected column for all databases", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  assert.equal(resolveInsertColumnIndex(items, null), 3);
  assert.equal(resolveInsertColumnIndex(items, undefined), 3);
  assert.equal(resolveInsertColumnIndex(items, "a"), 1);
  assert.equal(resolveInsertColumnIndex(items, "b"), 2);
  assert.equal(resolveInsertColumnIndex(items, "c"), 3);
  assert.equal(resolveInsertColumnIndex(items, "missing"), 3);
  assert.equal(resolveInsertColumnIndex([], "a"), 0);
  assert.equal(resolveInsertColumnIndex([{ id: "a", markedForDrop: true }, { id: "b" }], "a"), 2);
});


test("rehydrates restored existing column drafts from live metadata", () => {
  const drafts = rehydrateColumnDraftsFromMetadata(
    [
      {
        id: "existing:id",
        name: "id",
        dataType: "varchar(10)",
        isNullable: true,
        defaultValue: "",
        comment: "",
        isPrimaryKey: false,
        extra: {},
        markedForDrop: false,
      },
      {
        id: "existing:data",
        name: "data",
        dataType: "timestamp",
        isNullable: true,
        defaultValue: "",
        comment: "",
        isPrimaryKey: false,
        extra: {},
        markedForDrop: false,
      },
      {
        id: "new:note",
        name: "note",
        dataType: "varchar2(100)",
        isNullable: true,
        defaultValue: "",
        comment: "",
        isPrimaryKey: false,
        extra: {},
        markedForDrop: false,
      },
    ],
    [
      {
        name: "id",
        data_type: "varchar(10)",
        is_nullable: true,
        column_default: null,
        is_primary_key: false,
        extra: null,
        comment: null,
      },
      {
        name: "data",
        data_type: "timestamp",
        is_nullable: true,
        column_default: null,
        is_primary_key: false,
        extra: null,
        comment: null,
      },
    ],
    "oracle",
  );

  assert.equal(drafts[0].original?.name, "id");
  assert.equal(drafts[0].originalPosition, 0);
  assert.equal(drafts[1].original?.name, "data");
  assert.equal(drafts[1].originalPosition, 1);
  assert.equal(drafts[2].original, undefined);
});

test("normalizes PostgreSQL string default casts in editable column drafts", () => {
  const drafts = createColumnDrafts(
    [
      {
        name: "category",
        data_type: "character varying",
        is_nullable: true,
        column_default: "''::character varying",
        is_primary_key: false,
        extra: null,
        comment: null,
      },
      {
        name: "status",
        data_type: "user_status",
        is_nullable: true,
        column_default: "'active'::public.user_status",
        is_primary_key: false,
        extra: null,
        comment: null,
      },
      {
        name: "stock",
        data_type: "integer",
        is_nullable: true,
        column_default: "0",
        is_primary_key: false,
        extra: null,
        comment: null,
      },
    ],
    "postgres",
  );

  assert.equal(drafts[0].defaultValue, "''");
  assert.equal(drafts[0].original?.column_default, "''");
  assert.equal(drafts[1].defaultValue, "'active'::public.user_status");
  assert.equal(drafts[1].original?.column_default, "'active'::public.user_status");
  assert.equal(drafts[2].defaultValue, "0");
  assert.equal(drafts[2].original?.column_default, "0");
});











test("creates editable index drafts and splits pasted column lists", () => {
  const drafts = createIndexDrafts(indexes);

  assert.deepEqual(
    drafts.map((draft) => ({
      id: draft.id,
      name: draft.name,
      columns: draft.columns,
      isUnique: draft.isUnique,
      isPrimary: draft.isPrimary,
      originalName: draft.original?.name,
    })),
    [
      {
        id: "existing:PRIMARY",
        name: "PRIMARY",
        columns: ["id"],
        isUnique: true,
        isPrimary: true,
        originalName: "PRIMARY",
      },
      {
        id: "existing:idx_name",
        name: "idx_name",
        columns: ["name"],
        isUnique: false,
        isPrimary: false,
        originalName: "idx_name",
      },
    ],
  );
  assert.equal(toColumnNames(["id", "name"]), "id, name");
});

test("keeps unavailable selected index fields removable", () => {
  assert.deepEqual(filterStructureIndexColumnOptions(["id", "customer_id", "name"], ["platform_code"]), ["platform_code", "id", "customer_id", "name"]);
  assert.deepEqual(filterStructureIndexColumnOptions(["id", "customer_id", "name"], ["customer_id", "platform_code"]), ["platform_code", "id", "customer_id", "name"]);
  assert.deepEqual(filterStructureIndexColumnOptions(["id", "customer_id", "name"], ["platform_code"], "PLAT"), ["platform_code"]);
});

test("normalizes Postgres lowercase index types when creating structure drafts", () => {
  const postgresIndexes: IndexInfo[] = [
    {
      name: "system_big_screen_asset_pkey",
      columns: ["id"],
      is_unique: true,
      is_primary: true,
      index_type: "btree",
    },
    {
      name: "SYSTEM_BIG_SCREEN_ASSET_TAGS_JSON_IDX",
      columns: ["tags_json"],
      is_unique: false,
      is_primary: false,
      index_type: "gin",
    },
    {
      name: "idx_hash",
      columns: ["name"],
      is_unique: false,
      is_primary: false,
      index_type: "hash",
    },
  ];

  const drafts = createIndexDrafts(postgresIndexes);
  assert.deepEqual(
    drafts.map((draft) => ({ name: draft.name, indexType: draft.indexType })),
    [
      { name: "system_big_screen_asset_pkey", indexType: "BTREE" },
      { name: "SYSTEM_BIG_SCREEN_ASSET_TAGS_JSON_IDX", indexType: "GIN" },
      { name: "idx_hash", indexType: "HASH" },
    ],
  );

  // Uppercased drafts must not look like a type change vs Postgres amname.
  assert.equal(sameStructureIndexType(drafts[0]!.indexType, postgresIndexes[0]!.index_type), true);
  assert.equal(sameStructureIndexType("BTREE", "btree"), true);
  assert.equal(sameStructureIndexType("GIN", "hash"), false);
  assert.equal(normalizeStructureIndexType("  gist "), "GIST");
});

test("generates conventional index names from table and columns", () => {
  assert.equal(generateIndexName("A", ["B"]), "A_B_IDX");
  assert.equal(generateIndexName("order item", ["customer-id", "created_at"]), "ORDER_ITEM_CUSTOMER_ID_CREATED_AT_IDX");
  assert.equal(generateIndexName("users", ["email"], 12), "USERS_EM_IDX");
});

test("generates unique index names when automatic name already exists", () => {
  assert.equal(generateUniqueIndexName("users", ["email"], ["USERS_EMAIL_IDX"]), "USERS_EMAIL_IDX_2");
  assert.equal(generateUniqueIndexName("users", ["email"], ["users_email_idx", "USERS_EMAIL_IDX_2"]), "USERS_EMAIL_IDX_3");
});

test("structure editor target label omits duplicate database and schema", () => {
  assert.equal(buildStructureTargetLabel("online-clickhouse", "testdb", "testdb", "users"), "online-clickhouse / testdb / users");
  assert.equal(buildStructureTargetLabel("online-postgres", "app", "public", "users"), "online-postgres / app / public / users");
});








const fullCapabilities = { columns: true, indexes: true, foreignKeys: true, triggers: true, ddl: true };
const noDdlCapabilities = { columns: true, indexes: true, foreignKeys: true, triggers: true, ddl: false };
const ddlOnlyCapabilities = { columns: false, indexes: false, foreignKeys: false, triggers: false, ddl: true };

test("defaults to columns tab for edit mode with full capabilities", () => {
  assert.equal(firstStructureMetadataTab(fullCapabilities, false), "columns");
});

test("defaults to columns tab for create mode", () => {
  assert.equal(firstStructureMetadataTab(fullCapabilities, true), "columns");
});

test("falls back to columns tab when DDL is not available in edit mode", () => {
  assert.equal(firstStructureMetadataTab(noDdlCapabilities, false), "columns");
});

test("falls back to DDL when no editable metadata tab is available", () => {
  assert.equal(firstStructureMetadataTab(ddlOnlyCapabilities, false), "ddl");
});

test("preserves a restored structure draft tab without an explicit initial tab", () => {
  const source = readFileSync("apps/desktop/src/components/structure/TableStructureEditor.vue", "utf8");
  const restoredDraftBlock = source.match(/if \(props\.draft\?\.initialized\) \{[\s\S]*?\n  \} else if/);

  assert.ok(restoredDraftBlock);
  assert.match(restoredDraftBlock[0], /restoreDraft\(props\.draft\);[\s\S]*applyInitialStructureTab\(false\);/);
});

test("supports DDL tab in edit mode", () => {
  assert.equal(isStructureMetadataTabSupported("ddl", fullCapabilities, false), true);
});

test("does not support DDL tab in create mode", () => {
  assert.equal(isStructureMetadataTabSupported("ddl", fullCapabilities, true), false);
});

test("does not support DDL tab when capability is disabled", () => {
  assert.equal(isStructureMetadataTabSupported("ddl", noDdlCapabilities, false), false);
});

test("supports columns tab in both modes", () => {
  assert.equal(isStructureMetadataTabSupported("columns", fullCapabilities, false), true);
  assert.equal(isStructureMetadataTabSupported("columns", fullCapabilities, true), true);
});
