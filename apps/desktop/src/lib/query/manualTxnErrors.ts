/**
 * Decides whether a manual-transaction error means the backend transaction
 * session is gone for good, so the tab must drop its `txnSessionId` instead of
 * replaying every later statement against a dead session id.
 *
 * Two sources produce this state:
 * - the server rolled the transaction back itself (deadlock, fatal error), or
 * - the backend no longer holds the session: the idle watcher reclaimed it, or
 *   the app restarted while a restored tab still carried its old session id.
 */
export function isTerminalManualTxnError(errorMessage: string): boolean {
  return /rolled.?back/i.test(errorMessage) || errorMessage.includes("已自动回滚") || errorMessage.includes("Transaction session not found");
}
