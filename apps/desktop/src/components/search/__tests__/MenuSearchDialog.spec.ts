import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../MenuSearchDialog.vue", import.meta.url), "utf8");

describe("MenuSearchDialog", () => {
  it("guards live-search results against stale async responses", () => {
    expect(dialogSource).toContain("const requestId = ++searchRequestId");
    expect(dialogSource).toContain("requestId === searchRequestId");
  });

  it("hands the table-data keyword to the database scanner", () => {
    expect(dialogSource).toContain('emit("open-data-search", keyword)');
    expect(dialogSource).toContain('activeMode.value === "data"');
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
