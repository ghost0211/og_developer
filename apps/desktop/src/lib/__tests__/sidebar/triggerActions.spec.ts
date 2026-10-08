import { describe, expect, it, vi } from "vitest";
import { buildTriggerEnabledSql, canChangeTriggerEnabledMode, executeTriggerEnabledChange, normalizeTriggerEnabledMode, synchronizeTriggerNodes } from "@/lib/sidebar/triggerActions";
import { getTreeNodeIconInfo } from "@/lib/sidebar/treeNodeIcon";
import type { ConnectionConfig, TreeNode } from "@/types/database";

const connection = { id: "c", db_type: "opengauss", read_only: false } as ConnectionConfig;
const trigger: TreeNode = { id: "one", label: "audit", type: "trigger", objectName: "audit", tableName: "users", schema: "auth", connectionId: "c", database: "db", triggerEnabledMode: "O" };

describe("trigger actions", () => {
  it("quotes schema, table and trigger independently and never uses the display label", () => {
    expect(buildTriggerEnabledSql({ ...trigger, label: "wrong" } as TreeNode, false)).toBe('ALTER TABLE "auth"."users" DISABLE TRIGGER "audit";');
    expect(buildTriggerEnabledSql({ schema: 'a"b', tableName: "u.s", objectName: 'ALL"; DROP TABLE users; --' }, true)).toBe('ALTER TABLE "a""b"."u.s" ENABLE TRIGGER "ALL""; DROP TABLE users; --";');
    expect(() => buildTriggerEnabledSql({ objectName: "audit" }, true)).toThrow("identity");
  });

  it("preserves origin, disabled, replica and always modes without inventing unknown state", () => {
    for (const mode of ["O", "D", "R", "A"] as const) expect(normalizeTriggerEnabledMode(mode)).toBe(mode);
    expect(normalizeTriggerEnabledMode("unknown")).toBeUndefined();
    expect(normalizeTriggerEnabledMode(undefined)).toBeUndefined();
    expect(canChangeTriggerEnabledMode(trigger, connection)).toBe(true);
    expect(canChangeTriggerEnabledMode({ ...trigger, triggerEnabledMode: undefined }, connection)).toBe(false);
    expect(canChangeTriggerEnabledMode({ ...trigger, schema: undefined }, connection)).toBe(false);
    expect(canChangeTriggerEnabledMode(trigger, { ...connection, read_only: true })).toBe(false);
    expect(canChangeTriggerEnabledMode(trigger, { ...connection, db_type: "mysql" })).toBe(false);
  });

  it("does not show success or refresh after production confirmation is cancelled", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const onExecuted = vi.fn();
    expect(await executeTriggerEnabledChange({ node: trigger, connection, enabled: false, execute, onExecuted })).toBe(false);
    expect(onExecuted).not.toHaveBeenCalled();
  });

  it("rechecks read-only and preserves state after execution failure", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("permission denied"));
    const onExecuted = vi.fn();
    expect(await executeTriggerEnabledChange({ node: trigger, connection: { ...connection, read_only: true }, enabled: false, execute, onExecuted })).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    await expect(executeTriggerEnabledChange({ node: trigger, connection, enabled: false, execute, onExecuted })).rejects.toThrow("permission denied");
    expect(onExecuted).not.toHaveBeenCalled();
    expect(trigger.triggerEnabledMode).toBe("O");
  });

  it("refreshes only after successful guarded execution", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [], columns: [] });
    const onExecuted = vi.fn();
    expect(await executeTriggerEnabledChange({ node: trigger, connection, enabled: true, execute, onExecuted })).toBe(true);
    expect(onExecuted).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith('ALTER TABLE "auth"."users" ENABLE TRIGGER "audit";');
  });

  it("synchronizes schema/table/reference copies but not a same-named trigger on another table", () => {
    const schemaCopy = { ...trigger };
    const tableCopy = { ...trigger, id: "table", meta: { name: "audit", timing: "AFTER", event: "UPDATE", enabled_mode: "O" } };
    const referenceCopy = { ...trigger, id: "ref" };
    const otherTable = { ...trigger, id: "other", tableName: "orders" };
    const otherSchema = { ...trigger, id: "other-schema", schema: "app" };
    const tree: TreeNode[] = [{ id: "root", label: "root", type: "schema", children: [schemaCopy, tableCopy, otherTable, otherSchema], hiddenChildren: [referenceCopy] }];
    expect(synchronizeTriggerNodes(tree, trigger, [{ name: "audit", timing: "AFTER", event: "UPDATE", enabled_mode: "D" }])).toEqual([]);
    expect([schemaCopy, tableCopy, referenceCopy].map((node) => node.triggerEnabledMode)).toEqual(["D", "D", "D"]);
    expect(tableCopy.meta.enabled_mode).toBe("D");
    expect(otherTable.triggerEnabledMode).toBe("O");
    expect(otherSchema.triggerEnabledMode).toBe("O");
    expect(getTreeNodeIconInfo(schemaCopy)?.colorClass).toBe("text-muted-foreground");
    expect(synchronizeTriggerNodes(tree, trigger, [])).toEqual(["one", "table", "ref"]);
  });
});
