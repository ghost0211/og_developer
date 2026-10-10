// SPDX-License-Identifier: Apache-2.0
// Adapted from dbx 4a997fe6 for OG Developer's local-search runtime.
import type { TableInfo, TreeNode, TreeNodeType } from "@/types/database";
import { buildTableTreeNodes } from "@/lib/table/tableTree";
import { createSidebarLabelMatcher } from "./sidebarSearch";
import { reuseLiveSidebarTreeNodes } from "./sidebarSearchTree";

const parentTypes = new Set<TreeNodeType>(["database", "schema", "group-tables"]);
const childTypes = new Set<TreeNodeType>(["table", "view", "materialized_view"]);

export interface LocalTableSearchSnapshot {
  epoch: number;
  entries: TableInfo[] | null;
}

export interface LocalTableSearchOptions {
  enabled: boolean;
  epoch: number;
  queries: Readonly<Record<string, string>>;
  indexedResults: Readonly<Record<string, LocalTableSearchSnapshot>>;
}

export function filterLocallySearchedTables(nodes: TreeNode[], options: LocalTableSearchOptions): TreeNode[] {
  if (!options.enabled) return nodes;
  const result = nodes.map((node) => {
    const children = node.children ? filterLocallySearchedTables(node.children, options) : undefined;
    const query = parentTypes.has(node.type) ? options.queries[node.id]?.trim() : "";
    if (!query || !children) return children === node.children ? node : { ...node, children };
    // Keep existing case-insensitive name/abbreviation/regex semantics; compile
    // the matcher once for both names and descriptions.
    const matcher = createSidebarLabelMatcher(query.toLowerCase());
    const matches = (name: string, comment?: string | null) => !!matcher(name.toLowerCase()) || (typeof comment === "string" && !!matcher(comment.toLowerCase()));
    const snapshot = options.indexedResults[node.id];
    // A metadata refresh (notably RENAME) makes old index names unsafe. Use
    // fresh live nodes until a new index snapshot is explicitly loaded.
    const indexed = snapshot && snapshot.epoch === options.epoch ? snapshot.entries : null;
    const matchingChildren = indexed
      ? reuseLiveSidebarTreeNodes(buildTableTreeNodes({ nodeId: node.id, connectionId: node.connectionId || "", database: node.database || "", schema: node.schema, catalog: node.catalog, tables: indexed.filter((entry) => matches(entry.name, entry.comment)) }), children)
      : children.filter((child) => childTypes.has(child.type) && matches(child.label, child.comment));
    if (matchingChildren.length === children.length && matchingChildren.every((child, i) => child === children[i])) return children === node.children ? node : { ...node, children };
    return { ...node, children: matchingChildren };
  });
  return result.every((node, i) => node === nodes[i]) ? nodes : result;
}
