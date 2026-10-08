import type { Component } from "vue";
import { ArrowLeftRight, Braces, Columns3, Database, Eye, FileCode, FolderClosed, FolderOpen, GitFork, Key, Link, Link2, ListOrdered, ListTree, Package, Plus, ScrollText, Table, TableProperties, UsersRound, Zap } from "@lucide/vue";
import type { ColumnInfo, TreeNode } from "@/types/database";

export type TreeNodeIconInfo = {
  icon: Component;
  colorClass: string;
};

/**
 * Synonym icon follows the resolved target object type (targetKind carries the
 * openGauss relkind / prokind letter); unresolved targets keep the link icon.
 * Shared by the sidebar tree item renderer.
 */
export function synonymIconInfoForTargetKind(targetKind?: string): TreeNodeIconInfo {
  switch (targetKind) {
    case "r":
      return { icon: Table, colorClass: "text-green-500" };
    case "v":
      return { icon: Eye, colorClass: "text-purple-500" };
    case "m":
      return { icon: Eye, colorClass: "text-indigo-500" };
    case "S":
      return { icon: ListOrdered, colorClass: "text-emerald-500" };
    case "f":
      return { icon: Braces, colorClass: "text-amber-500" };
    case "p":
      return { icon: ScrollText, colorClass: "text-blue-500" };
    default:
      return { icon: Link2, colorClass: "text-sky-500" };
  }
}

export function getTreeNodeIconInfo(node: TreeNode): TreeNodeIconInfo | null {
  switch (node.type) {
    case "schema":
      return { icon: node.isExpanded ? FolderOpen : FolderClosed, colorClass: "text-amber-500" };
    case "connection":
    case "database":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "table":
      return { icon: Table, colorClass: "text-green-500" };
    case "view":
      return { icon: Eye, colorClass: "text-purple-500" };
    case "materialized_view":
      return { icon: Eye, colorClass: "text-indigo-500" };
    case "column":
      return { icon: Columns3, colorClass: (node.meta as ColumnInfo | undefined)?.is_primary_key ? "text-orange-400" : "text-muted-foreground" };
    case "group-columns":
      return { icon: ListTree, colorClass: "text-green-400" };
    case "group-indexes":
    case "index":
      return { icon: Key, colorClass: "text-amber-500" };
    case "group-fkeys":
      return { icon: Link, colorClass: "text-blue-400" };
    case "fkey":
      return { icon: Link, colorClass: "text-blue-300" };
    case "group-triggers":
      return { icon: Zap, colorClass: "text-orange-400" };
    case "trigger":
      return { icon: Zap, colorClass: node.triggerEnabledMode === "D" ? "text-muted-foreground" : "text-orange-300" };
    case "group-constraints":
    case "constraint":
      return { icon: Key, colorClass: "text-amber-500" };
    case "group-table-partitions":
    case "group-table-subpartitions":
      return { icon: node.isExpanded ? FolderOpen : FolderClosed, colorClass: "text-green-400" };
    case "partition":
    case "subpartition":
      return { icon: TableProperties, colorClass: "text-green-400" };
    case "object-browser":
      return { icon: TableProperties, colorClass: "text-primary" };
    case "user-admin":
      return { icon: UsersRound, colorClass: "text-primary" };
    case "procedure":
      return { icon: ScrollText, colorClass: "text-blue-500" };
    case "function":
      return { icon: Braces, colorClass: "text-amber-500" };
    case "sequence":
      return { icon: ListOrdered, colorClass: "text-emerald-500" };
    case "synonym":
      return synonymIconInfoForTargetKind(node.targetKind);
    case "package":
      return { icon: Package, colorClass: "text-cyan-500" };
    case "package-body":
      return { icon: FileCode, colorClass: "text-cyan-400" };
    case "group-tables":
      return { icon: Table, colorClass: "text-green-500" };
    case "group-views":
      return { icon: Eye, colorClass: "text-purple-500" };
    case "group-materialized-views":
      return { icon: Eye, colorClass: "text-indigo-500" };
    case "group-procedures":
      return { icon: ScrollText, colorClass: "text-blue-500" };
    case "group-functions":
      return { icon: Braces, colorClass: "text-amber-500" };
    case "group-sequences":
      return { icon: ListOrdered, colorClass: "text-emerald-500" };
    case "group-synonyms":
      return { icon: Link2, colorClass: "text-sky-500" };
    case "group-packages":
      return { icon: Package, colorClass: "text-cyan-500" };
    case "group-package-bodies":
      return { icon: FileCode, colorClass: "text-cyan-400" };
    case "group-partitions":
      return { icon: node.isExpanded ? FolderOpen : FolderClosed, colorClass: "text-green-400" };
    case "group-extensions":
      return { icon: Package, colorClass: "text-violet-500" };
    case "extension":
      return { icon: Package, colorClass: "text-violet-400" };
    case "group-references":
      return { icon: ArrowLeftRight, colorClass: "text-orange-500" };
    case "group-referenced-by":
      return { icon: GitFork, colorClass: "text-teal-500" };
    case "load-more":
      return { icon: Plus, colorClass: "text-primary" };
    default:
      return { icon: Database, colorClass: "text-muted-foreground" };
  }
}
