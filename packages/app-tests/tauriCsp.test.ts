import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));

describe("Tauri Content Security Policy", () => {
  it("allows runtime editor styles without weakening script CSP injection", () => {
    const security = tauriConfig.app.security;

    expect(security.csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(security.devCsp).toContain("style-src 'self' 'unsafe-inline'");
    expect(security.dangerousDisableAssetCspModification).toEqual(["style-src"]);
    expect(security.dangerousDisableAssetCspModification).not.toContain("script-src");
  });
});
