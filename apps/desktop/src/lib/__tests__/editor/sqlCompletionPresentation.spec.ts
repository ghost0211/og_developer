// @vitest-environment happy-dom

import { acceptCompletion, autocompletion, completionStatus, currentCompletions, snippetCompletion, startCompletion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { completionLabelPresentation } from "@/lib/editor/sqlCompletionPresentation";
import { isSqlCompletionSuppressedContext } from "@/lib/sql/sqlCompletion";

describe("SQL completion label presentation", () => {
  it("filters a custom snippet by trigger while preserving its display label", () => {
    expect(completionLabelPresentation("SELECT *", "ssf")).toEqual({
      label: "ssf SELECT *",
      displayLabel: "SELECT *",
      sortText: "SELECT *",
    });
  });

  it("leaves ordinary completion labels unchanged", () => {
    expect(completionLabelPresentation("SELECT")).toEqual({ label: "SELECT" });
    expect(completionLabelPresentation("select *", "sel")).toEqual({ label: "select *" });
  });

  it("keeps a differently named snippet visible and applicable in CodeMirror", async () => {
    const presentation = completionLabelPresentation("SELECT *", "ssf");
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc: "ssf",
        selection: { anchor: 3 },
        extensions: [
          autocompletion({
            interactionDelay: 0,
            override: [() => ({ from: 0, options: [snippetCompletion("SELECT * FROM", { ...presentation, type: "snippet" })] })],
          }),
        ],
      }),
    });

    startCompletion(view);
    await expect.poll(() => completionStatus(view.state)).toBe("active");
    expect(currentCompletions(view.state)[0]).toMatchObject({ label: "ssf SELECT *", displayLabel: "SELECT *" });
    expect(acceptCompletion(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT * FROM");
    view.destroy();
  });

  it("closes an active completion instead of requerying functions after a statement semicolon", async () => {
    const statement = "select * from yi_prod.prod_menu_op";
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc: statement,
        selection: { anchor: statement.length },
        extensions: [
          autocompletion({
            interactionDelay: 0,
            override: [
              (context) => {
                const sql = context.state.doc.toString();
                if (isSqlCompletionSuppressedContext(sql, context.pos)) return null;
                return { from: context.pos, options: [{ label: "ABS", apply: "ABS(number)", type: "function" }] };
              },
            ],
          }),
        ],
      }),
    });

    startCompletion(view);
    await expect.poll(() => completionStatus(view.state)).toBe("active");

    view.dispatch({
      changes: { from: statement.length, insert: ";" },
      selection: { anchor: statement.length + 1 },
      userEvent: "input.type",
    });

    await expect.poll(() => completionStatus(view.state)).toBe(null);
    expect(currentCompletions(view.state)).toEqual([]);
    expect(acceptCompletion(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(`${statement};`);
    view.destroy();
  });
});
