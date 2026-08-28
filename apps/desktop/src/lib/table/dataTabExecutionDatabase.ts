import type { ConnectionConfig } from "@/types/database";

export function dataTabExecutionDatabase(_connection: ConnectionConfig | undefined, tabDatabase: string, _catalog?: string): string {
  return tabDatabase;
}
