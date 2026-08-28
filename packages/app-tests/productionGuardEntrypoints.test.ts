import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "vitest";

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

function functionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  const asyncSignature = `async ${signature}`;
  const signatureIndex = source.indexOf(asyncSignature) >= 0 ? source.indexOf(asyncSignature) : source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `Could not find function ${name}`);
  const bodyStart = source.indexOf("{", signatureIndex);
  assert.notEqual(bodyStart, -1, `Could not find body for ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`Could not parse body for ${name}`);
}


test("object browser batch empty reviews the frozen SQL plan before executing", () => {
  const source = readSource("apps/desktop/src/components/objects/ObjectBrowser.vue");
  const body = functionBody(source, "confirmBatchEmptyTables");
  assert.match(body, /executeObjectBrowserSqlWithProductionGuard\(\s*reviewSql/, "batch empty must use the Object Browser production guard");
  assert.match(body, /runBatchTableEmpty/, "batch empty should still use the batch executor after confirmation");
  assert.ok(body.indexOf("executeObjectBrowserSqlWithProductionGuard") < body.indexOf("runBatchTableEmpty"), "production guard must be entered before the batch executor");
});


