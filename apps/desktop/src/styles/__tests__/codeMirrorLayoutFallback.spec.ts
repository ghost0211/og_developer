import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

describe("CodeMirror WebView layout fallback", () => {
  it("keeps the editor structure usable when style-mod rules are unavailable", () => {
    expect(globalsCss).toContain(":where(.cm-editor) .cm-scroller");
    expect(globalsCss).toContain("display: flex;");
    expect(globalsCss).toContain(":where(.cm-editor) .cm-gutters");
    expect(globalsCss).toContain(":where(.cm-editor) .cm-gutter");
    expect(globalsCss).toContain(":where(.cm-editor) .cm-announced");
    expect(globalsCss).toContain(":where(.cm-editor) .cm-layer > *");
    expect(globalsCss).toContain(":where(.cm-editor) .cm-content.cm-lineWrapping");
  });

  it("bounds the bookmark hit target to a narrow gutter", () => {
    const bookmarkRule = globalsCss.match(/:where\(\.cm-editor\) \.cm-sql-bookmark-gutter \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(bookmarkRule).toContain("flex: 0 0 18px;");
    expect(bookmarkRule).toContain("max-width: 18px;");
  });
});
