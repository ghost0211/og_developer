import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

function signatureExtensionSource(): string {
  const start = queryEditorSource.indexOf("buildSqlSignatureExtension = () =>");
  const end = queryEditorSource.indexOf("buildSqlCompletionExtension = () =>");
  return queryEditorSource.slice(start, end);
}

describe("QueryEditor SQL signature refresh wiring", () => {
  it("reconfigures signature help when the database dialect changes", () => {
    expect(queryEditorSource).toContain('let sqlSignatureComp: import("@codemirror/state").Compartment | null = null;');
    expect(queryEditorSource).toContain("sqlSignatureComp.of(buildSqlSignatureExtension())");

    const watcherStart = queryEditorSource.indexOf("watch([() => props.databaseType, () => props.dialect, () => props.syntaxDialect]");
    const watcherEnd = queryEditorSource.indexOf("\n});", watcherStart);
    const dialectWatcher = queryEditorSource.slice(watcherStart, watcherEnd);

    expect(watcherStart).toBeGreaterThanOrEqual(0);
    expect(watcherEnd).toBeGreaterThan(watcherStart);
    expect(dialectWatcher).toContain("sqlSignatureComp.reconfigure(buildSqlSignatureExtension())");
  });
});

describe("QueryEditor SQL signature tooltip lifetime", () => {
  it("keeps CodeMirror viewport clipping so a scrolled-away call cannot stay pinned", () => {
    const extension = signatureExtensionSource();
    expect(extension).not.toContain("clip: false");
  });

  it("dismisses the tooltip on blur and when the tab is deactivated", () => {
    expect(queryEditorSource).toContain("dismissSqlSignatureTooltip(currentView);");
    expect(queryEditorSource).toMatch(/function dismissSqlSignatureTooltip\([\s\S]*?signatureDismissEffect\.of\(null\)/);
    const pause = queryEditorSource.slice(queryEditorSource.indexOf("function pauseQueryEditorBackgroundWork"), queryEditorSource.indexOf("function resumeQueryEditorBackgroundWork"));
    expect(pause).toContain("dismissSqlSignatureTooltip();");
  });

  it("drops pending signature fetches when the scope changes or the tab is hidden", () => {
    const refresh = queryEditorSource.slice(queryEditorSource.indexOf("function refreshCompletionCache()"), queryEditorSource.indexOf("onMounted(async () =>"));
    expect(refresh).toMatch(/sqlSignaturePrefetcher\?\.dispose\(\);[\s\S]*sqlSignaturePrefetcher = null;/);
    const pause = queryEditorSource.slice(queryEditorSource.indexOf("function pauseQueryEditorBackgroundWork"), queryEditorSource.indexOf("function resumeQueryEditorBackgroundWork"));
    expect(pause).toMatch(/sqlSignaturePrefetcher\?\.dispose\(\);[\s\S]*sqlSignaturePrefetcher = null;/);
  });

  it("only recomputes the tooltip for the live doc/selection and revives it on the next edit", () => {
    const extension = signatureExtensionSource();
    expect(extension).toContain('showTooltip.compute(["doc", "selection", refreshField, dismissedField]');
    expect(extension).toMatch(/if \(tr\.docChanged \|\| tr\.selection\) return false;/);
    expect(extension).toContain("if (currentState.field(dismissedField)) return null;");
  });
});
