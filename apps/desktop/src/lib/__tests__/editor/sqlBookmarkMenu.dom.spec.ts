// @vitest-environment happy-dom

import { EditorView, lineNumbers } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { showSqlBookmarkContextMenu, sqlBookmarkExtension, toggleSqlBookmark } from "@/lib/editor/sqlBookmarks";

const labels = {
  add: "添加位置",
  remove: "删除位置",
  removeShort: "删除位置",
  menu: "书签",
  empty: "暂无书签",
  jumpTo: "跳转到第",
  clearAll: "清空全部书签",
  emptyLine: "(空行)",
};

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

  it("renders a crisp vector SVG marker and offers remove from the context menu", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = createEditor(host);

    const menu = document.querySelector<HTMLElement>(".cm-sql-bookmark-menu")!;
    rightClickLineNumber(host, 0);
    const addItem = menu.querySelector<HTMLButtonElement>(".cm-sql-bookmark-menu-item")!;
    addItem.click();

    const icon = host.querySelector<HTMLElement>(".cm-sql-bookmark-icon")!;
    expect(icon).toBeTruthy();
    expect(icon.querySelector("svg")).toBeTruthy();
    expect(icon.textContent).toBe("");

    rightClickLineNumber(host, 0);
    expect(menu.textContent).toContain(labels.remove);
  });

  it("shows line previews and supports inline remove and clear-all in the submenu", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = createEditor(host);

    const line1From = view.state.doc.line(1).from;
    const line2From = view.state.doc.line(2).from;
    toggleSqlBookmark(view, line1From);
    toggleSqlBookmark(view, line2From);
    expect(host.querySelectorAll(".cm-sql-bookmark-icon")).toHaveLength(2);

    const menu = document.querySelector<HTMLElement>(".cm-sql-bookmark-menu")!;
    showSqlBookmarkContextMenu(view, line1From, new MouseEvent("mousedown", { clientX: 30, clientY: 40 }), labels);

    expect(menu.style.display).toBe("block");
    expect(menu.textContent).toContain(labels.remove);
    expect(menu.querySelector(".cm-sql-bookmark-count")?.textContent).toBe("2");
    expect(Array.from(menu.querySelectorAll(".cm-sql-bookmark-row-line")).map((el) => el.textContent)).toEqual(["L1", "L2"]);
    expect(menu.querySelector(".cm-sql-bookmark-row-preview")?.textContent).toContain("select 1;");

    const removeRowBtns = menu.querySelectorAll<HTMLButtonElement>(".cm-sql-bookmark-row-remove");
    expect(removeRowBtns).toHaveLength(2);
    removeRowBtns[0].click();
    expect(menu.style.display).toBe("block");
    expect(host.querySelectorAll(".cm-sql-bookmark-icon")).toHaveLength(1);
    expect(menu.querySelector(".cm-sql-bookmark-count")?.textContent).toBe("1");
    expect(menu.querySelector(".cm-sql-bookmark-menu-item")?.textContent).toContain(labels.add);

    menu.querySelector<HTMLButtonElement>(".cm-sql-bookmark-clear-btn")!.click();
    expect(menu.style.display).toBe("none");
    expect(host.querySelectorAll(".cm-sql-bookmark-icon")).toHaveLength(0);
  });
});
