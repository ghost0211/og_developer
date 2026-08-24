export interface MenuSearchMatchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

const WORD_CHARACTER_RE = /[\p{L}\p{N}_]/u;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWholeWordBoundary(value: string, start: number, length: number): boolean {
  const before = start > 0 ? value[start - 1] : "";
  const after = start + length < value.length ? value[start + length] : "";
  return (!before || !WORD_CHARACTER_RE.test(before)) && (!after || !WORD_CHARACTER_RE.test(after));
}

function matchRanges(value: string, query: string, options: MenuSearchMatchOptions): Array<{ start: number; end: number }> {
  const needle = query.trim();
  if (!needle) return [];
  const regex = new RegExp(escapeRegex(needle), options.caseSensitive ? "gu" : "giu");
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of value.matchAll(regex)) {
    const start = match.index ?? -1;
    if (start < 0 || !match[0]) continue;
    if (options.wholeWord && !hasWholeWordBoundary(value, start, match[0].length)) continue;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

export function menuSearchTextMatches(value: string, query: string, options: MenuSearchMatchOptions): boolean {
  return matchRanges(value, query, options).length > 0;
}

export function highlightMenuSearchText(value: string, query: string, options: MenuSearchMatchOptions): string {
  const ranges = matchRanges(value, query, options);
  if (!ranges.length) return escapeHtml(value);

  const result: string[] = [];
  let offset = 0;
  for (const range of ranges) {
    result.push(escapeHtml(value.slice(offset, range.start)));
    result.push(`<mark class="bg-amber-400/35 text-amber-900 dark:text-amber-200 font-semibold px-0.5 rounded">${escapeHtml(value.slice(range.start, range.end))}</mark>`);
    offset = range.end;
  }
  result.push(escapeHtml(value.slice(offset)));
  return result.join("");
}
