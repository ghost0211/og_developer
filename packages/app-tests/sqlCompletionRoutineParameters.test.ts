import { strict as assert } from "node:assert";
import { nextSnippetField, prevSnippetField, snippetCompletion } from "@codemirror/autocomplete";
import { EditorState, type Transaction } from "@codemirror/state";
import { test } from "vitest";
import { buildSqlRoutineCallSnippet, routineCallParameters } from "../../apps/desktop/src/lib/sql/sqlRoutineParameters.ts";
import { buildSqlCompletionItems, getSqlFunctionSignatureHelp } from "../../apps/desktop/src/lib/sql/sqlCompletion.ts";

test("inserts PostgreSQL routine parameters and preserves overloaded functions", () => {
  const sql = "SELECT st_astext";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    columnsByTable: new Map(),
    objects: [
      { name: "st_astext", schema: "public", type: "function", signature: "geometry", dataType: "text" },
      { name: "st_astext", schema: "public", type: "function", signature: "geography, integer", dataType: "text" },
    ],
    databaseType: "postgres",
    currentSchema: "public",
  });

  const functions = items.filter((item) => item.label === "st_astext" && item.type === "function");
  assert.deepEqual(
    functions.map((item) => ({ apply: item.apply, detail: item.detail })),
    [
      { apply: "st_astext(${1:arg1})${2}", detail: "function in public  (geometry)  [text]" },
      { apply: "st_astext(${1:arg1}, ${2:arg2})${3}", detail: "function in public  (geography, integer)  [text]" },
    ],
  );
});

test("keeps repeated routine parameter types as independent snippet fields", () => {
  const sql = "SELECT add_pair";
  const item = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    columnsByTable: new Map(),
    objects: [{ name: "add_pair", schema: "public", type: "function", signature: "integer, integer", dataType: "integer" }],
    databaseType: "postgres",
    currentSchema: "public",
  }).find((candidate) => candidate.label === "add_pair");

  assert.equal(item?.apply, "add_pair(${1:arg1}, ${2:arg2})${3}");
  assert.equal(item?.detail, "function in public  (integer, integer)  [integer]");

  let state = EditorState.create({
    doc: sql,
    selection: { anchor: sql.length },
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
  const editor = {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      state = transaction.state;
    },
  };
  const completion = snippetCompletion(item?.apply ?? "", { label: item?.label ?? "" });

  assert.equal(typeof completion.apply, "function");
  if (typeof completion.apply !== "function") return;
  completion.apply(editor as never, completion, "SELECT ".length, sql.length);
  editor.dispatch(state.update(state.replaceSelection("first_value")));

  assert.equal(state.doc.toString(), "SELECT add_pair(first_value, arg2)");
});

test("splits routine parameters only on top-level commas", () => {
  const sql = "SELECT transform_value";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    columnsByTable: new Map(),
    objects: [{ name: "transform_value", schema: "public", type: "function", signature: 'numeric(10, 2), "custom,schema"."value,type"[], text[]' }],
    databaseType: "postgres",
    currentSchema: "public",
  });

  assert.equal(items.find((item) => item.label === "transform_value")?.apply, "transform_value(${1:arg1}, ${2:arg2}, ${3:arg3})${4}");
});

test("keeps empty and unavailable routine signatures as empty parentheses", () => {
  const sql = "SELECT current_marker";
  const baseInput = { tables: [], columnsByTable: new Map(), databaseType: "postgres" as const, currentSchema: "public" };

  assert.equal(buildSqlCompletionItems(sql, sql.length, { ...baseInput, objects: [{ name: "current_marker", schema: "public", type: "function", signature: "" }] }).find((item) => item.label === "current_marker")?.apply, "current_marker()");
  assert.equal(buildSqlCompletionItems(sql, sql.length, { ...baseInput, objects: [{ name: "current_marker", schema: "public", type: "function" }] }).find((item) => item.label === "current_marker")?.apply, "current_marker()");
});

const userRoutine = { name: "get_user_menu_op", schema: "app", type: "function" as const, signature: "p_user_id integer, p_menu_id integer", dataType: "text" };

test("fills a PL/SQL call with named fields, navigates backwards and exits after the closing parenthesis", () => {
  const sql = "declare\n  v_out text;\nbegin\n  v_out := app.get_user_menu_op";
  const item = buildSqlCompletionItems(sql, sql.length, { tables: [], columnsByTable: new Map(), objects: [userRoutine], databaseType: "opengauss", currentSchema: "app" }).find((item) => item.label === userRoutine.name)!;
  assert.ok(item);
  assert.equal(item.apply, "get_user_menu_op(${1:p_user_id}, ${2:p_menu_id})${3}");
  assert.ok(item.detail?.includes("p_user_id integer, p_menu_id integer"));
  let state = EditorState.create({ doc: sql + ";\nend;", selection: { anchor: sql.length } });
  const editor = {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      state = transaction.state;
    },
  };
  const completion = snippetCompletion(item.apply!, { label: item.label });
  if (typeof completion.apply !== "function") throw new Error("missing snippet application");
  completion.apply(editor as never, completion, sql.lastIndexOf(userRoutine.name), sql.length);
  const selected = () => state.sliceDoc(state.selection.main.from, state.selection.main.to);
  assert.equal(selected(), "p_user_id");
  editor.dispatch(state.update(state.replaceSelection("42")));
  assert.equal(nextSnippetField(editor as never), true);
  assert.equal(selected(), "p_menu_id");
  assert.equal(prevSnippetField(editor as never), true);
  assert.equal(selected(), "42");
  assert.equal(nextSnippetField(editor as never), true);
  editor.dispatch(state.update(state.replaceSelection("1001")));
  assert.equal(nextSnippetField(editor as never), true);
  assert.ok(state.doc.toString().endsWith("app.get_user_menu_op(42, 1001);\nend;"));
  assert.equal(state.sliceDoc(state.selection.main.head, state.selection.main.head + 1), ";");
  assert.equal(nextSnippetField(editor as never), false);
});

test("shows database routine types in a separate signature hint and tracks the argument", () => {
  const sql = "begin v_out := app.get_user_menu_op(coalesce(42, 1), ";
  const help = getSqlFunctionSignatureHelp(sql, sql.length, "opengauss", [userRoutine]);
  assert.equal(help?.name, "app.get_user_menu_op");
  assert.deepEqual(help?.overloads[0]?.parameterGroups, [["p_user_id integer", "p_menu_id integer"]]);
  assert.equal(help?.overloads[0]?.activeParameter, 1);
});

test("keeps matching overloads and respects qualified schemas", () => {
  const sql = "app.get_user_menu_op(";
  const help = getSqlFunctionSignatureHelp(sql, sql.length, "opengauss", [userRoutine, { ...userRoutine, signature: "p_user_id text" }, { ...userRoutine, schema: "other" }]);
  assert.equal(help?.overloads.length, 2);
  assert.equal(getSqlFunctionSignatureHelp("other.get_user_menu_op(", 23, "opengauss", [userRoutine]), null);
  assert.equal(getSqlFunctionSignatureHelp("app.coalesce(", 13, "opengauss", []), null);
});

test("signature hints ignore commas and parentheses in quoted arguments and comments", () => {
  for (const value of ["'a,b('", "$$a,b($$", "ARRAY[1,2]"]) {
    const sql = `app.get_user_menu_op(${value}, /* (, */ `;
    assert.equal(getSqlFunctionSignatureHelp(sql, sql.length, "opengauss", [userRoutine])?.overloads[0]?.activeParameter, 1);
  }
});

test("handles parameter modes without inserting declaration syntax", () => {
  const signature = "IN p_id integer, OUT p_result text, p_count IN OUT integer, VARIADIC p_items text[]";
  assert.equal(buildSqlRoutineCallSnippet("f", signature, "function"), "f(${1:p_id}, ${2:p_count}, ${3:p_items})${4}");
  assert.equal(buildSqlRoutineCallSnippet("p", signature, "procedure"), "p(${1:p_id}, ${2:p_result}, ${3:p_count}, ${4:p_items})${5}");
  assert.equal(buildSqlRoutineCallSnippet("f", "OUT result text", "function"), "f()");
});

test("preserves names while excluding complex types and default expressions", () => {
  const signature = `p_amount numeric(10, 2) DEFAULT round(1.2, 1), p_label text DEFAULT 'a,b''c', p_tags text[] = ARRAY['a','b'], p_note text DEFAULT $$a,b$$, "User ID" integer`;
  assert.deepEqual(
    routineCallParameters(signature, "function").map((parameter) => parameter.name),
    ["p_amount", "p_label", "p_tags", "p_note", '"User ID"'],
  );
  assert.equal(buildSqlRoutineCallSnippet("f", "p_id integer,\np_label\ncharacter varying(30)", "function"), "f(${1:p_id}, ${2:p_label})${3}");
});

test("uses generic placeholders for unnamed multiword and qualified types", () => {
  const signature = 'double precision, timestamp(3) without time zone, national character varying(20), character large object, app.custom_type, "custom schema"."value type"[], integer DEFAULT 42';
  assert.deepEqual(
    routineCallParameters(signature, "function").map((parameter) => parameter.name),
    Array(7).fill(undefined),
  );
  assert.equal(buildSqlRoutineCallSnippet("f", '"p{unsafe}" integer', "function"), "f(${1:arg1})${2}");
});

test("resolves quoted routine names and prefers the current schema for unqualified calls", () => {
  const sql = '"app"."get_user_menu_op"(';
  assert.equal(getSqlFunctionSignatureHelp(sql, sql.length, "opengauss", [userRoutine])?.overloads.length, 1);
  const unqualified = "get_user_menu_op(";
  const help = getSqlFunctionSignatureHelp(unqualified, unqualified.length, "opengauss", [userRoutine, { ...userRoutine, schema: "other", signature: "other_id text" }], "other");
  assert.deepEqual(help?.overloads[0]?.parameterGroups, [["other_id text"]]);
});
