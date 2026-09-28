import { describe, expect, it } from "vitest";
import { analyzeExplainPlan } from "@/lib/diagram/explainPlanDiagnosis";
import type { ExplainPlanFinding } from "@/lib/diagram/explainPlanDiagnosis";

type PlanNode = Record<string, unknown>;

/** 把单个计划树根包装成 EXPLAIN (FORMAT JSON) 的顶层数组结构。 */
function wrap(root: PlanNode): unknown[] {
  return [{ Plan: root }];
}

function node(nodeType: string, extra: PlanNode = {}): PlanNode {
  return { "Node Type": nodeType, ...extra };
}

function codes(findings: ExplainPlanFinding[]): string[] {
  return findings.map((finding) => finding.code);
}

function find(findings: ExplainPlanFinding[], code: string): ExplainPlanFinding | undefined {
  return findings.find((finding) => finding.code === code);
}

describe("analyzeExplainPlan", () => {
  it("returns an empty list for empty or unusable input", () => {
    for (const raw of [undefined, null, "", "   ", [], {}, 42, "not-json"]) {
      expect(analyzeExplainPlan(raw), String(raw)).toEqual([]);
    }
  });

  it("accepts a JSON string and a bare (non-array) plan object", () => {
    const root = node("Seq Scan", { "Relation Name": "t1", "Plan Rows": 10, "Rows Removed by Filter": 200000 });
    expect(find(analyzeExplainPlan(JSON.stringify(wrap(root))), "seqScanHeavyFilter")).toBeTruthy();
    expect(find(analyzeExplainPlan({ Plan: root }), "seqScanHeavyFilter")).toBeTruthy();
  });

  describe("rule rowEstimateDeviation", () => {
    it("does not fire below 10x", () => {
      const findings = analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": 10, "Actual Rows": 99, "Actual Loops": 1 })));
      expect(codes(findings)).not.toContain("rowEstimateDeviation");
    });

    it("fires warning at exactly 10x", () => {
      const finding = find(analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": 10, "Actual Rows": 100, "Actual Loops": 1 }))), "rowEstimateDeviation");
      expect(finding?.severity).toBe("warning");
      expect(finding?.metrics.deviation).toBe(10);
    });

    it("fires critical at exactly 100x", () => {
      const finding = find(analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": 1, "Actual Rows": 100, "Actual Loops": 1 }))), "rowEstimateDeviation");
      expect(finding?.severity).toBe("critical");
      expect(finding?.metrics.deviation).toBe(100);
    });

    it("multiplies Actual Rows by Actual Loops", () => {
      const finding = find(analyzeExplainPlan(wrap(node("Index Scan", { "Plan Rows": 1, "Actual Rows": 5, "Actual Loops": 20 }))), "rowEstimateDeviation");
      expect(finding?.severity).toBe("critical");
      expect(finding?.metrics).toMatchObject({ planRows: 1, actualRows: 5, loops: 20, deviation: 100 });
    });

    it("also fires when the estimate is far too high", () => {
      const finding = find(analyzeExplainPlan(wrap(node("Index Scan", { "Plan Rows": 100000, "Actual Rows": 1, "Actual Loops": 1 }))), "rowEstimateDeviation");
      expect(finding?.severity).toBe("critical");
    });

    it("ignores nodes without both Plan Rows and Actual Rows", () => {
      expect(codes(analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": 1000 }))))).not.toContain("rowEstimateDeviation");
      expect(codes(analyzeExplainPlan(wrap(node("Seq Scan", { "Actual Rows": 1000 }))))).not.toContain("rowEstimateDeviation");
    });
  });

  describe("rule seqScanHeavyFilter", () => {
    it("fires critical with measured actuals and a 95%+ filter ratio", () => {
      const finding = find(analyzeExplainPlan(wrap(node("Seq Scan", { "Relation Name": "orders", "Plan Rows": 1000, "Rows Removed by Filter": 20000, "Actual Rows": 500, "Actual Loops": 1 }))), "seqScanHeavyFilter");
      expect(finding?.severity).toBe("critical");
      expect(finding?.relation).toBe("orders");
      expect(finding?.metrics.filterRatio).toBe(97.6);
    });

    it("does not fire when too many rows survive the filter", () => {
      expect(codes(analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": 2000, "Rows Removed by Filter": 10000, "Actual Rows": 1000, "Actual Loops": 1 }))))).not.toContain("seqScanHeavyFilter");
    });

    it("does not fire below 10000 removed rows", () => {
      expect(codes(analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": 1, "Rows Removed by Filter": 9999, "Actual Rows": 0, "Actual Loops": 1 }))))).not.toContain("seqScanHeavyFilter");
    });

    it("only applies to Seq Scan", () => {
      expect(codes(analyzeExplainPlan(wrap(node("Index Scan", { "Plan Rows": 1, "Rows Removed by Filter": 200000, "Actual Rows": 0, "Actual Loops": 1 }))))).not.toContain("seqScanHeavyFilter");
    });

    it("uses the conservative estimate branch for a plain EXPLAIN", () => {
      const finding = find(analyzeExplainPlan(wrap(node("Seq Scan", { "Relation Name": "big", "Plan Rows": 100, "Rows Removed by Filter": 200000 }))), "seqScanHeavyFilter");
      expect(finding?.severity).toBe("warning");
      expect(finding?.metrics).toMatchObject({ rowsRemoved: 200000, planRows: 100 });
    });

    it("requires >= 100000 removed rows and >= 99% in the estimate branch", () => {
      expect(codes(analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": 100, "Rows Removed by Filter": 50000 }))))).not.toContain("seqScanHeavyFilter");
      expect(codes(analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": 5000, "Rows Removed by Filter": 100000 }))))).not.toContain("seqScanHeavyFilter");
    });
  });

  describe("rule sortSpill", () => {
    it("fires on an external sort method", () => {
      const finding = find(analyzeExplainPlan(wrap(node("Sort", { "Plan Rows": 10, "Actual Rows": 10, "Actual Loops": 1, "Sort Method": "external merge  Disk: 40960kB" }))), "sortSpill");
      expect(finding?.severity).toBe("warning");
      expect(finding?.metrics.method).toContain("external merge");
    });

    it("fires when the sort space type is Disk even without a method", () => {
      const finding = find(analyzeExplainPlan(wrap(node("Sort", { "Plan Rows": 10, "Actual Rows": 10, "Actual Loops": 1, "Sort Space Type": "Disk" }))), "sortSpill");
      expect(finding?.severity).toBe("warning");
    });

    it("does not fire for in-memory quicksort", () => {
      expect(codes(analyzeExplainPlan(wrap(node("Sort", { "Plan Rows": 10, "Actual Rows": 10, "Actual Loops": 1, "Sort Method": "quicksort", "Sort Space Type": "Memory" }))))).not.toContain("sortSpill");
    });

    it("is skipped for a plain EXPLAIN without actual data", () => {
      expect(codes(analyzeExplainPlan(wrap(node("Sort", { "Plan Rows": 10, "Sort Method": "external merge  Disk: 40960kB" }))))).not.toContain("sortSpill");
    });
  });

  describe("rule hashSpill", () => {
    it("fires when batches > 1 and Peak Memory Usage is present", () => {
      const finding = find(analyzeExplainPlan(wrap(node("Hash", { "Plan Rows": 10, "Actual Rows": 10, "Actual Loops": 1, "Hash Batches": 8, "Peak Memory Usage": 2048 }))), "hashSpill");
      expect(finding?.severity).toBe("warning");
      expect(finding?.metrics).toMatchObject({ batches: 8, peakMemoryKb: 2048 });
    });

    it("loosely matches the openGauss 'Batches' key and Disk traces", () => {
      const finding = find(analyzeExplainPlan(wrap(node("Hash Join", { "Plan Rows": 10, "Actual Rows": 10, "Actual Loops": 1, Batches: 4, "Disk Usage": "512kB" }))), "hashSpill");
      expect(finding?.severity).toBe("warning");
      expect(finding?.metrics.batches).toBe(4);
    });

    it("does not fire for a single batch", () => {
      expect(codes(analyzeExplainPlan(wrap(node("Hash", { "Plan Rows": 10, "Actual Rows": 10, "Actual Loops": 1, "Hash Batches": 1, "Peak Memory Usage": 2048 }))))).not.toContain("hashSpill");
    });

    it("does not fire without a memory or disk trace", () => {
      expect(codes(analyzeExplainPlan(wrap(node("Hash", { "Plan Rows": 10, "Actual Rows": 10, "Actual Loops": 1, "Hash Batches": 8 }))))).not.toContain("hashSpill");
    });
  });

  describe("rule nestedLoopAmplification", () => {
    function nestedLoop(childLoops: number): PlanNode {
      return node("Nested Loop", {
        "Plan Rows": 10,
        "Actual Rows": 10,
        "Actual Loops": 1,
        Plans: [node("Index Scan", { "Actual Loops": childLoops })],
      });
    }

    it("fires info when a direct child loops 10000+ times", () => {
      const finding = find(analyzeExplainPlan(wrap(nestedLoop(10000))), "nestedLoopAmplification");
      expect(finding?.severity).toBe("info");
      expect(finding?.metrics.loops).toBe(10000);
    });

    it("does not fire below the threshold", () => {
      expect(codes(analyzeExplainPlan(wrap(nestedLoop(9999))))).not.toContain("nestedLoopAmplification");
    });

    it("only inspects direct children", () => {
      const root = node("Nested Loop", {
        "Plan Rows": 10,
        "Actual Rows": 10,
        "Actual Loops": 1,
        Plans: [node("Hash Join", { "Actual Loops": 1, Plans: [node("Seq Scan", { "Actual Loops": 50000 })] })],
      });
      expect(codes(analyzeExplainPlan(wrap(root)))).not.toContain("nestedLoopAmplification");
    });
  });

  describe("rule ioHeavy", () => {
    it("fires info when shared reads dominate shared hits", () => {
      const finding = find(analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": 10, "Actual Rows": 10, "Actual Loops": 1, "Shared Read Blocks": 20000, "Shared Hit Blocks": 100 }))), "ioHeavy");
      expect(finding?.severity).toBe("info");
      expect(finding?.metrics).toMatchObject({ sharedReadBlocks: 20000, sharedHitBlocks: 100 });
    });

    it("does not fire when reads are not larger than hits", () => {
      expect(codes(analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": 10, "Actual Rows": 10, "Actual Loops": 1, "Shared Read Blocks": 20000, "Shared Hit Blocks": 50000 }))))).not.toContain("ioHeavy");
    });

    it("does not fire at exactly 10000 reads", () => {
      expect(codes(analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": 10, "Actual Rows": 10, "Actual Loops": 1, "Shared Read Blocks": 10000, "Shared Hit Blocks": 0 }))))).not.toContain("ioHeavy");
    });
  });

  it("treats string numbers defensively", () => {
    const finding = find(analyzeExplainPlan(wrap(node("Seq Scan", { "Plan Rows": "10", "Actual Rows": "100", "Actual Loops": "1" }))), "rowEstimateDeviation");
    expect(finding?.severity).toBe("warning");
  });

  it("tolerates malformed nested nodes without throwing", () => {
    const root = node("Nested Loop", { Plans: [null, "x", 7, { "Node Type": 123 }] });
    expect(() => analyzeExplainPlan(wrap(root))).not.toThrow();
  });

  it("reports the same rule once per node but keeps separate nodes", () => {
    const root = node("Nested Loop", {
      Plans: [node("Seq Scan", { "Relation Name": "a", "Plan Rows": 1, "Rows Removed by Filter": 20000, "Actual Rows": 0, "Actual Loops": 1 }), node("Seq Scan", { "Relation Name": "b", "Plan Rows": 1, "Rows Removed by Filter": 20000, "Actual Rows": 0, "Actual Loops": 1 })],
    });
    const findings = analyzeExplainPlan(wrap(root)).filter((finding) => finding.code === "seqScanHeavyFilter");
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.relation)).toEqual(["a", "b"]);
  });

  it("sorts findings critical > warning > info and keeps discovery order inside a severity", () => {
    const root = node("Nested Loop", {
      "Plan Rows": 1,
      "Actual Rows": 100,
      "Actual Loops": 1,
      "Shared Read Blocks": 20000,
      "Shared Hit Blocks": 1,
      "Sort Method": "external merge  Disk: 40960kB",
      "Hash Batches": 8,
      "Peak Memory Usage": 2048,
      Plans: [node("Index Scan", { "Actual Loops": 20000 })],
    });
    const findings = analyzeExplainPlan(wrap(root));
    expect(findings.map((finding) => finding.severity)).toEqual(["critical", "warning", "warning", "info", "info"]);
    expect(findings[0].code).toBe("rowEstimateDeviation");
    expect(findings[1].code).toBe("sortSpill");
    expect(findings[2].code).toBe("hashSpill");
    expect(findings[3].code).toBe("nestedLoopAmplification");
    expect(findings[4].code).toBe("ioHeavy");
  });

  it("skips every rule that needs actual data for a plain EXPLAIN", () => {
    const root = node("Nested Loop", {
      "Plan Rows": 100000,
      "Shared Read Blocks": 50000,
      "Shared Hit Blocks": 1,
      "Sort Method": "external merge  Disk: 40960kB",
      "Hash Batches": 8,
      "Peak Memory Usage": 2048,
      Plans: [node("Seq Scan", { "Plan Rows": 1 })],
    });
    expect(codes(analyzeExplainPlan(wrap(root)))).toEqual([]);
  });
});
