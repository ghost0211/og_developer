import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { editorCursorLocation, latestQueryExecutionFeedback, sqlLineEnding, statusBarConnectionLabel } from "../../apps/desktop/src/lib/app/bottomStatusBar.ts";
import type { ConnectionConfig, QueryResult } from "../../apps/desktop/src/types/database.ts";

function result(duration: number, affectedRows: number, rows: QueryResult["rows"] = []): QueryResult {
  return { columns: rows.length ? ["value"] : [], rows, affected_rows: affectedRows, execution_time_ms: duration };
}

test("bottom status helpers expose one-based cursor locations and line endings", () => {
  assert.deepEqual(editorCursorLocation("select 1;\nfrom dual", 12), { line: 2, column: 3 });
  assert.deepEqual(editorCursorLocation("abc", 99), { line: 1, column: 4 });
  assert.deepEqual(editorCursorLocation("abc", -5), { line: 1, column: 1 });
  assert.deepEqual(editorCursorLocation("a\r\nb", 3), { line: 2, column: 1 });
  assert.deepEqual(editorCursorLocation("", Number.NaN), { line: 1, column: 1 });
  assert.equal(sqlLineEnding("a\r\nb"), "CRLF");
  assert.equal(sqlLineEnding("a\nb"), "LF");
  assert.equal(sqlLineEnding("select 1"), "LF");
});


test("bottom status connection label includes connection, engine, and version", () => {
  const connection: ConnectionConfig = {
    id: "og",
    name: "Primary",
    db_type: "opengauss",
    host: "localhost",
    port: 5432,
    username: "tester",
    password: "",
    database_info: { productName: "openGauss", productVersion: "6.0.0" },
  };
  assert.equal(statusBarConnectionLabel(connection), "Primary · openGauss 6.0.0");
  assert.equal(statusBarConnectionLabel({ ...connection, name: "openGauss" }), "openGauss 6.0.0");
  assert.equal(statusBarConnectionLabel({ ...connection, name: "openGauss 6.0.0" }), "openGauss 6.0.0");
});

test("bottom status prefers the configured openGauss identity over PostgreSQL compatibility metadata", () => {
  const connection: ConnectionConfig = {
    id: "og-compat",
    name: "Primary",
    db_type: "opengauss",
    host: "localhost",
    port: 5432,
    username: "tester",
    password: "",
    database_info: { productName: "PostgreSQL", productVersion: "9.2.4" },
  };
  assert.equal(statusBarConnectionLabel(connection), "Primary · openGauss");
});

test("app mounts a persistent 24px status bar at the bottom", () => {
  const appPath = "apps/desktop/src/App.vue";
  const statusPath = "apps/desktop/src/components/layout/BottomStatusBar.vue";
  const appSource = readFileSync(appPath, "utf8");
  const source = readFileSync(statusPath, "utf8");
  const mainEnd = appSource.indexOf("<BottomStatusBar");
  const dialogsStart = appSource.indexOf("<AppDialogs", mainEnd);

  assert.ok(mainEnd >= 0 && dialogsStart > mainEnd, "the status bar should be mounted after main content and before overlays");
  assert.match(source, /data-bottom-status-bar class="[^"]*relative z-40 isolate[^"]*h-6 min-h-6 shrink-0/);
  assert.match(source, /executionFeedback\.durationMs/);
  assert.match(source, /cursorLocation\.line/);
  assert.match(source, /UTF-8/);
  assert.match(source, /\{\{ lineEnding \}\}/);
  assert.match(source, /@change="onSchemaChange"/);
  assert.match(source, /@click="emit\('toggleAutoCommit'\)"/);

  const { descriptor, errors } = parse(source, { filename: statusPath });
  assert.deepEqual(errors, []);
  assert.ok(descriptor.template);
  const compiled = compileTemplate({ id: statusPath, filename: statusPath, source: descriptor.template.content });
  assert.deepEqual(compiled.errors, []);
});
