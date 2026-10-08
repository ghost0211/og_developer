import { describe, expect, it } from "vitest";
import { buildGroupedObjectTreeNodes, buildObjectGroupPlaceholderNodes, buildSimpleObjectTreeNodes } from "@/lib/table/tableTree";
import { sidebarObjectKindsForDatabase } from "@/lib/database/databaseObjectCapabilities";

const context = { nodeId: "c:db:app", connectionId: "c", database: "db", schema: "app" };
const objects = ["orders", "users"].map((parent_name) => ({
  name: "audit",
  object_type: "TRIGGER",
  schema: "app",
  parent_schema: "app",
  parent_name,
  comment: "Audit changes",
  enabled_mode: "R",
}));

describe("schema trigger overview", () => {
  it.each(["A", "B", "PG", undefined])("advertises triggers in openGauss %s mode between synonyms and types", (mode) => {
    const groups = buildObjectGroupPlaceholderNodes({ ...context, objectTypes: sidebarObjectKindsForDatabase("opengauss", mode) });
    const types = groups.map((node) => node.type);
    expect(types.indexOf("group-triggers")).toBeGreaterThan(types.indexOf("group-synonyms"));
    expect(types.indexOf("group-triggers")).toBeLessThan(types.indexOf("group-types"));
    expect(groups.find((node) => node.type === "group-triggers")?.tableName).toBeUndefined();
  });

  it.each(["grouped", "simple"])("keeps duplicate names distinct and preserves table identity in %s mode", (mode) => {
    const nodes = mode === "grouped" ? buildGroupedObjectTreeNodes({ ...context, objects: [...objects, objects[0]!] })[0]!.children! : buildSimpleObjectTreeNodes({ ...context, objects: [...objects, objects[0]!] });
    expect(nodes).toHaveLength(2);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(2);
    expect(nodes.map((node) => node.tableName)).toEqual(["orders", "users"]);
    nodes.forEach((node) => {
      expect(node.objectName).toBe("audit");
      expect(node.type).toBe("trigger");
      expect(node.schema).toBe("app");
      expect(node.triggerEnabledMode).toBe("R");
      expect(node.comment).toBe(`${node.tableName} — Audit changes`);
    });
  });
});
