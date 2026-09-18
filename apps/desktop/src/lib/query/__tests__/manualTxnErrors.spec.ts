import { describe, expect, it } from "vitest";
import { isTerminalManualTxnError } from "@/lib/query/manualTxnErrors";

describe("isTerminalManualTxnError", () => {
  it("matches server-side rollback messages", () => {
    expect(isTerminalManualTxnError("deadlock detected, transaction rolled back")).toBe(true);
    expect(isTerminalManualTxnError("事务已自动回滚")).toBe(true);
  });

  it("matches a missing backend session so the tab drops its stale txnSessionId", () => {
    // Regression: the idle watcher (or a backend restart) removed the manual
    // transaction session; keeping the stale id made every later statement
    // fail with this same error until the page was refreshed.
    expect(isTerminalManualTxnError("Transaction session not found")).toBe(true);
  });

  it("keeps ordinary statement errors retryable inside the transaction", () => {
    expect(isTerminalManualTxnError('ERROR: relation "no_such_table" does not exist')).toBe(false);
    expect(isTerminalManualTxnError('ERROR: syntax error at or near "selct"')).toBe(false);
  });
});
