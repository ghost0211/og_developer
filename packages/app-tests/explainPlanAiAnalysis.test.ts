import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildExplainPlanAiPrompt } from "../../apps/desktop/src/lib/diagram/explainPlanAiAnalysis.ts";
import type { ParsedExplainPlan } from "../../apps/desktop/src/lib/diagram/explainPlan.ts";

const plan: ParsedExplainPlan = {
  databaseType: "opengauss",
  raw: [{ Plan: { "Node Type": "Seq Scan", "Relation Name": "orders", "Plan Rows": 5000, Filter: "status = 'open'" } }],
  nodes: [
    {
      id: "0",
      title: "Seq Scan on orders",
      nodeType: "Seq Scan",
      relation: "orders",
      rows: "5000",
      details: ["Filter: status = 'open'"],
      children: [],
    },
  ],
};

const sql = "\nSELECT *\nFROM orders\nWHERE status = 'open';\n";

test("buildExplainPlanAiPrompt carries original SQL, parsed tree, raw plan, and diagnoses", () => {
  const prompt = buildExplainPlanAiPrompt({
    sourceSql: sql,
    plan,
    connection: {
      name: "Reporting DB",
      databaseType: "postgres",
      host: "db.internal",
      port: 5432,
      database: "sales",
      schema: "public",
      productName: "openGauss",
      productVersion: "5.0",
      sqlCompatibility: "PG",
    },
    diagnoses: [
      {
        severity: "warning",
        code: "seqScanHeavyFilter",
        nodeType: "Seq Scan",
        relation: "orders",
        metrics: { rowsRemoved: 120000, filterRatio: 99.2 },
        summary: "The sequential scan filtered most rows.",
        suggestion: "Review filter-column indexing.",
      },
    ],
  });

  assert.ok(prompt.includes(`Original SQL (exact source SQL associated with this plan):\n\`\`\`sql\n${sql}\n\`\`\``));
  assert.match(prompt, /Database dialect \(plan parser\):\nopengauss/);
  assert.match(prompt, /Connection: Reporting DB/);
  assert.match(prompt, /Configured database type: postgres/);
  assert.match(prompt, /Host: db\.internal:5432/);
  assert.match(prompt, /SQL compatibility mode: PG/);
  assert.match(prompt, /Seq Scan on orders/);
  assert.match(prompt, /"Node Type": "Seq Scan"/);
  assert.match(prompt, /WARNING \[seqScanHeavyFilter\] node=Seq Scan; relation=orders/);
  assert.match(prompt, /The sequential scan filtered most rows\./);
  assert.match(prompt, /Review filter-column indexing\./);
});

test("buildExplainPlanAiPrompt explicitly makes analysis static and excludes credentials", () => {
  const prompt = buildExplainPlanAiPrompt({
    sourceSql: "SELECT 1",
    plan,
    connection: {
      name: "Secret profile",
      databaseType: "opengauss",
      host: "localhost",
      port: 5432,
    },
    diagnoses: [],
  });

  assert.match(prompt, /Do not connect to a database, call tools, run SQL, execute EXPLAIN\/EXPLAIN ANALYZE, or execute any SQL you suggest/);
  assert.match(prompt, /credentials intentionally excluded/);
  assert.match(prompt, /No built-in rule diagnosis matched this plan/);
  assert.doesNotMatch(prompt, /password|secret-value/i);
});
