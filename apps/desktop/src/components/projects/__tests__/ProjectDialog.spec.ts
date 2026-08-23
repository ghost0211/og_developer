import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectDialogSource = readFileSync(new URL("../ProjectDialog.vue", import.meta.url), "utf8");

describe("ProjectDialog layout", () => {
  it("reserves space for the dialog close button in the header", () => {
    const headerClass = projectDialogSource.match(/<DialogHeader class="([^"]+)">/)?.[1] ?? "";
    expect(headerClass.split(/\s+/)).toContain("pr-12");
  });
});
