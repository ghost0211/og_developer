import type { QueryResult } from "@/types/database";

export function isQueryExecutionErrorResult(result: QueryResult): boolean {
  // Multi-statement batch responses use this explicit marker so a successful
  // query column named Error is never promoted as the failed statement.
  return result.execution_error === true;
}
