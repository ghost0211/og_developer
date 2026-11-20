// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, showTooltip, tooltips, type Tooltip } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { editorFontTheme } from "@/lib/editor/editorThemes";
import { resolveQueryEditorTooltipParent } from "@/lib/editor/sqlHoverTooltip";

function staticTooltip(label: string): Tooltip {
  return {
    pos: 0,
    create: () => {
      const dom = document.createElement("div");
      dom.dataset.tooltip = label;
      return { dom };
    },
  };
}

describe("CodeMirror tooltip host", () => {
  it("keeps containers independent and removes them with each editor", () => {
    document.body.innerHTML = '<div id="root"><div data-app><div data-split-pane><div data-editor="first"></div><div data-editor="second"></div></div><div id="ogdeveloper-query-editor-tooltip-root" style="position: fixed; width: 0; height: 0; overflow: visible"></div></div></div>';
    const root = document.querySelector<HTMLElement>("#root")!;
    const splitPane = document.querySelector<HTMLElement>("[data-split-pane]")!;
    const tooltipHost = document.querySelector<HTMLElement>("#ogdeveloper-query-editor-tooltip-root")!;
    const firstEditor = document.querySelector<HTMLElement>('[data-editor="first"]')!;
    const secondEditor = document.querySelector<HTMLElement>('[data-editor="second"]')!;
    root.style.overflow = "hidden";
    splitPane.style.overflow = "hidden";
    const editorTheme = EditorView.theme({ "&": { backgroundColor: "rgb(255, 255, 255)" } });
    const editorExtensions = [editorTheme, editorFontTheme(EditorView, 13, "monospace", { fixedHeight: true })];

    const firstView = new EditorView({
      parent: firstEditor,
      state: EditorState.create({
        doc: "select first",
        extensions: [...editorExtensions, tooltips({ parent: tooltipHost }), showTooltip.of(staticTooltip("first"))],
      }),
    });
    const secondView = new EditorView({
      parent: secondEditor,
      state: EditorState.create({
        doc: "select second",
        extensions: [...editorExtensions, tooltips({ parent: tooltipHost }), showTooltip.of(staticTooltip("second"))],
      }),
    });

    const firstTooltip = root.querySelector<HTMLElement>('[data-tooltip="first"]')!;
    const secondTooltip = root.querySelector<HTMLElement>('[data-tooltip="second"]')!;
    const firstContainer = firstTooltip.parentElement!;
    const secondContainer = secondTooltip.parentElement!;

    expect(splitPane.contains(firstTooltip)).toBe(false);
    expect(firstContainer.parentElement).toBe(tooltipHost);
    expect(secondContainer.parentElement).toBe(tooltipHost);
    expect(root.children).toHaveLength(1);
    expect(tooltipHost.style.width).toBe("0px");
    expect(tooltipHost.style.height).toBe("0px");
    expect(getComputedStyle(firstContainer).height).toBe("100%");
    expect(getComputedStyle(firstContainer).backgroundColor).toBe("rgb(255, 255, 255)");
    expect(firstContainer).not.toBe(secondContainer);
    expect(firstTooltip.style.position).toBe("fixed");
    expect(secondTooltip.style.position).toBe("fixed");

    firstView.destroy();
    expect(firstContainer.isConnected).toBe(false);
    expect(secondContainer.isConnected).toBe(true);

    secondView.destroy();
    expect(secondContainer.isConnected).toBe(false);
  });

  it("resolves the global tooltip root even when the editor is detached or in a dialog portal", () => {
    document.body.innerHTML = '<div id="root"><div id="ogdeveloper-query-editor-tooltip-root"></div><div data-editor="inside"></div></div><div data-dialog-portal><div data-editor="dialog"></div></div>';
    const tooltipHost = document.getElementById("ogdeveloper-query-editor-tooltip-root")!;
    const insideEditor = document.querySelector<HTMLElement>('[data-editor="inside"]')!;
    const dialogEditor = document.querySelector<HTMLElement>('[data-editor="dialog"]')!;
    const detachedEditor = document.createElement("div");

    expect(resolveQueryEditorTooltipParent(insideEditor)).toBe(tooltipHost);
    expect(resolveQueryEditorTooltipParent(dialogEditor)).toBe(tooltipHost);
    expect(resolveQueryEditorTooltipParent(detachedEditor)).toBe(tooltipHost);
  });
});
