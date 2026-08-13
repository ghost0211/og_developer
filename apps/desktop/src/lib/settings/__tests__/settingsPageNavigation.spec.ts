import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const settingsDialogSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");

describe("settings page navigation", () => {
  it("replays repeated navigation requests for the same tab", () => {
    expect(appSource).toContain("settingsNavigationRequestId.value += 1");
    expect(appSource).toContain(':navigation-request-id="settingsNavigationRequestId"');
    expect(settingsDialogSource).toContain("navigationRequestId?: number;");
    expect(settingsDialogSource).toMatch(/watch\(\s*\(\) => props\.navigationRequestId,/);
  });

  it("opens settings as a dialog instead of an application tab", () => {
    expect(appSource).toContain('<EditorSettingsPage\n          v-if="settingsDialogOpen"');
    expect(appSource).toContain('variant="dialog"');
    expect(appSource).not.toContain(":settings-page-open=");
    expect(appSource).not.toContain('variant="page"');
  });
});
