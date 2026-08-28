import { describe, expect, it, vi } from "vitest";
import { runBatchTableDrop } from "@/lib/table/batchTableDrop";
import type { QueryResult } from "@/types/database";

function queryResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, ...overrides };
}

const plan = [
  { target: "orders", sql: "DROP TABLE orders" },
  { target: "customers", sql: "DROP TABLE customers" },
  { target: "events", sql: "DROP TABLE events" },
];

describe("batch table drop", () => {
  it("maps indexed batch results back to their exact targets", async () => {
    const result = await runBatchTableDrop({
      plan,
      executeBatch: async () => [queryResult({ statement_index: 0 }), queryResult({ statement_index: 1, execution_error: true, columns: ["Error"], rows: [["locked"]] })],
      onProgress: vi.fn(),
    });

    expect(result.succeeded).toEqual(["orders"]);
    expect(result.failed?.message).toBe("locked");
  });

  it("succeeds when every statement reports an index", async () => {
    const result = await runBatchTableDrop({
      plan,
      executeBatch: async () => [queryResult({ statement_index: 0 }), queryResult({ statement_index: 1 }), queryResult({ statement_index: 2 })],
      onProgress: vi.fn(),
    });

    expect(result.succeeded).toEqual(["orders", "customers", "events"]);
    expect(result.failed).toBeUndefined();
  });

  it("fails closed when a batch omits statement indexes", async () => {
    const result = await runBatchTableDrop({
      plan,
      executeBatch: async () => [queryResult()],
      onProgress: vi.fn(),
    });

    expect(result.succeeded).toEqual([]);
    expect(result.failed?.message).toBe("Batch drop did not report a result for every statement");
  });
});
