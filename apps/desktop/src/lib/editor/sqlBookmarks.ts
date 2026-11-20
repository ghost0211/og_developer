import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, keymap } from "@codemirror/view";

// OG Developer: SQL bookmarks with auto-names (位置1, 位置2, …).
// - click the gutter left of the line numbers to toggle a crisp bookmark ribbon
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
  clearAll?: string;
  emptyLine?: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function createBookmarkSvg(variant: "filled" | "outline" = "filled"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("cm-sql-bookmark-svg");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M4.25 3.5A2 2 0 0 1 6.25 1.5h7.5a2 2 0 0 1 2 2v15l-5.75-3.6-5.75 3.6v-15Z");
  path.setAttribute("stroke-linejoin", "round");
  if (variant === "filled") {
    path.setAttribute("fill", "currentColor");
    path.setAttribute("stroke", "var(--cm-bookmark-stroke, currentColor)");
    path.setAttribute("stroke-width", "1.25");
  } else {
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6");
  }
  svg.appendChild(path);
  return svg;
}

function createCloseSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M4.5 4.5l7 7M11.5 4.5l-7 7");
  svg.appendChild(path);
  return svg;
}

function createTrashSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M2.75 4.5h10.5M6 4.5V3c0-.4.3-.75.75-.75h2.5c.45 0 .75.35.75.75v1.5M4.5 4.5l.65 8.1c.05.55.5.9 1.05.9h3.6c.55 0 1-.35 1.05-.9l.65-8.1");
  svg.appendChild(path);
  return svg;
}

const addBookmarkEffect = StateEffect.define<{ lineStart: number; name: string }>();
const removeBookmarkEffect = StateEffect.define<number>();
const clearBookmarksEffect = StateEffect.define<void>();

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
    el.appendChild(createBookmarkSvg("filled"));
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
      } else if (effect.is(clearBookmarksEffect)) {
        next = RangeSet.empty;
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

export function clearSqlBookmarks(view: EditorView) {
  view.dispatch({ effects: clearBookmarksEffect.of() });
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

      // Append inside the editor (like CM tooltips): the baseTheme rules
      // below are scoped to the editor element, so the menu must live under
      // view.dom for them to match. position: fixed keeps it out of the
      // editor's flex flow.
      view.dom.appendChild(this.dom);
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

      this.hide();
      this.dom.innerHTML = "";
      this.submenu = document.createElement("div");
      this.submenu.className = "cm-sql-bookmark-submenu";
      this.submenu.style.display = "none";

      const addItem = document.createElement("button");
      addItem.type = "button";
      addItem.className = "cm-sql-bookmark-menu-item";
      const renderToggleItem = () => {
        const existing = sqlBookmarkList(view).find((b) => b.lineStart === lineStart);
        addItem.innerHTML = "";
        const iconSpan = document.createElement("span");
        iconSpan.className = existing ? "cm-sql-bookmark-menu-item-icon cm-sql-bookmark-menu-item-icon--active" : "cm-sql-bookmark-menu-item-icon";
        iconSpan.appendChild(createBookmarkSvg(existing ? "filled" : "outline"));
        addItem.appendChild(iconSpan);

        const labelSpan = document.createElement("span");
        labelSpan.className = "cm-sql-bookmark-menu-item-label";
        labelSpan.textContent = existing ? `${labels.remove}「${existing.name}」` : labels.add;
        addItem.appendChild(labelSpan);
      };
      renderToggleItem();
      addItem.addEventListener("click", () => {
        toggleSqlBookmark(view, lineStart);
        this.hide();
      });
      this.dom.appendChild(addItem);

      const subTrigger = document.createElement("div");
      subTrigger.className = "cm-sql-bookmark-menu-submenu-trigger";
      const subLeft = document.createElement("span");
      subLeft.className = "cm-sql-bookmark-submenu-left";
      const subIcon = document.createElement("span");
      subIcon.className = "cm-sql-bookmark-menu-item-icon cm-sql-bookmark-menu-item-icon--active";
      subIcon.appendChild(createBookmarkSvg("filled"));
      subLeft.appendChild(subIcon);
      const subLabel = document.createElement("span");
      subLabel.textContent = labels.menu;
      subLeft.appendChild(subLabel);
      subTrigger.appendChild(subLeft);

      const subRight = document.createElement("span");
      subRight.className = "cm-sql-bookmark-submenu-right";
      const countBadge = document.createElement("span");
      countBadge.className = "cm-sql-bookmark-count";
      subRight.appendChild(countBadge);
      const subArrow = document.createElement("span");
      subArrow.className = "cm-sql-bookmark-submenu-arrow";
      subArrow.textContent = "›";
      subRight.appendChild(subArrow);
      subTrigger.appendChild(subRight);

      const subItems = document.createElement("div");
      subItems.className = "cm-sql-bookmark-submenu-items";
      this.submenu.appendChild(subItems);

      const renderSubmenu = () => {
        const doc = view.state.doc;
        const bookmarks = sqlBookmarkList(view);
        countBadge.textContent = bookmarks.length > 0 ? String(bookmarks.length) : "";
        countBadge.style.display = bookmarks.length > 0 ? "inline-flex" : "none";
        subItems.innerHTML = "";

        if (bookmarks.length === 0) {
          const empty = document.createElement("div");
          empty.className = "cm-sql-bookmark-menu-item cm-sql-bookmark-menu-item-disabled";
          empty.textContent = labels.empty;
          subItems.appendChild(empty);
          return;
        }

        for (const bookmark of bookmarks) {
          const row = document.createElement("div");
          row.className = "cm-sql-bookmark-submenu-row";

          const lineInfo = doc.lineAt(bookmark.lineStart);
          const rawPreview = lineInfo.text.trim();
          const lineText = rawPreview.slice(0, 42);
          const jumpBtn = document.createElement("button");
          jumpBtn.type = "button";
          jumpBtn.className = "cm-sql-bookmark-menu-item cm-sql-bookmark-submenu-jump";
          jumpBtn.title = `${labels.jumpTo} ${lineInfo.number}`;

          const itemIcon = document.createElement("span");
          itemIcon.className = "cm-sql-bookmark-menu-item-icon cm-sql-bookmark-menu-item-icon--active";
          itemIcon.appendChild(createBookmarkSvg("filled"));
          jumpBtn.appendChild(itemIcon);

          const nameSpan = document.createElement("span");
          nameSpan.className = "cm-sql-bookmark-row-name";
          nameSpan.textContent = bookmark.name;
          jumpBtn.appendChild(nameSpan);

          const lineBadge = document.createElement("span");
          lineBadge.className = "cm-sql-bookmark-row-line";
          lineBadge.textContent = `L${lineInfo.number}`;
          jumpBtn.appendChild(lineBadge);

          const previewSpan = document.createElement("span");
          previewSpan.className = rawPreview ? "cm-sql-bookmark-row-preview" : "cm-sql-bookmark-row-preview cm-sql-bookmark-row-preview--empty";
          previewSpan.textContent = lineText || (labels.emptyLine ?? "(空行)");
          jumpBtn.appendChild(previewSpan);

          jumpBtn.addEventListener("click", () => {
            jumpToSqlBookmark(view, bookmark.lineStart);
            this.hide();
          });

          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "cm-sql-bookmark-row-remove";
          const removeLabel = `${labels.removeShort} ${bookmark.name}`;
          removeBtn.title = removeLabel;
          removeBtn.setAttribute("aria-label", removeLabel);
          removeBtn.appendChild(createCloseSvg());
          removeBtn.addEventListener("click", (clickEvent) => {
            clickEvent.stopPropagation();
            removeSqlBookmark(view, bookmark.lineStart);
            renderToggleItem();
            renderSubmenu();
          });

          row.appendChild(jumpBtn);
          row.appendChild(removeBtn);
          subItems.appendChild(row);
        }

        const divider = document.createElement("div");
        divider.className = "cm-sql-bookmark-menu-divider";
        subItems.appendChild(divider);

        const clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "cm-sql-bookmark-menu-item cm-sql-bookmark-clear-btn";
        const clearIcon = document.createElement("span");
        clearIcon.className = "cm-sql-bookmark-menu-item-icon";
        clearIcon.appendChild(createTrashSvg());
        clearBtn.appendChild(clearIcon);
        const clearLabel = document.createElement("span");
        clearLabel.textContent = labels.clearAll ?? "清空全部书签";
        clearBtn.appendChild(clearLabel);
        clearBtn.addEventListener("click", () => {
          clearSqlBookmarks(view);
          this.hide();
        });
        subItems.appendChild(clearBtn);
      };

      renderSubmenu();

      const positionSubmenu = () => {
        this.submenu.style.left = "calc(100% + 4px)";
        this.submenu.style.right = "";
        this.submenu.style.top = `${subTrigger.offsetTop - 4}px`;

        const menuRect = this.dom.getBoundingClientRect();
        const subRect = this.submenu.getBoundingClientRect();
        if (menuRect.width > 0 && subRect.width > 0) {
          if (menuRect.right + 4 + subRect.width > window.innerWidth - 8) {
            this.submenu.style.left = "auto";
            this.submenu.style.right = "calc(100% + 4px)";
          }
          const projectedBottom = menuRect.top + subTrigger.offsetTop - 4 + subRect.height;
          if (projectedBottom > window.innerHeight - 8) {
            const clampedTop = Math.max(-menuRect.top + 8, window.innerHeight - 8 - subRect.height - menuRect.top);
            this.submenu.style.top = `${clampedTop}px`;
          }
        }
      };

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
        positionSubmenu();
      });
      subTrigger.addEventListener("mouseleave", scheduleSubmenuClose);
      this.submenu.addEventListener("mouseenter", () => window.clearTimeout(submenuTimer));
      this.submenu.addEventListener("mouseleave", scheduleSubmenuClose);
      this.dom.appendChild(subTrigger);
      this.dom.appendChild(this.submenu);

      // Position near the cursor, flip upward near the bottom edge.
      this.dom.style.display = "block";
      const menuRect = this.dom.getBoundingClientRect();
      const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuRect.width - 8));
      let y = event.clientY + 6;
      if (y + menuRect.height > window.innerHeight - 8) {
        y = Math.max(8, event.clientY - menuRect.height - 6);
      }
      this.dom.style.left = `${x}px`;
      this.dom.style.top = `${y}px`;
      positionSubmenu();

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
          if (mouse.button === 2) {
            // Right-click: open the bookmark menu on mousedown — some webviews
            // (WebView2) intercept the native contextmenu event.
            mouse.preventDefault();
            mouse.stopPropagation();
            return showSqlBookmarkContextMenu(view, line.from, mouse, bookmarksLabels(view));
          }
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
        // Keep the hit target narrow even when a WebView fails to apply
        // CodeMirror's flex-gutter defaults. Without a flex basis, the
        // bookmark gutter can expand to the whole editor and every click
        // toggles a bookmark.
        flex: "0 0 22px",
        width: "22px",
        minWidth: "22px",
        maxWidth: "22px",
        overflow: "hidden",
        cursor: "pointer",
      },
      ".cm-sql-bookmark-gutter .cm-gutterElement": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "22px",
        minWidth: "22px",
        maxWidth: "22px",
        padding: "0 1px",
      },
      ".cm-sql-bookmark-icon": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "min(20px, calc(var(--ogdeveloper-editor-font-size, 13px) * 1.48))",
        height: "min(20px, calc(var(--ogdeveloper-editor-font-size, 13px) * 1.48))",
        borderRadius: "5px",
        color: "#f59e0b",
        "--cm-bookmark-stroke": "#d97706",
        transition: "transform 0.14s ease, background-color 0.14s ease, color 0.14s ease",
      },
      ".cm-sql-bookmark-icon svg": {
        display: "block",
        width: "min(16px, calc(var(--ogdeveloper-editor-font-size, 13px) * 1.18))",
        height: "min(16px, calc(var(--ogdeveloper-editor-font-size, 13px) * 1.18))",
        filter: "drop-shadow(0 1px 1px rgb(180 83 9 / 0.2))",
      },
      ".cm-sql-bookmark-gutter .cm-gutterElement:hover .cm-sql-bookmark-icon": {
        backgroundColor: "rgb(245 158 11 / 0.14)",
        color: "#d97706",
        transform: "scale(1.08)",
      },
      "&dark .cm-sql-bookmark-icon, .dark & .cm-sql-bookmark-icon": {
        color: "#fbbf24",
        "--cm-bookmark-stroke": "#f59e0b",
      },
      "&dark .cm-sql-bookmark-gutter .cm-gutterElement:hover .cm-sql-bookmark-icon, .dark & .cm-sql-bookmark-gutter .cm-gutterElement:hover .cm-sql-bookmark-icon": {
        backgroundColor: "rgb(251 191 36 / 0.18)",
        color: "#fcd34d",
      },
      ".cm-sql-bookmark-menu": {
        position: "fixed",
        zIndex: 100,
        minWidth: "172px",
        padding: "4px",
        borderRadius: "8px",
        border: "1px solid var(--border, rgba(15, 23, 42, 0.12))",
        background: "var(--popover, #ffffff)",
        color: "var(--popover-foreground, #1f2937)",
        boxShadow: "0 10px 28px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.06)",
        fontSize: "12.5px",
      },
      "&dark .cm-sql-bookmark-menu, .dark & .cm-sql-bookmark-menu": {
        border: "1px solid var(--border, #333)",
        background: "var(--popover, #1e1e1e)",
        color: "var(--popover-foreground, #e5e7eb)",
        boxShadow: "0 10px 28px rgba(0, 0, 0, 0.45)",
      },
      ".cm-sql-bookmark-menu-item": {
        display: "flex",
        alignItems: "center",
        gap: "7px",
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
        fontSize: "inherit",
        lineHeight: "1.35",
      },
      ".cm-sql-bookmark-menu-item:hover": {
        background: "var(--accent, rgba(128, 128, 128, 0.14))",
        color: "var(--accent-foreground, inherit)",
      },
      ".cm-sql-bookmark-menu-item-icon": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: "14px",
        height: "14px",
        color: "var(--muted-foreground, rgba(128, 128, 128, 0.85))",
      },
      ".cm-sql-bookmark-menu-item-icon svg": {
        width: "13px",
        height: "13px",
        display: "block",
      },
      ".cm-sql-bookmark-menu-item-icon--active": {
        color: "#f59e0b",
        "--cm-bookmark-stroke": "#d97706",
      },
      "&dark .cm-sql-bookmark-menu-item-icon--active, .dark & .cm-sql-bookmark-menu-item-icon--active": {
        color: "#fbbf24",
        "--cm-bookmark-stroke": "#f59e0b",
      },
      ".cm-sql-bookmark-menu-item-label": {
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      ".cm-sql-bookmark-menu-item-disabled": {
        color: "var(--muted-foreground, rgba(128, 128, 128, 0.7))",
        cursor: "default",
      },
      ".cm-sql-bookmark-menu-item-disabled:hover": {
        background: "transparent",
      },
      ".cm-sql-bookmark-menu-submenu-trigger": {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "5px 8px",
        borderRadius: "5px",
        cursor: "pointer",
      },
      ".cm-sql-bookmark-menu-submenu-trigger:hover": {
        background: "var(--accent, rgba(128, 128, 128, 0.14))",
        color: "var(--accent-foreground, inherit)",
      },
      ".cm-sql-bookmark-submenu-left, .cm-sql-bookmark-submenu-right": {
        display: "inline-flex",
        alignItems: "center",
        gap: "7px",
      },
      ".cm-sql-bookmark-count": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: "17px",
        height: "16px",
        padding: "0 5px",
        borderRadius: "9999px",
        fontSize: "10.5px",
        fontWeight: "600",
        background: "rgb(245 158 11 / 0.14)",
        color: "#b45309",
      },
      "&dark .cm-sql-bookmark-count, .dark & .cm-sql-bookmark-count": {
        background: "rgb(251 191 36 / 0.18)",
        color: "#fbbf24",
      },
      ".cm-sql-bookmark-submenu-arrow": {
        color: "var(--muted-foreground, rgba(128, 128, 128, 0.8))",
        fontSize: "14px",
        lineHeight: "1",
      },
      ".cm-sql-bookmark-submenu": {
        position: "absolute",
        minWidth: "260px",
        maxWidth: "380px",
        maxHeight: "320px",
        overflowY: "auto",
        padding: "4px",
        borderRadius: "8px",
        border: "1px solid var(--border, rgba(15, 23, 42, 0.12))",
        background: "var(--popover, #ffffff)",
        color: "var(--popover-foreground, #1f2937)",
        boxShadow: "0 10px 28px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.06)",
      },
      "&dark .cm-sql-bookmark-submenu, .dark & .cm-sql-bookmark-submenu": {
        border: "1px solid var(--border, #333)",
        background: "var(--popover, #1e1e1e)",
        color: "var(--popover-foreground, #e5e7eb)",
        boxShadow: "0 10px 28px rgba(0, 0, 0, 0.45)",
      },
      ".cm-sql-bookmark-submenu-items": {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      },
      ".cm-sql-bookmark-submenu-row": {
        display: "flex",
        alignItems: "center",
        gap: "2px",
      },
      ".cm-sql-bookmark-submenu-jump": {
        flex: "1 1 auto",
        minWidth: "0",
      },
      ".cm-sql-bookmark-row-name": {
        flexShrink: 0,
        fontWeight: "500",
      },
      ".cm-sql-bookmark-row-line": {
        flexShrink: 0,
        padding: "1px 5px",
        borderRadius: "4px",
        fontSize: "10.5px",
        fontFamily: "var(--ogdeveloper-editor-font-family, ui-monospace, monospace)",
        background: "var(--muted, rgba(128, 128, 128, 0.12))",
        color: "var(--muted-foreground, rgba(100, 116, 139, 0.95))",
      },
      ".cm-sql-bookmark-row-preview": {
        flex: "1 1 auto",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        color: "var(--muted-foreground, rgba(100, 116, 139, 0.9))",
      },
      ".cm-sql-bookmark-row-preview--empty": {
        fontStyle: "italic",
        opacity: 0.72,
      },
      ".cm-sql-bookmark-row-remove": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: "22px",
        height: "22px",
        borderRadius: "5px",
        border: "none",
        background: "transparent",
        color: "var(--muted-foreground, rgba(128, 128, 128, 0.75))",
        cursor: "pointer",
        opacity: 0.65,
        transition: "opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease",
      },
      ".cm-sql-bookmark-row-remove svg": {
        width: "12px",
        height: "12px",
        display: "block",
      },
      ".cm-sql-bookmark-submenu-row:hover .cm-sql-bookmark-row-remove": {
        opacity: 1,
      },
      ".cm-sql-bookmark-row-remove:hover": {
        background: "rgb(239 68 68 / 0.12)",
        color: "#ef4444",
      },
      ".cm-sql-bookmark-menu-divider": {
        height: "1px",
        margin: "3px 4px",
        background: "var(--border, rgba(128, 128, 128, 0.18))",
      },
      ".cm-sql-bookmark-clear-btn": {
        color: "var(--muted-foreground, rgba(100, 116, 139, 0.95))",
      },
      ".cm-sql-bookmark-clear-btn:hover": {
        background: "rgb(239 68 68 / 0.1)",
        color: "#ef4444",
      },
      ".cm-sql-bookmark-clear-btn:hover .cm-sql-bookmark-menu-item-icon": {
        color: "inherit",
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
  clearAll: "清空全部书签",
  emptyLine: "(空行)",
};

export function setSqlBookmarkMenuLabels(labels: SqlBookmarkMenuLabels) {
  activeLabels = labels;
}

function bookmarksLabels(_view: EditorView): SqlBookmarkMenuLabels {
  return activeLabels;
}
