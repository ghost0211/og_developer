import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { createDbxCodeMirrorSqlDialect } from "../../apps/desktop/src/lib/editor/codemirrorSqlDialect.ts";
import { codeMirrorSqlDialect, codeMirrorSqlDialectForConnection } from "../../apps/desktop/src/lib/database/jdbcDialect.ts";
import type { DatabaseType } from "../../apps/desktop/src/types/database.ts";

function hasKeyword(keywords: string | undefined, keyword: string): boolean {
  return new RegExp(`(?:^|\\s)${keyword}(?:\\s|$)`, "i").test(keywords || "");
}

function countParsedNodes(dialect: langSql.SQLDialect, sql: string, nodeName: string, text: string): number {
  const tree = dialect.language.parser.parse(sql);
  const cursor = tree.cursor();
  let count = 0;
  do {
    if (cursor.name === nodeName && sql.slice(cursor.from, cursor.to).toLowerCase() === text.toLowerCase()) count++;
  } while (cursor.next());
  return count;
}

test("keeps generic JDBC on Standard SQL without the ASE editor override", () => {
  const dialect = createDbxCodeMirrorSqlDialect(langSql, "mysql", "jdbc");

  assert.equal(countParsedNodes(dialect, "SELECT top 1 * FROM wfAdmin AS wa", "Keyword", "top"), 0);
});

test.each(["opengauss", "postgres", "mysql", "doris"] satisfies DatabaseType[])("keeps bare and qualified metadata columns as identifiers in %s", (databaseType) => {
  const dialect = createDbxCodeMirrorSqlDialect(langSql, codeMirrorSqlDialect(databaseType), databaseType);
  for (const qualify of [false, true]) {
    for (const names of [
      ["schema_name", "table_name"],
      ["Schema_Name", "TABLE_NAME"],
    ]) {
      const [schemaName, tableName] = names;
      const prefix = qualify ? "t." : "";
      const sql = `select ${prefix}${schemaName},${prefix}${tableName} from ddd.pdm_table${qualify ? " t" : ""} where ${prefix}${schemaName} = 'dbo';`;
      assert.equal(countParsedNodes(dialect, sql, "Identifier", schemaName), 2, sql);
      assert.equal(countParsedNodes(dialect, sql, "Identifier", tableName), 1, sql);
      assert.equal(countParsedNodes(dialect, sql, "Keyword", schemaName), 0, sql);
      assert.equal(countParsedNodes(dialect, sql, "Keyword", tableName), 0, sql);
      for (const keyword of ["select", "from", "where"]) assert.equal(countParsedNodes(dialect, sql, "Keyword", keyword), 1, sql);
    }
  }
});

test("keeps metadata diagnostic names out of keywords without stripping real SCHEMA/TABLE keywords", () => {
  for (const databaseType of ["opengauss", "mysql"] satisfies DatabaseType[]) {
    const dialect = createDbxCodeMirrorSqlDialect(langSql, codeMirrorSqlDialect(databaseType), databaseType);
    const sql = "SELECT catalog_name, column_name FROM information_schema.columns; CREATE SCHEMA app; CREATE TABLE app.test_table(schema_name text, table_name text);";
    for (const name of ["catalog_name", "column_name", "schema_name", "table_name"]) assert.equal(countParsedNodes(dialect, sql, "Identifier", name), 1, name);
    for (const keyword of ["SCHEMA", "TABLE"]) assert.equal(countParsedNodes(dialect, sql, "Keyword", keyword), 1, keyword);
  }
});

test("preserves SQL Server SCHEMA_NAME builtin and PostgreSQL CURRENT_SCHEMA keyword", () => {
  const sqlServer = createDbxCodeMirrorSqlDialect(langSql, "sqlserver", "sqlserver");
  assert.equal(countParsedNodes(sqlServer, "SELECT SCHEMA_NAME(1)", "Builtin", "SCHEMA_NAME"), 1);
  const postgres = createDbxCodeMirrorSqlDialect(langSql, "postgres", "opengauss");
  assert.equal(countParsedNodes(postgres, "SELECT CURRENT_SCHEMA", "Keyword", "CURRENT_SCHEMA"), 1);
});

test("keeps DBX PostgreSQL procedural dialect extensions", () => {
  const dialect = createDbxCodeMirrorSqlDialect(langSql, "postgres");

  assert.equal(hasKeyword(dialect.spec.keywords, "PERFORM"), true);
  assert.equal(hasKeyword(dialect.spec.types, "JSONB"), true);
  assert.equal(hasKeyword(dialect.spec.builtin, "TG_NAME"), true);
});

test("treats compact double-dash comments as comments in non-MySQL SQL dialects", () => {
  const databaseTypes: DatabaseType[] = [
    "oracle",
    "dameng",
    "yashandb",
    "oscar",
    "oceanbase-oracle",
    "sqlite",
    "rqlite",
    "turso",
    "cloudflare-d1",
    "postgres",
    "redshift",
    "gaussdb",
    "kwdb",
    "kingbase",
    "highgo",
    "vastbase",
    "opengauss",
    "questdb",
    "sqlserver",
    "cassandra",
    "clickhouse",
    "duckdb",
    "databend",
    "db2",
    "hive",
    "spark",
  ];

  for (const databaseType of databaseTypes) {
    const dialect = createDbxCodeMirrorSqlDialect(langSql, codeMirrorSqlDialect(databaseType), databaseType);
    assert.equal(countParsedNodes(dialect, "--SELECT 1", "LineComment", "--SELECT 1"), 1, databaseType);
    assert.equal(countParsedNodes(dialect, "--SELECT 1", "Keyword", "SELECT"), 0, databaseType);
  }
});

test("propagates database type to every DDL viewer entrypoint", () => {
  const ddlViewDialog = readFileSync("apps/desktop/src/components/objects/DdlViewDialog.vue", "utf8");
  const connectionTree = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
  const app = readFileSync("apps/desktop/src/App.vue", "utf8");

  assert.match(ddlViewDialog, /createDbxCodeMirrorSqlDialect\(langSql, props\.dialect, props\.databaseType\)/);
  assert.match(connectionTree, /<SidebarDdlViewDialog/);
  assert.match(connectionTree, /:database-type="sidebarDdlDatabaseType"/);
  assert.match(connectionTree, /v-model:open="sidebarDdlOpen"/);
  assert.match(app, /<QueryEditorDdlViewDialog[^>]*:database-type="queryEditorDdlDatabaseType"[^>]*\/>/);
});
