import { foldService } from "@codemirror/language";
import type { Extension, Text } from "@codemirror/state";
import { sqlBeginEndPairs } from "@/lib/editor/codemirrorSqlBlockMatching";

type FoldRange = { from: number; to: number };
const foldsByDocument = new WeakMap<Text, Map<number, FoldRange>>();

/** Prefer complete procedural blocks over the SQL grammar's semicolon statements. */
export function sqlBlockFoldRange(doc: Text, lineStart: number, lineEnd: number): FoldRange | null {
  let folds = foldsByDocument.get(doc);
  if (!folds) {
    folds = new Map();
    const source = doc.toString();
    for (const pair of sqlBeginEndPairs(source)) {
      const openingLine = doc.lineAt(pair.begin.from);
      const closingLine = doc.lineAt(pair.end.to);
      if (openingLine.number === closingLine.number) continue;
      const semicolon = /^[\t ]*;/.exec(source.slice(pair.end.to, closingLine.to));
      const to = pair.end.to + (semicolon?.[0].length ?? 0);
      const previous = folds.get(openingLine.from);
      // When two blocks start on one line, folding that line means the outer block.
      if (!previous || to > previous.to) folds.set(openingLine.from, { from: openingLine.to, to });
    }
    foldsByDocument.set(doc, folds);
  }
  const fold = folds.get(lineStart);
  return fold && fold.from === lineEnd ? fold : null;
}

export function sqlBlockFolding(): Extension {
  return foldService.of((state, lineStart, lineEnd) => sqlBlockFoldRange(state.doc, lineStart, lineEnd));
}
