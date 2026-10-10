import assert from "node:assert/strict";
import { test } from "vitest";
import { SCHEMA_TREE_CACHE_TTL_MS, decodeSchemaTreeCache, encodeSchemaTreeCache } from "../../apps/desktop/src/lib/metadata/schemaTreeCache.ts";

const children = [{ id: "conn:db", label: "db", type: "database" }];
const now = Date.parse("2026-05-17T10:00:00.000Z");

test("wraps tree children with a cache timestamp", () => {
  assert.deepEqual(encodeSchemaTreeCache(children, now), {
    version: 3,
    cachedAt: "2026-05-17T10:00:00.000Z",
    children,
  });
});

test("treats recent schema tree cache envelopes as fresh", () => {
  const payload = encodeSchemaTreeCache(children, now);

  assert.deepEqual(decodeSchemaTreeCache(payload, now + SCHEMA_TREE_CACHE_TTL_MS - 1), {
    children,
    isStale: false,
  });
});

test("treats expired schema tree cache envelopes as stale", () => {
  const payload = encodeSchemaTreeCache(children, now);

  assert.deepEqual(decodeSchemaTreeCache(payload, now + SCHEMA_TREE_CACHE_TTL_MS + 1), {
    children,
    isStale: true,
  });
});

test("keeps legacy array cache readable but stale", () => {
  assert.deepEqual(decodeSchemaTreeCache(children, now), {
    children,
    isStale: true,
  });
});

test("rejects invalid schema tree cache payloads", () => {
  assert.equal(decodeSchemaTreeCache({ version: 2, cachedAt: "bad", children: "nope" }, now), null);
  assert.equal(decodeSchemaTreeCache({ version: 1, cachedAt: "2026-05-17T10:00:00.000Z", children }, now), null);
});

test("roundtrips nullable and Unicode table comments in the persisted search index", () => {
  const tableSearchIndex = {
    complete: true as const,
    indexedAt: new Date(now).toISOString(),
    entries: [
      { name: "users", tableType: "TABLE", comment: "用户账号档案" },
      { name: "empty", tableType: "VIEW", comment: null },
      { name: "legacy", tableType: "TABLE" },
    ],
  };
  const stored = JSON.parse(JSON.stringify(encodeSchemaTreeCache(children, now, tableSearchIndex)));
  assert.deepEqual(decodeSchemaTreeCache(stored, now)?.tableSearchIndex, tableSearchIndex);
});

test("rejects non-string comments without discarding valid tree children", () => {
  const payload = { ...encodeSchemaTreeCache(children, now), tableSearchIndex: { complete: true, indexedAt: new Date(now).toISOString(), entries: [{ name: "users", tableType: "TABLE", comment: 42 }] } };
  assert.deepEqual(decodeSchemaTreeCache(payload, now), { children, isStale: false });
});
