import type { DatabaseType } from "@/types/database";

export function usesOracleSessionCompletionColumns(options: { databaseType?: DatabaseType; selectedSchema?: string; referenceSchema?: string | null; clientSessionId?: string }): boolean {
  // openGauss 不走 Oracle 会话级补全路径，保持原有行为（恒为 false）。
  void options;
  return false;
}
