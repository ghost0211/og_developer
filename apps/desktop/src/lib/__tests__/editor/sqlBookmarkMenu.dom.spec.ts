// @vitest-environment happy-dom

import { EditorView, lineNumbers } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { showSqlBookmarkContextMenu, sqlBookmarkExtension } from "@/lib/editor/sqlBookmarks";

const labels = { add: "添加位置", remove: "删除位置", removeShort: "删除位置", menu: "书签", empty: "暂无书签", jumpTo: "跳转到第" };

function createEditor(host: HTMLElement) {
  return new EditorView({
    doc: "select 1;\nselect 2;\nselect 3;",
    parent: host,
    extensions: [
      sqlBookmarkExtension(),
      lineNumbers({
        domEventHandlers: {
          mousedown(v, line, event) {
            const mouse = event as MouseEvent;
            if (mouse.button === 2) {
              mouse.preventDefault();
              mouse.stopPropagation();
              return showSqlBookmarkContextMenu(v, line.from, mouse, labels);
            }
            return false;
          },
        },
      }),
    ],
  });
}

function rightClickLineNumber(host: HTMLElement, lineIndex: number) {
  const el = host.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")[lineIndex];
  expect(el).toBeTruthy();
  el!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 40 }));
}

describe("sql bookmark gutter context menu", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    view?.destroy();
    host?.remove();
    view = null;
    host = null;
  });

  it("lives inside .cm-editor so the baseTheme menu styles match", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = createEditor(host);

    const menu = document.querySelector<HTMLElement>(".cm-sql-bookmark-menu")!;
    expect(menu).toBeTruthy();
    // EditorView.baseTheme scopes rules to the editor element; the menu must
    // be a descendant of .cm-editor or it renders unstyled and invisible.
    expect(menu.closest(".cm-editor")).toBe(view.dom);
  });

  it("opens on gutter right-click mousedown and hides on outside pointerdown", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = createEditor(host);

    const menu = document.querySelector<HTMLElement>(".cm-sql-bookmark-menu")!;
    expect(menu.style.display).toBe("none");

    rightClickLineNumber(host, 1);
    expect(menu.style.display).toBe("block");
    expect(menu.style.left).toBe("30px");
    expect(menu.textContent).toContain(labels.add);

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(menu.style.display).toBe("none");
  });

  it("adds a bookmark from the menu and offers to remove it", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = createEditor(host);

    const menu = document.querySelector<HTMLElement>(".cm-sql-bookmark-menu")!;
    rightClickLineNumber(host, 0);
    const addItem = menu.querySelector<HTMLButtonElement>(".cm-sql-bookmark-menu-item")!;
    addItem.click();
    expect(host.querySelector(".cm-sql-bookmark-icon")).toBeTruthy();

    rightClickLineNumber(host, 0);
    expect(menu.textContent).toContain(labels.remove);
  });
});
