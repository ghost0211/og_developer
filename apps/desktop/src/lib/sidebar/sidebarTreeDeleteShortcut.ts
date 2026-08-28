import type { DatabaseType, TreeNode } from "@/types/database";

interface SidebarTreeDeleteShortcutContext {
  activeNode: TreeNode;
  selectedNodes: readonly TreeNode[];
  databaseTypeForNode: (node: TreeNode) => DatabaseType | undefined;
  requestHBaseTableDelete: () => boolean;
  requestDefaultDelete: () => boolean;
}

function isUnmodifiedDeleteShortcut(event: KeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === "Delete" || event.key === "Backspace");
}

export function handleSidebarTreeDeleteShortcut(event: KeyboardEvent, context: SidebarTreeDeleteShortcutContext): boolean {
  if (!isUnmodifiedDeleteShortcut(event)) return false;

  const handled = context.requestDefaultDelete();
  if (!handled) return false;

  event.preventDefault();
  event.stopPropagation();
  return true;
}
