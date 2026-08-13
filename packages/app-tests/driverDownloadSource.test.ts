import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}

test("agent driver installation still honors the configured download source", () => {
  const backendApi = source("apps/desktop/src/lib/backend/api.ts");

  assert.match(backendApi, /backend\.listInstalledAgents\(useSettingsStore\(\)\.editorSettings\.updateDownloadSource\)/);
  assert.match(backendApi, /backend\.installAgent\(dbType, useSettingsStore\(\)\.editorSettings\.updateDownloadSource(?:, operationId)?\)/);
  assert.match(backendApi, /backend\.upgradeAllAgents\(useSettingsStore\(\)\.editorSettings\.updateDownloadSource(?:, operationId)?\)/);
  assert.match(backendApi, /backend\.reinstallJre\(jreKey, useSettingsStore\(\)\.editorSettings\.updateDownloadSource(?:, operationId)?\)/);
});

test("the driver management page and its update badge are gone", () => {
  const app = source("apps/desktop/src/App.vue");
  assert.doesNotMatch(app, /DriverStoreDialog/);
  assert.doesNotMatch(app, /refreshAgentDriverUpdateCount/);
});
