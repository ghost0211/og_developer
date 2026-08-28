import { strict as assert } from "node:assert";
import { test } from "vitest";
import { resolveDiagramDialectAdapter } from "../../apps/desktop/src/lib/diagram/diagram-dialect-adapter.ts";


test("resolveDiagramDialectAdapter unknown dialect falls back", () => {
  const adapter = resolveDiagramDialectAdapter(undefined);
  const id = adapter.createDefaultIdColumn();
  assert.equal(id.name, "id");
  assert.equal(id.is_primary_key, true);
  assert.ok(typeof id.data_type === "string" && id.data_type.length > 0);
  assert.equal(adapter.databaseType, undefined);
});

test("resolveDiagramDialectAdapter createEmptyColumn defaults", () => {
  const col = resolveDiagramDialectAdapter("postgres").createEmptyColumn("foo");
  assert.equal(col.name, "foo");
  assert.equal(col.is_primary_key, false);
  assert.equal(col.is_nullable, true);
  assert.ok(col.data_type);
});

test("adapter remains a thin column factory without capability fields", () => {
  const adapter = resolveDiagramDialectAdapter("postgres") as Record<string, unknown>;
  assert.equal(typeof adapter.createDefaultIdColumn, "function");
  assert.equal(typeof adapter.createEmptyColumn, "function");
  assert.equal("supportsCreateTable" in adapter, false);
  assert.equal("supportsCreateIndex" in adapter, false);
  assert.equal("supportsComment" in adapter, false);
  assert.equal("supportsDropColumn" in adapter, false);
  assert.equal("dataTypeOptions" in adapter, false);
});
