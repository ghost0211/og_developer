import { describe, expect, it } from "vitest";
import { isTreeNodeDisabled } from "@/lib/sidebar/treeNodeStatus";
import { getTreeNodeIconInfo } from "@/lib/sidebar/treeNodeIcon";
import { buildGroupedObjectTreeNodes, buildSimpleObjectTreeNodes } from "@/lib/table/tableTree";
import type { TreeNode } from "@/types/database";

const trigger: TreeNode = { id: "trg", label: "audit", type: "trigger" };

describe("database object disabled presentation state", () => {
  it.each(["O", "R", "A", "?", undefined])("does not gray a trigger with non-disabled mode %s", (mode) => {
    expect(isTreeNodeDisabled({ ...trigger, triggerEnabledMode: mode, comment: "disabled", valid: false })).toBe(false);
  });
  it("grays exactly trigger mode D", () => {
    const node = { ...trigger, triggerEnabledMode: "D" };
    expect(isTreeNodeDisabled(node)).toBe(true);
    expect(getTreeNodeIconInfo(node)?.colorClass).toBe("text-muted-foreground");
  });
  it.each(["job", "scheduler"] as const)("uses only explicit enable state for %s", (type) => {
    const node: TreeNode = { id: type, label: type, type, comment: "disabled · every disabled_interval" };
    expect(isTreeNodeDisabled(node)).toBe(false);
    expect(isTreeNodeDisabled({ ...node, jobEnabled: true })).toBe(false);
    expect(isTreeNodeDisabled({ ...node, jobEnabled: false, comment: "enabled" })).toBe(true);
    expect(getTreeNodeIconInfo({ ...node, jobEnabled: false })?.colorClass).toBe("text-muted-foreground");
  });
  it("does not confuse disabled object metadata with unrelated node kinds", () => {
    expect(isTreeNodeDisabled({ ...trigger, type: "table", triggerEnabledMode: "D", jobEnabled: false })).toBe(false);
  });
  it.each(["JOB", "SCHEDULER"] as const)("retains false enable state in simple and grouped %s builders", (object_type) => {
    const options = { nodeId: "c:db:app", connectionId: "c", database: "db", schema: "app", objects: [{ name: "disabled_job", object_type, job_enabled: false }] };
    const simple = buildSimpleObjectTreeNodes(options)[0]!;
    const grouped = buildGroupedObjectTreeNodes(options)[0]!.children![0]!;
    expect(simple.jobEnabled).toBe(false);
    expect(grouped.jobEnabled).toBe(false);
    expect(isTreeNodeDisabled(simple)).toBe(true);
    expect(isTreeNodeDisabled(grouped)).toBe(true);
  });
});
