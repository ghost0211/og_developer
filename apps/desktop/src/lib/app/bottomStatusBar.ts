import type { ConnectionConfig, QueryResult, QueryTab } from "@/types/database";
import { connectionDriverLabel } from "@/lib/connection/connectionPresentation";

export interface EditorCursorLocation {
  line: number;
  column: number;
}

export interface QueryExecutionFeedback {
  durationMs: number;
  affectedRows: number;
}

export type SqlLineEnding = "LF" | "CRLF";

/** Converts a CodeMirror document offset into the one-based IDE status position. */
export function editorCursorLocation(text: string, offset: number): EditorCursorLocation {
  const cursor = Math.min(text.length, Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0));
  let line = 1;
  let lastLineBreak = -1;
  for (let index = 0; index < cursor; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lastLineBreak = index;
    }
  }
  return { line, column: cursor - lastLineBreak };
}

export function sqlLineEnding(text: string): SqlLineEnding {
  return text.includes("\r\n") ? "CRLF" : "LF";
}

/** Summarizes the latest execution, including every result from a SQL batch. */
export function latestQueryExecutionFeedback(tab: Pick<QueryTab, "result" | "results"> | undefined): QueryExecutionFeedback | undefined {
  if (!tab) return undefined;
  const results: QueryResult[] = tab.results?.length ? tab.results : tab.result ? [tab.result] : [];
  if (!results.length) return undefined;
  return results.reduce(
    (feedback, result) => {
      const rowCount = result.execution_error || result.server_message ? 0 : result.affected_rows > 0 ? result.affected_rows : result.rows.length;
      return {
        durationMs: feedback.durationMs + (Number.isFinite(result.execution_time_ms) ? result.execution_time_ms : 0),
        affectedRows: feedback.affectedRows + rowCount,
      };
    },
    { durationMs: 0, affectedRows: 0 },
  );
}

export function statusBarConnectionLabel(connection: ConnectionConfig | undefined): string {
  if (!connection) return "";
  const info = connection.database_info;
  const driverProfile = connection.driver_profile?.trim().toLowerCase();
  const isOpenGauss = connection.db_type === "opengauss" || driverProfile === "opengauss" || driverProfile === "opengauss-jdbc";
  const reportedProductName = info?.productName?.trim();
  const engine = isOpenGauss ? "openGauss" : reportedProductName || connectionDriverLabel(connection);
  // The PostgreSQL JDBC metadata (notably 9.2.4) describes openGauss's
  // compatibility layer, not the server product version. Do not surface it as
  // if this were a vanilla PostgreSQL connection; a refreshed openGauss
  // database_info with productName=openGauss can still provide its real version.
  const productVersion = isOpenGauss && reportedProductName?.toLowerCase() === "postgresql" ? undefined : info?.productVersion?.trim();
  const engineWithVersion = [engine, productVersion].filter(Boolean).join(" ");
  const connectionName = connection.name.trim();
  const isSameLabel = (value: string) => connectionName.localeCompare(value, undefined, { sensitivity: "accent" }) === 0;
  if (!connectionName || isSameLabel(engine) || isSameLabel(engineWithVersion)) return engineWithVersion;
  return `${connectionName} · ${engineWithVersion}`;
}
