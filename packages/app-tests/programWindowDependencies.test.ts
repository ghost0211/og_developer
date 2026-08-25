import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("apps/desktop/src/components/objects/ProgramWindowPanel.vue", "utf8");

describe("program window dependencies", () => {
  it("shows dependency request failures instead of converting them to empty results", () => {
    expect(source).toContain("dependenciesError.value = e?.message || String(e)");
    expect(source).toMatch(/v-else-if="dependenciesError"/);
    expect(source).not.toMatch(/listObjectReferences\([^\n]+\.catch\(\(\) => \[\]\)/);
  });
});
