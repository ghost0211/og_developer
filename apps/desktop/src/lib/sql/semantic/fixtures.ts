import type { SqlSemanticCompletionScopeKind } from "@/lib/sql/semantic/completion";
import type { SqlSemanticConfidence, SqlSemanticCursorKind, SqlSemanticStatementKind } from "@/lib/sql/semantic/types";

export interface SqlSemanticFixture {
  name: string;
  sql: string;
  databaseType?: "postgres";
  expected: {
    statementKind: SqlSemanticStatementKind;
    cursorKind: SqlSemanticCursorKind;
    completionScope: SqlSemanticCompletionScopeKind;
    prefix: string;
    qualifierParts?: string[];
    confidence: SqlSemanticConfidence;
    rowSources?: Array<{ name: string; alias?: string; kind?: string; columns?: string[] }>;
    completionLabels?: string[];
  };
}

export function sqlFixtureCursor(input: string): { sql: string; cursor: number } {
  const cursor = input.indexOf("|");
  if (cursor < 0) {
    throw new Error("SQL semantic fixture is missing a | cursor marker");
  }
  return {
    sql: input.slice(0, cursor) + input.slice(cursor + 1),
    cursor,
  };
}

export const SQL_SEMANTIC_BASELINE_FIXTURES: SqlSemanticFixture[] = [
  {
    name: "select alias column",
    sql: "SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE u.|",
    expected: {
      statementKind: "select",
      cursorKind: "alias_column",
      completionScope: "columns",
      prefix: "",
      qualifierParts: ["u"],
      confidence: "high",
      rowSources: [
        { name: "users", alias: "u", kind: "table" },
        { name: "orders", alias: "o", kind: "table" },
      ],
    },
  },
  {
    name: "with cte table source",
    sql: "WITH recent_orders(id, total) AS (SELECT id, total FROM orders) SELECT * FROM recent_orders ro WHERE ro.|",
    expected: {
      statementKind: "select",
      cursorKind: "alias_column",
      completionScope: "columns",
      prefix: "",
      qualifierParts: ["ro"],
      confidence: "high",
      rowSources: [{ name: "recent_orders", alias: "ro", kind: "cte", columns: ["id", "total"] }],
      completionLabels: ["id", "total"],
    },
  },
  {
    name: "subquery projection columns",
    sql: "SELECT * FROM (SELECT id, name AS user_name FROM users) sq WHERE sq.|",
    expected: {
      statementKind: "select",
      cursorKind: "alias_column",
      completionScope: "columns",
      prefix: "",
      qualifierParts: ["sq"],
      confidence: "high",
      rowSources: [{ name: "sq", alias: "sq", kind: "subquery", columns: ["id", "user_name"] }],
      completionLabels: ["id", "user_name"],
    },
  },
  {
    name: "call routine",
    sql: "CALL app.refresh_|",
    databaseType: "postgres",
    expected: {
      statementKind: "call",
      cursorKind: "routine",
      completionScope: "routine",
      prefix: "refresh_",
      qualifierParts: ["app"],
      confidence: "high",
    },
  },
  {
    name: "delete target",
    sql: "DELETE FROM audit_events ae WHERE ae.|",
    expected: {
      statementKind: "delete",
      cursorKind: "alias_column",
      completionScope: "columns",
      prefix: "",
      qualifierParts: ["ae"],
      confidence: "high",
      rowSources: [{ name: "audit_events", alias: "ae", kind: "mutation_target" }],
    },
  },
  {
    name: "schema qualified table",
    sql: "SELECT * FROM reporting.|",
    databaseType: "postgres",
    expected: {
      statementKind: "select",
      cursorKind: "table",
      completionScope: "table",
      prefix: "",
      qualifierParts: ["reporting"],
      confidence: "medium",
    },
  },
  {
    name: "comment suppressed",
    sql: "SELECT * FROM users -- u.|",
    expected: {
      statementKind: "select",
      cursorKind: "suppressed",
      completionScope: "local",
      prefix: "",
      confidence: "high",
    },
  },
];
