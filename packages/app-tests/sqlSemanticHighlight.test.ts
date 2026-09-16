import { strict as assert } from "node:assert";
import { test } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { sqlSemanticTableNameSpansForSyntaxTree } from "../../apps/desktop/src/lib/editor/codemirrorSqlSemanticHighlight.ts";
import { expandToSqlStatementWindow } from "../../apps/desktop/src/lib/sql/insertValueHints.ts";

test.each([
  ["string", `'${"x".repeat(40 * 1024)} FROM fake'`],
  ["block comment", `/* ${"x".repeat(40 * 1024)} FROM fake */`],
])("preserves %s context when the highlight window starts inside it", (_name, suppressedSql) => {
  const sql = `SELECT ${suppressedSql} AS payload;\nSELECT * FROM real_table;`;
  const realTable = sql.indexOf("real_table");
  const window = expandToSqlStatementWindow(sql, realTable, realTable + "real_table".length);
  const tree = langSql.StandardSQL.language.parser.parse(sql);

  assert.ok(window.from > sql.indexOf(suppressedSql));
  assert.deepEqual(
    sqlSemanticTableNameSpansForSyntaxTree(sql, window, tree).map((span) => sql.slice(span.start, span.end)),
    ["real_table"],
  );
});

test("keeps procedural variables and branch keywords out of table decorations", () => {
  const sql = `DECLARE
  v_role_id integer;
BEGIN
  SELECT r.role_id, r.app_system_id, r.role_source_dict, r.delete_flag
    INTO v_role_id, v_app_system_id, v_role_source, v_delete_flag
    FROM app.app_role r
    WHERE r.role_id = p_role_id FOR UPDATE;
  EXCEPTION WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'role missing: %', p_role_id;
  END;
  IF v_role_source IS DISTINCT FROM 'CUSTOM' THEN
    RAISE EXCEPTION 'source: %, role: %',
      v_role_source, p_role_id;
  END IF;
  BEGIN
    SELECT mo.menu_op_id INTO v_menu_op_id
      FROM app.app_menu_op mo WHERE mo.menu_id = p_menu_id;
  END;
END;`;
  const tree = langSql.PostgreSQL.language.parser.parse(sql);
  const spans = sqlSemanticTableNameSpansForSyntaxTree(sql, { from: 0, to: sql.length }, tree, { databaseType: "opengauss" });
  assert.deepEqual(
    spans.map((span) => sql.slice(span.start, span.end)),
    ["app_role", "app_menu_op"],
  );
  // Viewport windows can start after DECLARE/BEGIN; INTO still means variables.
  const from = sql.indexOf("SELECT mo");
  assert.deepEqual(
    sqlSemanticTableNameSpansForSyntaxTree(sql, { from, to: sql.length }, tree, { databaseType: "opengauss" }).map((span) => sql.slice(span.start, span.end)),
    ["app_menu_op"],
  );
});

test.each([
  ["SELECT * FROM users; RAISE EXCEPTION 'message', first_value, second_value;", ["users"]],
  ["IF a IS NOT DISTINCT FROM b THEN RAISE EXCEPTION 'bad', c, d; END IF;", []],
  ["SELECT extract(year FROM timestamp '2026-01-01') FROM events;", ["events"]],
  ["SELECT * FROM users u, orders o WHERE u.id = o.id;", ["users", "orders"]],
  ["BEGIN SELECT id INTO STRICT result_id FROM source_table; INSERT INTO audit_log(id) VALUES (result_id); END;", ["source_table", "audit_log"]],
  ["SELECT id INTO result_table FROM source_table;", ["result_table", "source_table"]],
  ["BEGIN INSERT INTO audit_log(id) VALUES (1) RETURNING id INTO result_id; END;", ["audit_log"]],
  ["BEGIN EXECUTE 'SELECT * FROM hidden_table' INTO result_value USING input_value; END;", []],
  ["MERGE INTO target t USING source s ON t.id=s.id WHEN MATCHED THEN UPDATE SET id=s.id;", ["target", "source"]],
])("limits table colors to relations: %s", (sql, expected) => {
  const tree = langSql.PostgreSQL.language.parser.parse(sql);
  assert.deepEqual(
    sqlSemanticTableNameSpansForSyntaxTree(sql, { from: 0, to: sql.length }, tree, { databaseType: "postgres" }).map((span) => sql.slice(span.start, span.end)),
    expected,
  );
});
