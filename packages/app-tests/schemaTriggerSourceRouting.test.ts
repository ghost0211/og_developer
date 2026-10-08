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

test("trigger writes use captured targets, SQL confirmation, production guard and cancellation checks", () => {
  const host = readFileSync(new URL("../../apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", import.meta.url), "utf8");
  const change = host.slice(host.indexOf("function requestTriggerEnabledChange("), host.indexOf("async function runJob("));
  assert.ok(change.includes("createSidebarActionTarget(node)"));
  assert.ok(change.includes('emit("open-danger-dialog"'));
  assert.ok(change.includes("sql: buildTriggerEnabledSql(target, enabled)"));
  assert.ok(change.includes("executeTriggerEnabledChange"));
  assert.ok(change.includes("executeTreeNodeSqlWithProductionGuard(target, sql"));
  assert.ok(change.includes("refreshTriggerStateAfterMutation(target)"));
  assert.ok(!change.includes("api.executeQuery"));
  const drop = host.slice(host.indexOf("async function confirmDropTableChildObject()"), host.indexOf("async function confirmBatchDrop()"));
  assert.ok(drop.includes("if (executed === undefined) return;"));
  assert.ok(drop.indexOf("if (executed === undefined) return;") < drop.indexOf("connectionStore.removeTreeNode"));
  assert.ok(drop.includes("refreshTriggerStateAfterMutation(node)"));
});
