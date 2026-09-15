import { describe, expect, it } from "vitest";
import { buildDeployTxResult } from "@/lib/schema/deployTxResult";
import type { SchemaDiffDeployResult } from "@/types/database";

const t = (key: string, params?: Record<string, any>) => {
  const fallback: Record<string, string> = {
    "diff.executeSuccess": "Executed successfully",
    "diff.deployMixed": "Deployment partially completed. Some statements may already be applied ({executedCount}/{statementCount}). DDL may not be transactional.",
    "diff.deployRolledBack": "All changes have been rolled back.",
    "diff.deployFailed": "Deployment failed: {status}",
  };
  let msg = fallback[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replace(`{${k}}`, String(v));
    }
  }
  return msg;
};

/**
 * A successful deploy as `ogdeveloper_core::query::SchemaDiffDeployResult` actually serializes it.
 * These fixtures deliberately use the real wire shape: the previous suite fed hand-written 2PC
 * `TransactionLog` objects, so it kept passing while every real deploy rendered as a failure.
 */
const committedPayload: SchemaDiffDeployResult = {
  success: true,
  status: "committed",
  executedStatements: 3,
  totalStatements: 3,
  error: null,
  transactional: true,
};

const rolledBackPayload: SchemaDiffDeployResult = {
  success: false,
  status: "rolled_back",
  executedStatements: 0,
  totalStatements: 3,
  error: 'syntax error at or near "CREAT"',
  transactional: true,
};

describe("buildDeployTxResult", () => {
  it("reports a committed deploy as success", () => {
    const result = buildDeployTxResult(committedPayload, t);

    expect(result.success).toBe(true);
    expect(result.status).toBe("committed");
    expect(result.message).toBe("Executed successfully");
    expect(result.executedCount).toBe(3);
    expect(result.statementCount).toBe(3);
  });

  it("reports a rolled back deploy with the backend error and no executed statements", () => {
    const result = buildDeployTxResult(rolledBackPayload, t);

    expect(result.success).toBe(false);
    expect(result.status).toBe("rolled_back");
    expect(result.message).toContain("rolled back");
    expect(result.message).toContain('syntax error at or near "CREAT"');
    expect(result.error).toBe('syntax error at or near "CREAT"');
    expect(result.executedCount).toBe(0);
    expect(result.statementCount).toBe(3);
  });

  it("never reports success when the backend reports a failure", () => {
    for (const status of ["rolled_back", "mixed"] as const) {
      const result = buildDeployTxResult({ ...rolledBackPayload, status }, t);
      expect(result.success).toBe(false);
    }
  });

  it("keeps the partial-deploy warning wired for a non-transactional path", () => {
    const result = buildDeployTxResult(
      {
        success: false,
        status: "mixed",
        executedStatements: 1,
        totalStatements: 2,
        error: "Statement 2 failed: table already exists",
        transactional: false,
      },
      t,
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe("mixed");
    expect(result.message).toContain("1/2");
    expect(result.message).toContain("may not be transactional");
  });

  it("falls back to the error text when the status is unrecognized", () => {
    const result = buildDeployTxResult({ ...rolledBackPayload, status: "not_a_status" as SchemaDiffDeployResult["status"] }, t);

    expect(result.success).toBe(false);
    expect(result.message).toBe('syntax error at or near "CREAT"');
  });

  it("reports a missing result payload as an unknown failure", () => {
    const result = buildDeployTxResult(null, t);

    expect(result.success).toBe(false);
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("unknown");
  });
});
