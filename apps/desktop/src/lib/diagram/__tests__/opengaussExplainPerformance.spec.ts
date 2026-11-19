import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { buildExplainSql, flattenExplainPlanNodes, parseExplainResult } from "@/lib/diagram/explainPlan";
import { buildPlanCanvas, extractActualRows } from "@/lib/diagram/planCanvas";
import { buildOpenGaussIndexAdviseSql, classifyOpenGaussIndexAdviseError, isOpenGaussExplainPerformanceText, parseOpenGaussExplainPerformanceText, parseOpenGaussIndexAdviseResult } from "@/lib/diagram/opengaussExplainPerformance";
import type { QueryResult } from "@/types/database";

const SAMPLE_PERFORMANCE_PLAN = [
  " id |                   operation                    |    A-time     | A-rows | E-rows | Peak Memory | E-memory | A-width | E-width | E-distinct |   E-costs",
  "----+------------------------------------------------+---------------+--------+--------+-------------+----------+---------+---------+------------+-------------",
  "  1 | ->  Row Adapter                                | 46.120        |     10 |     10 | 16KB        |          |         |     100 | -          | 100.00..110.00",
  "  2 |    ->  Vector Streaming (type: GATHER)         | 45.800        |     10 |     10 | 24KB        |          |         |     100 |            | 95.00..105.00",
  "  3 |       ->  Limit                                | [0.012, 1.23] |     10 |     10 | -           | 1MB      |         |      64 | 10         | 0.29..50.12",
  "  4 |          ->  Hash Join                         | 12.345        |    200 |     50 | 128KB       | 1MB      |      64 |      64 |            | 10.00..45.00",
  "  5 |             ->  Seq Scan on public.orders o    | [0.01, 8.45]  |  10000 |   5000 | 32KB        | 1MB      |         |      64 | 2500       | 0.00..30.00",
  "  6 |             ->  Hash                           | 2.110         |    0/0 |     50 | 64KB        | 1MB      |         |      32 | -          | 1.00..8.50",
  "  7 |                ->  Index Scan using idx_cust_id on customers c | 1.900 | 50 | 50 | 16KB | 1MB |     |      32 |            | 0.00..7.50",
  "",
  " Predicate Information (identified by plan id):",
  " ----------------------------------------------",
  "   4 --Hash Cond: (o.customer_id = c.id)",
  "   --   5 - Filter: (o.status = 'paid'::text)",
  "   7 --Index Cond: (c.active = true)",
  "",
  " Memory Information (identified by plan id):",
  " -------------------------------------------",
  "   --   4 - Hash Buckets: 1024  Batches: 1  Memory Usage: 64kB",
  "   6 --Buckets: 1024  Memory Usage: 32kB",
  "",
  " Total runtime: 46.789 ms",
].join("\n");

describe("isOpenGaussExplainPerformanceText", () => {
  it("detects pipe-delimited openGauss EXPLAIN PERFORMANCE output", () => {
    expect(isOpenGaussExplainPerformanceText(SAMPLE_PERFORMANCE_PLAN)).toBe(true);
    expect(isOpenGaussExplainPerformanceText(" id | operation | E-costs\n----+-----------+--------\n 1 | Seq Scan on t | 0..1")).toBe(true);
  });

  it("rejects JSON plans, empty strings, and unrelated text", () => {
    expect(isOpenGaussExplainPerformanceText("")).toBe(false);
    expect(isOpenGaussExplainPerformanceText('[{"Plan": {"Node Type": "Seq Scan"}}]')).toBe(false);
    expect(isOpenGaussExplainPerformanceText("col1 | col2\n1 | 2")).toBe(false);
  });
});

describe("parseOpenGaussExplainPerformanceText", () => {
  const parsed = parseOpenGaussExplainPerformanceText(SAMPLE_PERFORMANCE_PLAN);

  it("reconstructs the nested operator tree and node metadata", () => {
    expect(parsed.nodes).toHaveLength(1);
    const root = parsed.nodes[0];
    expect(root.id).toBe("1");
    expect(root.nodeType).toBe("Row Adapter");
    expect(root.cost).toBe("100.00..110.00");
    expect(root.rows).toBe("10");
    expect(root.width).toBe("100");

    const streaming = root.children[0];
    expect(streaming.nodeType).toBe("Vector Streaming (type: GATHER)");
    const limit = streaming.children[0];
    expect(limit.nodeType).toBe("Limit");
    const hashJoin = limit.children[0];
    expect(hashJoin.nodeType).toBe("Hash Join");
    expect(hashJoin.children).toHaveLength(2);

    const seqScan = hashJoin.children[0];
    expect(seqScan.nodeType).toBe("Seq Scan");
    expect(seqScan.relation).toBe("public.orders");
    expect(seqScan.title).toBe("Seq Scan on public.orders o");

    const hash = hashJoin.children[1];
    expect(hash.nodeType).toBe("Hash");
    const indexScan = hash.children[0];
    expect(indexScan.nodeType).toBe("Index Scan");
    expect(indexScan.index).toBe("idx_cust_id");
    expect(indexScan.relation).toBe("customers");
  });

  it("formats runtime details cleanly for planCanvas and ExplainPlanViewer", () => {
    const flat = flattenExplainPlanNodes(parsed.nodes);
    const byId = new Map(flat.map((node) => [node.id, node]));

    const root = byId.get("1")!;
    expect(root.details).toContain("Actual Rows: 10");
    expect(root.details).toContain("Actual Time: 46.120 ms");
    expect(root.details).toContain("Peak Memory: 16KB");
    expect(root.details).toContain("Execution Time: 46.789 ms");
    expect(root.details.some((d) => d.startsWith("Distinct:"))).toBe(false);

    const limit = byId.get("3")!;
    expect(limit.details).toContain("Actual Time: 0.012..1.23 ms");
    expect(limit.details).toContain("Distinct: 10");
    expect(limit.details.some((d) => d.startsWith("Peak Memory:"))).toBe(false);

    const seqScan = byId.get("5")!;
    expect(extractActualRows(seqScan)).toBe(10000);
    expect(seqScan.details).toContain("Actual Time: 0.01..8.45 ms");
    expect(seqScan.details).toContain("Distinct: 2500");

    // 0/0 in A-rows should be ignored rather than producing broken numeric details.
    const hash = byId.get("6")!;
    expect(extractActualRows(hash)).toBeUndefined();

    // Verify compatibility with planCanvas layout.
    const canvas = buildPlanCanvas(parsed.nodes);
    expect(canvas.nodes).toHaveLength(7);
    expect(canvas.edges).toHaveLength(6);
  });

  it("attaches Predicate Information and Memory Information lines by plan id", () => {
    const flat = flattenExplainPlanNodes(parsed.nodes);
    const byId = new Map(flat.map((node) => [node.id, node]));

    expect(byId.get("4")!.details).toContain("Hash Cond: (o.customer_id = c.id)");
    expect(byId.get("4")!.details).toContain("Hash Buckets: 1024  Batches: 1  Memory Usage: 64kB");
    expect(byId.get("5")!.details).toContain("Filter: (o.status = 'paid'::text)");
    expect(byId.get("6")!.details).toContain("Buckets: 1024  Memory Usage: 32kB");
    expect(byId.get("7")!.details).toContain("Index Cond: (c.active = true)");
  });

  it("extracts totalRuntimeMs and builds tableResult from all operator rows", () => {
    expect(parsed.summaryMetrics.totalRuntimeMs).toBe(46.789);
    expect(parsed.tableResult).toBeDefined();
    expect(parsed.tableResult!.columns).toEqual(["id", "operation", "A-time", "A-rows", "E-rows", "Peak Memory", "E-memory", "A-width", "E-width", "E-distinct", "E-costs"]);
    expect(parsed.tableResult!.rows).toHaveLength(7);
    expect(parsed.tableResult!.affected_rows).toBe(0);
    expect(parsed.tableResult!.execution_time_ms).toBe(46.789);
  });
});

describe("explainPlan integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses multi-row EXPLAIN PERFORMANCE results in parseExplainResult", () => {
    const lines = SAMPLE_PERFORMANCE_PLAN.split("\n");
    const multiRowResult: QueryResult = {
      columns: ["QUERY PLAN"],
      rows: lines.map((line) => [line]),
      affected_rows: 0,
      execution_time_ms: 47,
    };

    const parsed = parseExplainResult("opengauss", multiRowResult);
    expect(parsed.databaseType).toBe("opengauss");
    expect(typeof parsed.raw).toBe("string");
    expect(flattenExplainPlanNodes(parsed.nodes)).toHaveLength(7);
  });

  it("forwards buildExplainSql options without leaking undefined extra keys", async () => {
    const spy = vi.spyOn(api, "buildExplainSql").mockResolvedValue({ ok: true, sql: "EXPLAIN (FORMAT JSON) SELECT 1" });

    await buildExplainSql("opengauss", "SELECT 1");
    expect(spy).toHaveBeenLastCalledWith({ databaseType: "opengauss", sql: "SELECT 1", format: "json", analyze: undefined });

    await buildExplainSql("opengauss", "SELECT 1", "json", undefined, { performance: true, sandbox: true });
    expect(spy).toHaveBeenLastCalledWith({ databaseType: "opengauss", sql: "SELECT 1", format: "json", analyze: undefined, performance: true, sandbox: true });
  });
});

describe("openGauss gs_index_advise helpers", () => {
  it("builds SQL safely by trimming semicolons and escaping single quotes", () => {
    expect(buildOpenGaussIndexAdviseSql("  SELECT * FROM orders WHERE status = 'paid'; ; ")).toBe("SELECT * FROM gs_index_advise('SELECT * FROM orders WHERE status = ''paid''')");
  });

  it("parses recommendations, filters invalid rows, and generates deterministic quoted DDL", () => {
    const result: QueryResult = {
      columns: ["SCHEMA", "Table", "Column", "IndexType"],
      rows: [
        ["public", "orders", "(customer_id, created_at)", "btree"],
        ['"Sales"', '"OrderItems"', '"OrderId"', null],
        [null, "analytics.events", "user_id", "local"],
        ["public", "empty_cols", "(null)", null],
        ["public", "whitespace_cols", "   ", "btree"],
        ["public", "null_cols", null, null],
      ],
      affected_rows: 0,
      execution_time_ms: 5,
    };

    const advices = parseOpenGaussIndexAdviseResult(result);
    expect(advices).toHaveLength(3);

    expect(advices[0]).toEqual({
      schema: "public",
      table: "orders",
      columns: ["customer_id", "created_at"],
      indexType: "btree",
      indexName: "idx_orders_customer_id_created_at",
      createSql: 'CREATE INDEX "idx_orders_customer_id_created_at" ON "public"."orders" ("customer_id", "created_at");',
      createConcurrentSql: 'CREATE INDEX CONCURRENTLY "idx_orders_customer_id_created_at" ON "public"."orders" ("customer_id", "created_at");',
    });

    expect(advices[1]).toEqual({
      schema: "Sales",
      table: "OrderItems",
      columns: ["OrderId"],
      indexName: "idx_orderitems_orderid",
      createSql: 'CREATE INDEX "idx_orderitems_orderid" ON "Sales"."OrderItems" ("OrderId");',
      createConcurrentSql: 'CREATE INDEX CONCURRENTLY "idx_orderitems_orderid" ON "Sales"."OrderItems" ("OrderId");',
    });

    expect(advices[2]).toEqual({
      schema: "analytics",
      table: "events",
      columns: ["user_id"],
      indexType: "local",
      indexName: "idx_events_user_id",
      createSql: 'CREATE INDEX "idx_events_user_id" ON "analytics"."events" ("user_id");',
      createConcurrentSql: 'CREATE INDEX CONCURRENTLY "idx_events_user_id" ON "analytics"."events" ("user_id");',
    });
  });

  it("supports alias headers (nspname/relname/attname) and omits schema prefix when absent", () => {
    const result: QueryResult = {
      columns: ["nspname", "relname", "attname"],
      rows: [["", "users", "email"]],
      affected_rows: 0,
      execution_time_ms: 2,
    };

    const advices = parseOpenGaussIndexAdviseResult(result);
    expect(advices).toHaveLength(1);
    expect(advices[0].createSql).toBe('CREATE INDEX "idx_users_email" ON "users" ("email");');
  });

  it("classifies gs_index_advise errors accurately", () => {
    expect(classifyOpenGaussIndexAdviseError("ERROR: function gs_index_advise(unknown) does not exist")).toBe("unsupported");
    expect(classifyOpenGaussIndexAdviseError("gs_index_advise is not supported in this version")).toBe("unsupported");
    expect(classifyOpenGaussIndexAdviseError("ERROR: permission denied for function gs_index_advise")).toBe("permission");
    expect(classifyOpenGaussIndexAdviseError("ERROR: must be system admin to call gs_index_advise")).toBe("permission");
    expect(classifyOpenGaussIndexAdviseError('ERROR: syntax error at or near "FROM"')).toBe("invalid_sql");
    expect(classifyOpenGaussIndexAdviseError('ERROR: relation "missing_table" does not exist')).toBe("invalid_sql");
    expect(classifyOpenGaussIndexAdviseError("Connection timed out")).toBe("other");
  });
});
