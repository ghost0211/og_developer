import { EditorState } from "@codemirror/state";
import { codeFolding, foldable, foldEffect, foldedRanges } from "@codemirror/language";
import * as langSql from "@codemirror/lang-sql";
import { describe, expect, it } from "vitest";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { sqlBlockFolding, sqlBlockFoldRange } from "@/lib/editor/codemirrorSqlBlockFolding";

function editorState(doc: string) {
  return EditorState.create({ doc, extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, "postgres", "opengauss") }), codeFolding(), sqlBlockFolding()] });
}
function foldAt(state: EditorState, text: string) {
  const line = state.doc.lineAt(state.doc.toString().indexOf(text));
  return foldable(state, line.from, line.to);
}

describe("SQL procedural block folding", () => {
  it("folds the entire outer IF across semicolons and a nested IF", () => {
    const doc = `BEGIN
  IF v_active_cnt = 0 THEN
    UPDATE app.app_role_op SET delete_flag = 0 WHERE role_id = p_role_id;
    GET DIAGNOSTICS v_revived = ROW_COUNT;
    IF v_revived = 0 THEN
      INSERT INTO app.app_role_op(role_id) VALUES (p_role_id);
    END IF;
    SELECT row_to_json(ro) INTO v_after FROM app.app_role_op ro;
    INSERT INTO app.app_grant_log(detail) VALUES ('END IF;');
  END IF;
  SELECT count(*) INTO v_menu_active FROM app.app_role_menu;
END;`;
    const state = editorState(doc);
    const outer = foldAt(state, "IF v_active_cnt")!;
    const inner = foldAt(state, "IF v_revived")!;
    expect(outer.from).toBe(doc.indexOf("THEN") + 4);
    expect(outer.to).toBe(doc.lastIndexOf("END IF;") + "END IF;".length);
    expect(inner.to).toBe(doc.indexOf("END IF;") + "END IF;".length);
    const folded = state.update({ effects: foldEffect.of(outer) }).state;
    const ranges: Array<[number, number]> = [];
    foldedRanges(folded).between(0, doc.length, (from, to) => {
      ranges.push([from, to]);
    });
    expect(ranges).toEqual([[outer.from, outer.to]]);
    expect(doc.slice(outer.to)).toContain("SELECT count(*)");
  });

  it("includes ELSE branches and handles BEGIN, CASE, and LOOP independently", () => {
    const doc = `BEGIN
  IF ready THEN
    CASE kind
      WHEN 1 THEN NULL;
      ELSE NULL;
    END CASE;
  ELSIF other THEN
    LOOP
      EXIT;
    END LOOP;
  ELSE
    NULL;
  END IF;
END;`;
    const state = editorState(doc);
    expect(foldAt(state, "IF ready")?.to).toBe(doc.lastIndexOf("END IF;") + 7);
    expect(foldAt(state, "CASE kind")?.to).toBe(doc.indexOf("END CASE;") + 9);
    expect(foldAt(state, "LOOP\n")?.to).toBe(doc.indexOf("END LOOP;") + 9);
    expect(foldAt(state, "BEGIN")?.to).toBe(doc.length);
  });

  it("recomputes fold ranges after an edit and leaves same-line following statements visible", () => {
    let state = editorState("IF ready THEN\n  NULL;\nEND IF; SELECT 1;");
    const before = foldAt(state, "IF ready")!;
    state = state.update({ changes: { from: state.doc.toString().indexOf("NULL"), insert: "PERFORM work();\n  " } }).state;
    const after = foldAt(state, "IF ready")!;
    expect(after.to).toBeGreaterThan(before.to);
    expect(state.doc.sliceString(after.to)).toBe(" SELECT 1;");
  });

  it("falls back to SQL folding for ordinary queries and does not invent incomplete blocks", () => {
    const state = editorState("SELECT id,\n name\nFROM app.users;");
    expect(sqlBlockFoldRange(state.doc, 0, state.doc.line(1).to)).toBeNull();
    expect(foldAt(state, "SELECT")).not.toBeNull();
    const incomplete = editorState("IF ready THEN\n  NULL;\n");
    expect(sqlBlockFoldRange(incomplete.doc, 0, incomplete.doc.line(1).to)).toBeNull();
  });
});
