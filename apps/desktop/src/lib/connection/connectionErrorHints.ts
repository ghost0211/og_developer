import type { ConnectionConfig } from "@/types/database";

type Translate = (key: string) => string;

export function isJdbcMissingRuntimeDependencyError(message: string): boolean {
  return /Missing Java class|NoClassDefFoundError|ClassNotFoundException/i.test(message);
}

function appendHint(message: string, hint: string): string {
  return message.includes(hint) ? message : `${message}\n\n${hint}`;
}

export function appendConnectionErrorHints(config: ConnectionConfig | undefined, message: string, t: Translate): string {
  if (!config) return message;
  if (config.db_type === "jdbc" && isJdbcMissingRuntimeDependencyError(message)) {
    return appendHint(message, t("connection.jdbcMissingRuntimeDependencyHint"));
  }
  return message;
}
