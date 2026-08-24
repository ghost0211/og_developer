import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../MenuSearchDialog.vue", import.meta.url), "utf8");

describe("MenuSearchDialog", () => {
  it("guards live-search results against stale async responses", () => {
    expect(dialogSource).toContain("const requestId = ++searchRequestId");
    expect(dialogSource).toContain("requestId === searchRequestId");
  });

  it("hands the explicitly selected table-data profile to the database scanner", () => {
    expect(dialogSource).toContain('emit("open-data-search", { keyword, connectionId: connection.id, database })');
    expect(dialogSource).toContain('activeMode.value === "data"');
  });

  it("sends only explicitly selected profiles to metadata and source search", () => {
    expect(dialogSource).toContain("selectedTargetKeys");
    expect(dialogSource).toContain("api.searchMetadata(needle, 500, searchableTargets)");
    expect(dialogSource).toContain("api.searchObjectDefinitions(needle, 300, searchableTargets)");
    expect(dialogSource).toContain("selectAllConnections");
    expect(dialogSource).toContain("listDatabaseSearchScopeTargets");
  });

  it("uses filtered result sets for counts, rendering, and keyboard selection", () => {
    expect(dialogSource).toContain("filteredFileHits");
    expect(dialogSource).toContain("filteredMetadataHits");
    expect(dialogSource).toContain("filteredObjectHits");
    expect(dialogSource).toContain("scrollSelectionIntoView");
  });

  it("does not silently search the server working directory without an active project", () => {
    expect(dialogSource).not.toContain('root.value || "."');
    expect(dialogSource).toContain("searchCenter.projectRequired");
  });
});
