import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../DdlViewDialog.vue", import.meta.url), "utf8");

describe("DdlViewDialog layout", () => {
  it("keeps the loading, editor, and footer rows in a stable dialog viewport", () => {
    expect(source).toContain("h-[min(760px,calc(var(--dbx-viewport-height)-2rem))]");
    expect(source).toContain("grid-rows-[auto_minmax(0,1fr)_auto]");
    expect(source).toContain('<div class="grid min-h-0 gap-3">');
  });

  it("gives the CodeMirror host a definite full-height positioning context", () => {
    expect(source).toContain('ref="ddlEditorContainer" class="absolute inset-0"');
    expect(source).toContain(".ddl-view-editor :deep(.cm-editor),");
    expect(source).toContain("height: 100%;");
  });
});
