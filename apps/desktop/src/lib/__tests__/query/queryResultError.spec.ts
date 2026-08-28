import { describe, expect, it } from "vitest";

import type { QueryResult } from "@/types/database";

import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";

function errorResult(message: string): QueryResult {
  return { columns: ["Error"], rows: [[message]], affected_rows: 0, execution_time_ms: 0 };
}

function dataResult(columns: string[]): QueryResult {
  return { columns, rows: [], affected_rows: 0, execution_time_ms: 0 };
}

describe("isQueryExecutionErrorResult", () => {
  it("recognizes explicit execution errors for PostgreSQL", () => {
    expect(isQueryExecutionErrorResult({ ...errorResult("relation does not exist"), execution_error: true })).toBe(true);
  });

  it("requires an explicit marker for PostgreSQL result groups", () => {
    expect(isQueryExecutionErrorResult(errorResult("relation does not exist"))).toBe(false);
  });

  it("does not treat a successful Error alias as a failure", () => {
    expect(isQueryExecutionErrorResult({ ...dataResult(["Error"]), rows: [["2"]] })).toBe(false);
  });
});
