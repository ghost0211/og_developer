import { describe, expect, it } from "vitest";
import { buildGroupedObjectTreeNodes } from "../tableTree";

describe("package node shape", () => {
  it("generates objectName for PACKAGE group child", () => {
    const groups = buildGroupedObjectTreeNodes({
      nodeId: "conn:db",
      connectionId: "conn",
      database: "db",
      objects: [{ name: "my_pkg", object_type: "PACKAGE", schema: "gaussdb", comment: null } as any],
    });
    const pkgGroup = groups.find((g) => g.type === "group-packages");
    expect(pkgGroup).toBeTruthy();
    const child = pkgGroup!.children?.[0];
    console.log("package child:", JSON.stringify(child, null, 2));
    expect(child?.type).toBe("package");
    expect(child?.objectName).toBe("my_pkg");
  });
});
