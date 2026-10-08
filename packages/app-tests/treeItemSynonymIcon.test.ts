import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("sidebar tree renders synonym icons by resolved target kind", () => {
  const treeItem = readFileSync(new URL("../../apps/desktop/src/components/sidebar/TreeItem.vue", import.meta.url), "utf8");
  // TreeItem.vue is the actual sidebar renderer; it must delegate synonym icons
  // to the shared target-kind mapping instead of a hardcoded link icon.
  assert.ok(treeItem.includes('import { synonymIconInfoForTargetKind } from "@/lib/sidebar/treeNodeIcon"'));
  assert.ok(treeItem.includes('case "synonym":'));
  assert.ok(treeItem.includes("synonymIconInfoForTargetKind(node.targetKind)"));

  const iconLib = readFileSync(new URL("../../apps/desktop/src/lib/sidebar/treeNodeIcon.ts", import.meta.url), "utf8");
  assert.ok(iconLib.includes("export function synonymIconInfoForTargetKind"));
  // relkind/prokind letters: table, view, materialized view, sequence, function, procedure.
  for (const kind of ['case "r"', 'case "v"', 'case "m"', 'case "S"', 'case "f"', 'case "p"']) {
    assert.ok(iconLib.includes(kind), `missing target kind mapping ${kind}`);
  }
});
