import assert from "node:assert/strict";
import { test } from "vitest";
import en from "../../apps/desktop/src/i18n/locales/en";
import { zhCNMessages } from "../../apps/desktop/src/i18n/locales/zh-CN";

type Messages = Record<string, unknown>;

/**
 * Flattens a locale into dotted leaf paths. Arrays are indexed (`items[0].label`) because vue-i18n
 * resolves them by index, and an index missing on one side is a real gap.
 */
function flattenMessages(value: unknown, prefix: string, into: Map<string, string>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) into.set(prefix, "array");
    value.forEach((item, index) => flattenMessages(item, `${prefix}[${index}]`, into));
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Messages);
    if (entries.length === 0) into.set(prefix, "object");
    for (const [key, nested] of entries) flattenMessages(nested, prefix ? `${prefix}.${key}` : key, into);
    return;
  }
  into.set(prefix, typeof value);
}

const englishLeaves = new Map<string, string>();
const chineseLeaves = new Map<string, string>();
flattenMessages(en, "", englishLeaves);
flattenMessages(zhCNMessages, "", chineseLeaves);

/** Sorted so a failure lists the offending keys in a stable, diffable order. */
function sortedDifference(left: Map<string, string>, right: Map<string, string>): string[] {
  return [...left.keys()].filter((key) => !right.has(key)).sort();
}

test("zh-CN defines a translation for every English key", () => {
  // `en` is the fallback locale, so a key missing from zh-CN renders English text with no warning.
  const untranslated = sortedDifference(englishLeaves, chineseLeaves);

  assert.deepEqual(untranslated, [], `zh-CN is missing ${untranslated.length} key(s); they silently fall back to English:\n${untranslated.slice(0, 40).join("\n")}`);
});

test("zh-CN does not define keys that English does not have", () => {
  // Such a key is unreachable dead weight, and usually a typo of a real key.
  const orphans = sortedDifference(chineseLeaves, englishLeaves);

  assert.deepEqual(orphans, [], `zh-CN defines ${orphans.length} key(s) that en does not:\n${orphans.slice(0, 40).join("\n")}`);
});

test("zh-CN keeps the same value kind as English for every key", () => {
  // A string where English has an object (or the reverse) survives the fallback merge, so it would
  // silently break `tm()`/`rt()` array rendering instead of failing loudly.
  const kindMismatches = [...englishLeaves.entries()]
    .filter(([key, kind]) => chineseLeaves.has(key) && chineseLeaves.get(key) !== kind)
    .map(([key, kind]) => `${key}: en is ${kind}, zh-CN is ${chineseLeaves.get(key)}`)
    .sort();

  assert.deepEqual(kindMismatches, [], `zh-CN value kinds differ from English:\n${kindMismatches.slice(0, 40).join("\n")}`);
});

test("zh-CN has no empty translations", () => {
  const empty = [...chineseLeaves.entries()]
    .filter(([key, kind]) => kind === "string" && String(pathValue(zhCNMessages, key)).trim().length === 0)
    .map(([key]) => key)
    .sort();

  assert.deepEqual(empty, [], `zh-CN has ${empty.length} empty translation(s):\n${empty.slice(0, 40).join("\n")}`);
});

function pathValue(source: unknown, path: string): unknown {
  return path
    .split(/\.|\[(\d+)\]/)
    .filter((part) => part !== undefined && part !== "")
    .reduce<unknown>((current, part) => (current as Messages | undefined)?.[part], source);
}
