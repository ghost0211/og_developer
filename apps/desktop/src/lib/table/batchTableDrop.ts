import type { QueryResult } from "@/types/database";

export interface BatchTableDropPlanItem<T> {
  target: T;
  sql: string;
}

export interface BatchTableDropProgress {
  completed: number;
  total: number;
  success: boolean;
}

export interface BatchTableDropResult<T> {
  succeeded: T[];
  failed?: Error;
}

interface RunBatchTableDropOptions<T> {
  plan: readonly BatchTableDropPlanItem<T>[];
  executeBatch: (sql: string, onProgress: (progress: BatchTableDropProgress) => void) => Promise<QueryResult[]>;
  onProgress: (progress: BatchTableDropProgress) => void;
}

function batchDropError(result: QueryResult): Error {
  return new Error(String(result.rows[0]?.[0] ?? "Batch drop failed"));
}

export async function runBatchTableDrop<T>({ plan, executeBatch, onProgress }: RunBatchTableDropOptions<T>): Promise<BatchTableDropResult<T>> {
  const results = await executeBatch(plan.map(({ sql }) => sql).join(";\n"), onProgress);
  const failedResult = results.find((result) => result.execution_error === true);

  const succeededIndexes = new Set(results.filter((result) => result.execution_error !== true && Number.isInteger(result.statement_index)).map((result) => result.statement_index!));
  const succeeded = plan.filter((_, index) => succeededIndexes.has(index)).map(({ target }) => target);
  if (failedResult) return { succeeded, failed: batchDropError(failedResult) };
  if (succeeded.length !== plan.length) {
    return { succeeded, failed: new Error("Batch drop did not report a result for every statement") };
  }
  return { succeeded };
}
