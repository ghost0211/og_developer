// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import type { DatabaseType, TreeNode } from "@/types/database";
import { handleSidebarTreeDeleteShortcut } from "@/lib/sidebar/sidebarTreeDeleteShortcut";

function tableNode(id: string, connectionId: string): TreeNode {
  return {
    id,
    label: id,
    type: "table",
    connectionId,
    database: "default",
  };
}

function databaseTypeForNode(_node: TreeNode): DatabaseType | undefined {
  return "opengauss";
}

function deleteEvent(key: "Delete" | "Backspace", init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, cancelable: true, ...init });
}

describe("sidebar tree delete shortcut", () => {
  it("keeps the existing generic delete route for SQL tables", () => {
    const activeNode = tableNode("table-1", "opengauss-connection");
    const event = deleteEvent("Delete");
    const requestHBaseTableDelete = vi.fn(() => false);
    const requestDefaultDelete = vi.fn(() => true);

    expect(
      handleSidebarTreeDeleteShortcut(event, {
        activeNode,
        selectedNodes: [activeNode],
        databaseTypeForNode,
        requestHBaseTableDelete,
        requestDefaultDelete,
      }),
    ).toBe(true);
    expect(requestDefaultDelete).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores modified delete shortcuts", () => {
    const activeNode = tableNode("table-1", "opengauss-connection");
    const event = deleteEvent("Delete", { ctrlKey: true });
    const requestHBaseTableDelete = vi.fn(() => false);
    const requestDefaultDelete = vi.fn(() => true);

    expect(
      handleSidebarTreeDeleteShortcut(event, {
        activeNode,
        selectedNodes: [activeNode],
        databaseTypeForNode,
        requestHBaseTableDelete,
        requestDefaultDelete,
      }),
    ).toBe(false);
    expect(requestDefaultDelete).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
