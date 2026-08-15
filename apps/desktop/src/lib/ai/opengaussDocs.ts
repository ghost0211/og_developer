import { currentLocale } from "@/i18n";

/**
 * Built-in openGauss documentation knowledge base.
 *
 * The index (apps/desktop/public/kb/opengauss-kb.json) is built offline by
 * scripts/fetch-opengauss-docs.mjs + scripts/build-opengauss-kb.mjs from the
 * official openGauss docs Markdown sources. It is loaded lazily on first use
 * and searched locally (title/keyword pre-filter + Chinese bigram scoring) —
 * no network and no embedding model required.
 */

export interface OpengaussDocSlice {
  t: string;
  h: string;
  k: string[];
  c: string;
}

interface OpengaussKb {
  version: number;
  count: number;
  slices: OpengaussDocSlice[];
}

export interface OpengaussDocHit {
  title: string;
  heading: string;
  content: string;
  score: number;
}

const KB_URL = new URL("/kb/opengauss-kb.json", typeof window !== "undefined" ? window.location.href : "http://localhost/").href;
const MAX_CANDIDATES = 240;
const TOP_K = 4;
const HIT_CONTENT_CHARS = 900;

let kbPromise: Promise<OpengaussKb | null> | null = null;

export function loadOpengaussDocsIndex(): Promise<OpengaussKb | null> {
  if (!kbPromise) {
    kbPromise = fetch(KB_URL)
      .then((res) => (res.ok ? (res.json() as Promise<OpengaussKb>) : null))
      .catch(() => null);
  }
  return kbPromise;
}

/** Force a reload (used after the index file changes, e.g. in dev mode). */
export function resetOpengaussDocsIndex(): void {
  kbPromise = null;
}

/**
 * Tokenize a query for matching: English/ASCII words plus Chinese bigrams.
 * Chinese bigrams give decent recall for technical terms without a tokenizer.
 */
export function tokenizeDocQuery(query: string): { words: string[]; bigrams: string[] } {
  const normalized = query.trim().toLowerCase();
  const words = [...normalized.matchAll(/[a-z0-9_][a-z0-9_\-]*/g)].map((m) => m[0]).filter((w) => w.length >= 2);
  const cn = normalized.match(/[\u4e00-\u9fa5]+/g) ?? [];
  const bigrams = new Set<string>();
  for (const frag of cn) {
    if (frag.length === 1) {
      bigrams.add(frag);
      continue;
    }
    for (let i = 0; i < frag.length - 1; i += 1) {
      bigrams.add(frag.slice(i, i + 2));
    }
  }
  return { words, bigrams: [...bigrams] };
}

function sliceScore(slice: OpengaussDocSlice, words: string[], bigrams: string[], content: string): number {
  const titleText = `${slice.t} ${slice.h}`.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (titleText.includes(word)) score += 6;
  }
  for (const bigram of bigrams) {
    if (titleText.includes(bigram)) score += 4;
  }
  for (const keyword of slice.k) {
    const kw = keyword.toLowerCase();
    if (words.some((w) => kw.includes(w) || w.includes(kw))) score += 3;
    if (bigrams.some((b) => kw.includes(b))) score += 2;
  }
  if (score === 0) return 0;
  for (const word of words) {
    const count = countOccurrences(content, word);
    if (count > 0) score += Math.min(count, 6);
  }
  for (const bigram of bigrams) {
    const count = countOccurrences(content, bigram);
    if (count > 0) score += Math.min(count, 3) * 0.5;
  }
  return score;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function highlightContext(content: string, words: string[], bigrams: string[]): string {
  const lowered = content.toLowerCase();
  const hits: number[] = [];
  for (const word of words) {
    let idx = lowered.indexOf(word);
    while (idx >= 0 && hits.length < 40) {
      hits.push(idx);
      idx = lowered.indexOf(word, idx + word.length);
    }
  }
  for (const bigram of bigrams) {
    let idx = lowered.indexOf(bigram);
    while (idx >= 0 && hits.length < 40) {
      hits.push(idx);
      idx = lowered.indexOf(bigram, idx + bigram.length);
    }
  }
  if (hits.length === 0) return content.slice(0, HIT_CONTENT_CHARS);
  hits.sort((a, b) => a - b);
  const start = Math.max(0, hits[0] - 80);
  const end = Math.min(content.length, hits[0] + HIT_CONTENT_CHARS - 80);
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}

/**
 * Search the built-in openGauss docs index. Returns the best matching slices
 * (title/heading first, then keyword hits, then body bigram density).
 */
export async function searchOpengaussDocs(query: string, topK = TOP_K): Promise<OpengaussDocHit[]> {
  const kb = await loadOpengaussDocsIndex();
  if (!kb || !kb.slices.length) return [];
  const { words, bigrams } = tokenizeDocQuery(query);
  if (words.length === 0 && bigrams.length === 0) return [];

  const candidates: { slice: OpengaussDocSlice; score: number }[] = [];
  for (const slice of kb.slices) {
    const score = sliceScore(slice, words, bigrams, slice.c);
    if (score > 0) candidates.push({ slice, score });
    if (candidates.length > MAX_CANDIDATES * 4) break;
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topK).map(({ slice, score }) => ({
    title: slice.t,
    heading: slice.h,
    content: highlightContext(slice.c, words, bigrams),
    score,
  }));
}

/** Format search hits for injection into the AI system prompt. */
export function formatOpengaussDocHits(hits: OpengaussDocHit[]): string {
  if (!hits.length) return "";
  const isZh = currentLocale() === "zh-CN";
  const lines = [isZh ? "## openGauss 官方文档参考（检索自内置文档知识库，优先参考，但以用户实际数据库版本为准）" : "## openGauss official documentation reference (retrieved from the built-in docs knowledge base; prefer it, but defer to the user's actual server version)"];
  for (const hit of hits) {
    lines.push(`### ${hit.title} — ${hit.heading}`);
    lines.push(hit.content);
    lines.push("");
  }
  return lines.join("\n");
}
