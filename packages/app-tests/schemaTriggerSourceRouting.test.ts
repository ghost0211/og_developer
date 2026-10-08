import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("schema trigger source actions carry owning table in both source opening modes", () => {
  const host = readFileSync(new URL("../../apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", import.meta.url), "utf8");
  assert.ok(host.includes('relationName: node.type === "trigger" ? node.tableName : undefined'));
  const triggerMenu = host.slice(host.indexOf('if (node.type === "index" || node.type === "fkey" || (node.type === "trigger" && !!node.tableName))'), host.indexOf("// 8. Procedure / Function / Package"));
  assert.ok(triggerMenu.includes('t("contextMenu.viewSource")'));
  assert.ok(triggerMenu.includes("openObjectSourceDialog(false)"));
  assert.ok(host.includes('if (node.type === "trigger") return node.objectName ||'));
  const tree = readFileSync(new URL("../../apps/desktop/src/components/sidebar/ConnectionTree.vue", import.meta.url), "utf8");
  assert.ok(tree.includes(':relation-name="sidebarObjectSourceTarget.node.tableName"'));
});
