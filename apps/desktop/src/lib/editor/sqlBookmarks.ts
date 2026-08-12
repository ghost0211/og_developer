import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, keymap } from "@codemirror/view";

// ogdeveloper: SQL bookmarks with auto-names (位置1, 位置2, …).
// - click the gutter left of the line numbers to toggle a bookmark (🔖)
// - right-click the line-number gutter for 添加位置 / 删除位置 / 书签 submenu
// - F2 / Shift-F2 jump between bookmarks

export interface SqlBookmark {
  lineStart: number;
  name: string;
}

export interface SqlBookmarkMenuLabels {
  add: string;
  remove: string;
  removeShort: string;
  menu: string;
  empty: string;
  jumpTo: string;
}

const addBookmarkEffect = StateEffect.define<{ lineStart: number; name: string }>();
const removeBookmarkEffect = StateEffect.define<number>();

class SqlBookmarkMarker extends GutterMarker {
  constructor(readonly name: string) {
    super();
  }
  override eq(other: SqlBookmarkMarker) {
    return other.name === this.name;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-sql-bookmark-icon";
    el.textContent = "🔖";
    el.setAttribute("aria-label", `bookmark ${this.name}`);
    el.title = this.name;
    return el;
  }
}

class SqlBookmarkSpacer extends GutterMarker {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-sql-bookmark-spacer";
    return el;
  }
}

const bookmarkField = StateField.define<RangeSet<SqlBookmarkMarker>>({
  create: () => RangeSet.empty,
  update(markers, transaction) {
    let next = markers.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(addBookmarkEffect)) {
        const { lineStart, name } = effect.value;
        next = next.update({ filter: (from) => from !== lineStart, add: [new SqlBookmarkMarker(name).range(lineStart)] });
      } else if (effect.is(removeBookmarkEffect)) {
        next = next.update({ filter: (from) => from !== effect.value });
      }
    }
    return next;
  },
});

// Monotonic per-view name counter (位置1, 位置2, … by add order).
const viewNameCounters = new WeakMap<EditorView, number>();

function nameForNewBookmark(view: EditorView): string {
  const current = viewNameCounters.get(view) ?? 1;
  viewNameCounters.set(view, current + 1);
  return `位置${current}`;
}

export function sqlBookmarkList(view: EditorView): SqlBookmark[] {
  const result: SqlBookmark[] = [];
  const iter = view.state.field(bookmarkField).iter();
  while (iter.value) {
    result.push({ lineStart: iter.from, name: iter.value.name });
    iter.next();
  }
  return result;
}

export function toggleSqlBookmark(view: EditorView, lineStart: number) {
  let exists = false;
  view.state.field(bookmarkField).between(lineStart, lineStart, () => {
    exists = true;
  });
  if (exists) {
    view.dispatch({ effects: removeBookmarkEffect.of(lineStart) });
  } else {
    view.dispatch({ effects: addBookmarkEffect.of({ lineStart, name: nameForNewBookmark(view) }) });
  }
}

export function removeSqlBookmark(view: EditorView, lineStart: number) {
  view.dispatch({ effects: removeBookmarkEffect.of(lineStart) });
}

export function jumpToSqlBookmark(view: EditorView, lineStart: number) {
  view.dispatch({
    selection: { anchor: lineStart },
    effects: EditorView.scrollIntoView(lineStart, { y: "center" }),
  });
  view.focus();
}

function jumpToBookmark(view: EditorView, direction: 1 | -1): boolean {
  const bookmarks = sqlBookmarkList(view);
  if (!bookmarks.length) return false;
  const current = view.state.selection.main.head;
  const currentLineStart = view.state.doc.lineAt(current).from;
  let target: SqlBookmark | undefined;
  if (direction === 1) {
    target = bookmarks.find((b) => b.lineStart > currentLineStart) ?? bookmarks[0];
  } else {
    target = [...bookmarks].reverse().find((b) => b.lineStart < currentLineStart) ?? bookmarks[bookmarks.length - 1];
  }
  if (target) jumpToSqlBookmark(view, target.lineStart);
  return !!target;
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

const bookmarkMenuPlugin = ViewPlugin.fromClass(
  class {
    dom: HTMLDivElement;
    submenu: HTMLDivElement;
    private cleanup: (() => void) | null = null;

    constructor(readonly view: EditorView) {
      this.dom = document.createElement("div");
      this.dom.className = "cm-sql-bookmark-menu";
      this.dom.style.display = "none";
      this.dom.addEventListener("pointerdown", (e) => e.stopPropagation());
      this.dom.addEventListener("contextmenu", (e) => e.preventDefault());
      this.submenu = document.createElement("div");
      this.submenu.className = "cm-sql-bookmark-submenu";
      this.submenu.style.display = "none";

      const editorEl = view.dom.closest(".cm-editor") ?? view.dom;
      (editorEl.parentElement ?? editorEl).appendChild(this.dom);
    }

    destroy() {
      this.cleanup?.();
      this.dom.remove();
    }

    update() {}

    hide() {
      this.dom.style.display = "none";
      this.submenu.style.display = "none";
      this.cleanup?.();
      this.cleanup = null;
    }

    show(lineStart: number, event: MouseEvent, labels: SqlBookmarkMenuLabels) {
      const view = this.view;
      const doc = view.state.doc;
      const line = doc.lineAt(lineStart);
      const bookmarks = sqlBookmarkList(view);
      const existing = bookmarks.find((b) => b.lineStart === lineStart);

      this.hide();
      this.dom.innerHTML = "";
      this.submenu = document.createElement("div");
      this.submenu.className = "cm-sql-bookmark-submenu";
      this.submenu.style.display = "none";

      const addItem = document.createElement("button");
      addItem.type = "button";
      addItem.className = "cm-sql-bookmark-menu-item";
      addItem.textContent = existing ? `${labels.remove}「${existing.name}」` : labels.add;
      addItem.addEventListener("click", () => {
        toggleSqlBookmark(view, lineStart);
        this.hide();
      });
      this.dom.appendChild(addItem);

      const subTrigger = document.createElement("div");
      subTrigger.className = "cm-sql-bookmark-menu-submenu-trigger";
      const subLabel = document.createElement("span");
      subLabel.textContent = labels.menu;
      subTrigger.appendChild(subLabel);
      const subArrow = document.createElement("span");
      subArrow.className = "cm-sql-bookmark-submenu-arrow";
      subArrow.textContent = "›";
      subTrigger.appendChild(subArrow);

      const subItems = document.createElement("div");
      subItems.className = "cm-sql-bookmark-submenu-items";
      if (bookmarks.length === 0) {
        const empty = document.createElement("div");
        empty.className = "cm-sql-bookmark-menu-item cm-sql-bookmark-menu-item-disabled";
        empty.textContent = labels.empty;
        subItems.appendChild(empty);
      } else {
        for (const bookmark of bookmarks) {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "cm-sql-bookmark-menu-item";
          const lineText = doc.lineAt(bookmark.lineStart).text.slice(0, 40) || "(空行)";
          item.textContent = `${bookmark.name} · ${lineText}`;
          item.title = `${labels.jumpTo} ${doc.lineAt(bookmark.lineStart).number}`;
          item.addEventListener("click", () => {
            jumpToSqlBookmark(view, bookmark.lineStart);
            this.hide();
          });
          subItems.appendChild(item);
        }
      }
      this.submenu.appendChild(subItems);

      let submenuTimer: number | undefined;
      const scheduleSubmenuClose = () => {
        window.clearTimeout(submenuTimer);
        submenuTimer = window.setTimeout(() => {
          this.submenu.style.display = "none";
        }, 180);
      };
      subTrigger.addEventListener("mouseenter", () => {
        window.clearTimeout(submenuTimer);
        this.submenu.style.display = "block";
      });
      subTrigger.addEventListener("mouseleave", scheduleSubmenuClose);
      this.submenu.addEventListener("mouseenter", () => window.clearTimeout(submenuTimer));
      this.submenu.addEventListener("mouseleave", scheduleSubmenuClose);
      this.dom.appendChild(subTrigger);
      this.dom.appendChild(this.submenu);

      // Position near the cursor, flip upward near the bottom edge.
      this.dom.style.display = "block";
      const menuRect = this.dom.getBoundingClientRect();
      const x = Math.min(event.clientX, window.innerWidth - menuRect.width - 8);
      let y = event.clientY + 6;
      if (y + menuRect.height > window.innerHeight - 8) {
        y = event.clientY - menuRect.height - 6;
      }
      this.dom.style.left = `${x}px`;
      this.dom.style.top = `${y}px`;
      this.submenu.style.left = "calc(100% - 2px)";
      this.submenu.style.top = `${subTrigger.offsetTop - 2}px`;

      const onOutsidePointer = (e: Event) => {
        if (!this.dom.contains(e.target as Node)) this.hide();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          this.hide();
          view.focus();
        }
      };
      window.addEventListener("pointerdown", onOutsidePointer, true);
      window.addEventListener("keydown", onKey, true);
      this.cleanup = () => {
        window.removeEventListener("pointerdown", onOutsidePointer, true);
        window.removeEventListener("keydown", onKey, true);
        window.clearTimeout(submenuTimer);
      };
      void line;
    }
  },
  {},
);

export function showSqlBookmarkContextMenu(view: EditorView, lineStart: number, event: MouseEvent, labels: SqlBookmarkMenuLabels): boolean {
  const plugin = view.plugin(bookmarkMenuPlugin);
  if (!plugin) return false;
  plugin.show(lineStart, event, labels);
  return true;
}

export function sqlBookmarkExtension() {
  return [
    bookmarkField,
    gutter({
      class: "cm-sql-bookmark-gutter",
      markers: (view) => view.state.field(bookmarkField),
      initialSpacer: () => new SqlBookmarkSpacer(),
      domEventHandlers: {
        mousedown(view, line, event) {
          const mouse = event as MouseEvent;
          if (mouse.button !== 0) return false;
          mouse.preventDefault();
          toggleSqlBookmark(view, line.from);
          return true;
        },
        contextmenu(view, line, event) {
          event.preventDefault();
          event.stopPropagation();
          return showSqlBookmarkContextMenu(view, line.from, event as MouseEvent, bookmarksLabels(view));
        },
      },
    }),
    keymap.of([
      { key: "F2", run: (view) => jumpToBookmark(view, 1) },
      { key: "Shift-F2", run: (view) => jumpToBookmark(view, -1) },
    ]),
    bookmarkMenuPlugin,
    EditorView.baseTheme({
      ".cm-sql-bookmark-gutter": {
        width: "18px",
        cursor: "pointer",
      },
      ".cm-sql-bookmark-gutter .cm-gutterElement": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      ".cm-sql-bookmark-icon": {
        fontSize: "10px",
        lineHeight: "1",
        filter: "grayscale(30%)",
      },
      ".cm-sql-bookmark-menu": {
        position: "fixed",
        zIndex: 100,
        minWidth: "160px",
        padding: "4px",
        borderRadius: "8px",
        border: "1px solid var(--border, #333)",
        background: "var(--popover, #1e1e1e)",
        color: "var(--popover-foreground, #ddd)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        fontSize: "13px",
      },
      ".cm-sql-bookmark-menu-item": {
        display: "block",
        width: "100%",
        padding: "5px 8px",
        borderRadius: "5px",
        textAlign: "left",
        background: "transparent",
        border: "none",
        color: "inherit",
        cursor: "pointer",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      ".cm-sql-bookmark-menu-item:hover": {
        background: "rgba(128,128,128,0.18)",
      },
      ".cm-sql-bookmark-menu-item-disabled": {
        color: "rgba(128,128,128,0.7)",
        cursor: "default",
      },
      ".cm-sql-bookmark-menu-submenu-trigger": {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "5px 8px",
        borderRadius: "5px",
        cursor: "pointer",
      },
      ".cm-sql-bookmark-menu-submenu-trigger:hover": {
        background: "rgba(128,128,128,0.18)",
      },
      ".cm-sql-bookmark-submenu-arrow": {
        color: "rgba(128,128,128,0.8)",
      },
      ".cm-sql-bookmark-submenu": {
        position: "absolute",
        minWidth: "220px",
        maxHeight: "300px",
        overflowY: "auto",
        padding: "4px",
        borderRadius: "8px",
        border: "1px solid var(--border, #333)",
        background: "var(--popover, #1e1e1e)",
        color: "var(--popover-foreground, #ddd)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      },
      ".cm-sql-bookmark-submenu-items": {
        display: "flex",
        flexDirection: "column",
        gap: "1px",
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Labels (i18n bridge)
// ---------------------------------------------------------------------------

let activeLabels: SqlBookmarkMenuLabels = {
  add: "添加位置",
  remove: "删除位置",
  removeShort: "删除位置",
  menu: "书签",
  empty: "暂无书签",
  jumpTo: "跳转到第",
};

export function setSqlBookmarkMenuLabels(labels: SqlBookmarkMenuLabels) {
  activeLabels = labels;
}

function bookmarksLabels(_view: EditorView): SqlBookmarkMenuLabels {
  return activeLabels;
}
