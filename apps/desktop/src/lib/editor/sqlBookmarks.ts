import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, keymap } from "@codemirror/view";

// ogdeveloper: line-number-area bookmarks for long SQL scripts.
// A slim gutter sits left of the line numbers; clicking it toggles a bookmark
// on that line. F2 / Shift+F2 jump between bookmarks.

const toggleBookmarkEffect = StateEffect.define<number>(); // line start offset

class SqlBookmarkMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-sql-bookmark-dot";
    el.setAttribute("aria-label", "bookmark");
    return el;
  }
}

const bookmarkMarker = new SqlBookmarkMarker();

const bookmarkField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, transaction) {
    let next = markers.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(toggleBookmarkEffect)) continue;
      const pos = effect.value;
      let exists = false;
      next.between(pos, pos, () => {
        exists = true;
      });
      next = exists ? next.update({ filter: (from) => from !== pos }) : next.update({ add: [bookmarkMarker.range(pos)] });
    }
    return next;
  },
});

function toggleBookmarkAt(view: EditorView, pos: number): boolean {
  view.dispatch({ effects: toggleBookmarkEffect.of(pos) });
  return true;
}

function bookmarkPositions(view: EditorView): number[] {
  const positions: number[] = [];
  const iter = view.state.field(bookmarkField).iter();
  while (iter.value) {
    positions.push(iter.from);
    iter.next();
  }
  return positions;
}

function jumpToBookmark(view: EditorView, direction: 1 | -1): boolean {
  const positions = bookmarkPositions(view);
  if (!positions.length) return false;
  const current = view.state.selection.main.head;
  const currentLineStart = view.state.doc.lineAt(current).from;
  let target: number | undefined;
  if (direction === 1) {
    target = positions.find((pos) => pos > currentLineStart) ?? positions[0];
  } else {
    target = [...positions].reverse().find((pos) => pos < currentLineStart) ?? positions[positions.length - 1];
  }
  if (target === undefined) return false;
  view.dispatch({
    selection: { anchor: target },
    effects: EditorView.scrollIntoView(target, { y: "center" }),
  });
  view.focus();
  return true;
}

export function sqlBookmarkExtension() {
  return [
    bookmarkField,
    gutter({
      class: "cm-sql-bookmark-gutter",
      markers: (view) => view.state.field(bookmarkField),
      initialSpacer: () => bookmarkMarker,
      domEventHandlers: {
        mousedown(view, line, event) {
          const mouse = event as MouseEvent;
          if (mouse.button !== 0) return false;
          mouse.preventDefault();
          return toggleBookmarkAt(view, line.from);
        },
      },
    }),
    keymap.of([
      { key: "F2", run: (view) => jumpToBookmark(view, 1) },
      { key: "Shift-F2", run: (view) => jumpToBookmark(view, -1) },
    ]),
    EditorView.baseTheme({
      ".cm-sql-bookmark-gutter": {
        width: "12px",
        cursor: "pointer",
      },
      ".cm-sql-bookmark-gutter .cm-gutterElement": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      ".cm-sql-bookmark-dot": {
        display: "block",
        width: "8px",
        height: "8px",
        borderRadius: "9999px",
        backgroundColor: "currentColor",
      },
    }),
  ];
}
