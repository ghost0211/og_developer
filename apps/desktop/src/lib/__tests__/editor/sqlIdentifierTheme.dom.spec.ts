// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as langSql from "@codemirror/lang-sql";
import { describe, expect, it } from "vitest";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { loadEditorTheme } from "@/lib/editor/editorThemes";
import type { EditorTheme } from "@/stores/settingsStore";

const sql = `select t.schema_name,t.table_name
from ddd.pdm_table t
where t.schema_name = 'dbo';

select schema_name,table_name
from ddd.pdm_table
where schema_name = 'dbo';`;

describe("bare and qualified SQL column colors", () => {
  it.each(["vscode-light", "one-dark", "custom"] satisfies EditorTheme[])("renders metadata columns as identifiers rather than keywords in %s", async (theme) => {
    const parent = document.body.appendChild(document.createElement("div"));
    const state = EditorState.create({
      doc: sql,
      extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, "postgres", "opengauss") }), await loadEditorTheme(theme, "light", { keyword: "#ff6600", variable: "#123456" })],
    });
    const view = new EditorView({ parent, state });
    try {
      const spans = [...view.dom.querySelectorAll<HTMLElement>(".cm-line span")];
      const select = spans.find((span) => span.textContent?.trim() === "select")!;
      expect(select).toBeTruthy();
      const keywordColor = getComputedStyle(select).color;
      for (const name of ["schema_name", "table_name"]) {
        const columns = spans.filter((span) => span.textContent?.trim() === name);
        expect(columns).toHaveLength(name === "schema_name" ? 4 : 2);
        const identifierColor = getComputedStyle(columns[0]).color;
        expect(identifierColor).not.toBe(keywordColor);
        for (const column of columns) expect(getComputedStyle(column).color).toBe(identifierColor);
      }
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
