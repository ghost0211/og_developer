import type { SchemaDiffDeployResult } from "@/types/database";

export interface DeployTxResult {
  success: boolean;
  status?: string;
  message: string;
  affectedRows?: number;
  error?: string;
  executedCount?: number;
  statementCount?: number;
}

/**
 * Maps a Schema Diff deploy result onto the labels the result dialog renders.
 *
 * `status` comes from the backend, which is the only side that knows whether the deploy ran as one
 * transaction; this function must not re-derive it from `success`, because it cannot tell a rollback
 * apart from an unknown outcome.
 */
export function buildDeployTxResult(result: SchemaDiffDeployResult | null | undefined, t: (key: string, params?: Record<string, any>) => string): DeployTxResult {
  if (!result) {
    return { success: false, status: "unknown", message: t("diff.deployFailed", { status: "unknown" }) };
  }

  const { status, error } = result;
  const executedCount = result.executedStatements;
  const statementCount = result.totalStatements;

  if (result.success && status === "committed") {
    return { success: true, status, message: t("diff.executeSuccess"), executedCount, statementCount };
  }

  if (status === "rolled_back") {
    const detail = error ? `: ${error}` : "";
    return {
      success: false,
      status,
      message: `${t("diff.deployRolledBack")}${detail}`,
      error: error ?? undefined,
      executedCount,
      statementCount,
    };
  }

  // Reserved for a deploy path that cannot guarantee atomicity, where some statements may have been
  // applied even though the deploy failed.
  if (status === "mixed") {
    return {
      success: false,
      status,
      message: t("diff.deployMixed", { executedCount: executedCount ?? 0, statementCount: statementCount ?? 0 }),
      error: error ?? undefined,
      executedCount,
      statementCount,
    };
  }

  return {
    success: false,
    status: status || "unknown",
    message: error ?? t("diff.deployFailed", { status: status || "unknown" }),
    error: error ?? undefined,
    executedCount,
    statementCount,
  };
}
