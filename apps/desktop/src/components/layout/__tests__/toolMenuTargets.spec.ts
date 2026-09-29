import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const sqlFile = readFileSync(new URL("../../sql-file/SqlFileExecutionDialog.vue", import.meta.url), "utf8");

describe("Tools menu target selection", () => {
  it("opens the shared picker instead of silently using an active or first connection", () => {
    for (const [event, kind] of [
      ["open-sessions", "processlist"],
      ["open-invalid-objects", "routine-health"],
      ["open-top-sql", "top-sql"],
      ["open-command-window", "command-window"],
      ["open-table-import", "table-import"],
    ]) {
      expect(app).toContain(`@${event}="openToolTargetPicker('${kind}')"`);
    }
    expect(app).toContain('@confirm="confirmToolTarget"');
    expect(app).toContain('openTableImportForTarget(target.connectionId, target.database || "")');
    expect(app).toContain('openToolTargetPicker("command-window")');
  });

  it("requires explicit connection selection for SQL-file execution without a context prefill", () => {
    expect(sqlFile).toMatch(/function resolveInitialConnectionId\(\)[\s\S]*?return "";/);
    expect(sqlFile).not.toContain('return sqlConnections.value[0]?.id ?? ""');
  });
});
