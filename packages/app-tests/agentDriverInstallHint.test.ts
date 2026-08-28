import assert from "node:assert/strict";
import { test } from "vitest";
import { agentDriverInstallKey, appendAgentDriverUpdateHint, hasAgentDriverUpdate, showAgentDriverInstallHint } from "../../apps/desktop/src/lib/connection/agentDriverInstallHint.ts";

test("hides the agent driver install hint when the selected driver is installed", () => {
  assert.equal(showAgentDriverInstallHint("informix", [{ db_type: "informix", installed: true }]), false);
});

test("shows the agent driver install hint when the selected driver is missing", () => {
  assert.equal(showAgentDriverInstallHint("informix", [{ db_type: "informix", installed: false }]), true);
});

test("shows the agent driver install hint for TDengine when missing", () => {
  assert.equal(showAgentDriverInstallHint("tdengine", [{ db_type: "tdengine", installed: false }]), true);
});

test("shows the agent driver install hint for Access when missing", () => {
  assert.equal(showAgentDriverInstallHint("access", [{ db_type: "access", installed: false }]), true);
});

test("does not show agent driver install hints for built-in database types", () => {
  assert.equal(showAgentDriverInstallHint("mysql", [{ db_type: "informix", installed: false }]), false);
});




test("uses the selected GBase 8s agent for install hints", () => {
  assert.equal(
    showAgentDriverInstallHint(
      "gbase",
      [
        { db_type: "gbase", installed: true },
        { db_type: "gbase8s", installed: false },
      ],
      "gbase8s",
    ),
    true,
  );
  assert.equal(
    showAgentDriverInstallHint(
      "gbase",
      [
        { db_type: "gbase", installed: false },
        { db_type: "gbase8s", installed: true },
      ],
      "gbase8s",
    ),
    false,
  );
});



test("appends agent driver update hints once", () => {
  const hint = "Driver update available.";
  assert.equal(appendAgentDriverUpdateHint("Original error", hint), "Original error\n\nDriver update available.");
  assert.equal(appendAgentDriverUpdateHint("Original error\n\nDriver update available.", hint), "Original error\n\nDriver update available.");
  assert.equal(appendAgentDriverUpdateHint("", hint), hint);
});
