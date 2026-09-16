// @vitest-environment happy-dom

import { EditorState, StateEffect } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { highlightingFor } from "@codemirror/language";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { tags } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { loadEditorTheme, sqlSemanticHighlightTheme } from "@/lib/editor/editorThemes";
import type { EditorTheme } from "@/stores/settingsStore";

describe("SQL semantic table colors in a rendered editor", () => {
  it.each(["vscode-light", "one-dark"] satisfies EditorTheme[])("uses %s syntax colors without an undefined table color variable", async (theme) => {
    const doc = "SELECT v_role_id::integer FROM app.app_role;";
    const parent = document.body.appendChild(document.createElement("div"));
    const state = EditorState.create({ doc, extensions: [sql({ dialect: PostgreSQL }), await loadEditorTheme(theme), sqlSemanticHighlightTheme(EditorView)] });
    const typeClass = highlightingFor(state, [tags.typeName])!;
    const from = doc.indexOf("app_role");
    const decorations = Decoration.set([Decoration.mark({ class: `cm-sql-table-name ${typeClass}`, attributes: { "data-table": "true" } }).range(from, from + "app_role".length)]);
    const view = new EditorView({ parent, state: state.update({ effects: StateEffect.appendConfig.of(EditorView.decorations.of(decorations)) }).state });
    try {
      const table = view.dom.querySelector<HTMLElement>("[data-table]")!;
      const type = [...view.dom.querySelectorAll<HTMLElement>(".cm-line span")].find((node) => node.textContent === "integer")!;
      expect(table).toBeTruthy();
      expect(type).toBeTruthy();
      expect(getComputedStyle(table).color).toBe(getComputedStyle(type).color);
      expect(getComputedStyle(table).color).not.toBe(getComputedStyle(view.dom).color);
      // happy-dom reports the winning inherit declaration instead of resolving it.
      for (const child of table.querySelectorAll("span")) expect(getComputedStyle(child).color).toBe("inherit");
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("preserves the configured custom table color over the syntax fallback", async () => {
    const parent = document.body.appendChild(document.createElement("div"));
    const state = EditorState.create({ doc: "SELECT * FROM app_role", extensions: [sql({ dialect: PostgreSQL }), await loadEditorTheme("custom", "light", { table: "#ca1234" }), sqlSemanticHighlightTheme(EditorView)] });
    const from = state.doc.toString().indexOf("app_role");
    const decorations = Decoration.set([Decoration.mark({ class: `cm-sql-table-name ${highlightingFor(state, [tags.typeName])}` }).range(from, state.doc.length)]);
    const view = new EditorView({ parent, state: state.update({ effects: StateEffect.appendConfig.of(EditorView.decorations.of(decorations)) }).state });
    try {
      const table = view.dom.querySelector<HTMLElement>(".cm-sql-table-name")!;
      expect(getComputedStyle(table).color).toBe("#ca1234");
      // happy-dom reports the winning inherit declaration instead of resolving it.
      for (const child of table.querySelectorAll("span")) expect(getComputedStyle(child).color).toBe("inherit");
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
