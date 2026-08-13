import { test } from "vitest";
import assert from "node:assert/strict";
import { appendServerOutputResults } from "../../apps/desktop/src/stores/queryStore.ts";
import type { QueryResult } from "../../apps/desktop/src/types/database.ts";

function baseResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: ["put_line"],
    rows: [[""]],
    affected_rows: 0,
    execution_time_ms: 1,
    ...overrides,
  } as QueryResult;
}

test("appendServerOutputResults synthesizes a DBMS_OUTPUT grid result from messages", () => {
  const withOutput = baseResult({ messages: ["hello from proc", "second line"] });
  const results = appendServerOutputResults([withOutput]);
  assert.equal(results.length, 2);
  const output = results[1];
  assert.equal(output.sourceLabel, "DBMS_OUTPUT");
  assert.deepEqual(output.rows, [["hello from proc"], ["second line"]]);
  assert.equal(output.affected_rows, 0);
  assert.ok(output.columns[0].length > 0, "output column carries a label");
});

test("appendServerOutputResults leaves results without messages untouched", () => {
  const plain = baseResult();
  const withEmpty = baseResult({ messages: [] });
  assert.equal(appendServerOutputResults([plain, withEmpty]).length, 2);
});
