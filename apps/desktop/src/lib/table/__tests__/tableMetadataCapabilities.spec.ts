import { describe, expect, it } from "vitest";
import { getTableMetadataCapabilities, firstStructureMetadataTab, isStructureMetadataTabSupported } from "@/lib/table/tableMetadataCapabilities";

describe("tableMetadataCapabilities", () => {
  it("exposes full metadata capabilities for openGauss and Postgres", () => {
    expect(getTableMetadataCapabilities("opengauss")).toEqual({
      columns: true,
      indexes: true,
      foreignKeys: true,
      triggers: true,
      ddl: true,
    });
    expect(getTableMetadataCapabilities("postgres")).toEqual({
      columns: true,
      indexes: true,
      foreignKeys: true,
      triggers: true,
      ddl: true,
    });
  });

  it("resolves the first editable tab and supported tabs", () => {
    const caps = getTableMetadataCapabilities("opengauss");
    expect(firstStructureMetadataTab(caps, false)).toBe("columns");
    expect(isStructureMetadataTabSupported("ddl", caps, false)).toBe(true);
    expect(isStructureMetadataTabSupported("ddl", caps, true)).toBe(false);
  });
});
