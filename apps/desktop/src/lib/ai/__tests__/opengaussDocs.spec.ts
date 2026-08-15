import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatOpengaussDocHits, resetOpengaussDocsIndex, searchOpengaussDocs, tokenizeDocQuery, type OpengaussKb } from "@/lib/ai/opengaussDocs";

const fakeKb: OpengaussKb = {
  version: 1,
  count: 3,
  slices: [
    { t: "SQL语法参考 · CREATE TABLE", h: "分区表", k: ["分区表", "create", "table", "range", "partition"], c: "CREATE TABLE 支持 RANGE/LIST/HASH/INTERVAL 分区。使用 PARTITION BY RANGE (time) 创建范围分区表，每个分区可以单独管理。分区裁剪可以显著提升查询性能。" },
    { t: "SQL语法参考 · CREATE INDEX", h: "索引", k: ["索引", "create", "index", "btree"], c: "CREATE INDEX 在 openGauss 中默认创建 B-tree 索引。支持表达式索引、部分索引。索引可以加速查询，但会降低写入性能。" },
    { t: "开发者指南 · PL/pgSQL", h: "存储过程", k: ["存储过程", "plpgsql", "procedure", "begin"], c: "使用 CREATE OR REPLACE PROCEDURE 创建存储过程，BEGIN...END 定义过程体，支持 %TYPE 变量声明和异常处理。" },
  ],
};

describe("opengauss docs knowledge base", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => fakeKb }) as unknown as Response),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetOpengaussDocsIndex();
  });

  it("tokenizes mixed Chinese/English queries", () => {
    const { words, bigrams } = tokenizeDocQuery("如何创建分区表 partition");
    expect(words).toContain("partition");
    expect(bigrams).toContain("分区");
    expect(bigrams).toContain("建分");
  });

  it("finds the most relevant slice for a Chinese query", async () => {
    const hits = await searchOpengaussDocs("如何创建范围分区表");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].heading).toContain("分区表");
    expect(hits[0].content).toContain("RANGE");
  });

  it("finds procedure docs for PL/SQL questions", async () => {
    const hits = await searchOpengaussDocs("创建存储过程");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].heading).toContain("存储过程");
  });

  it("returns no hits for empty or irrelevant queries", async () => {
    expect(await searchOpengaussDocs("")).toEqual([]);
    expect(await searchOpengaussDocs("   ")).toEqual([]);
  });

  it("formats hits for system prompt injection", () => {
    const text = formatOpengaussDocHits([{ title: "SQL语法参考 · CREATE TABLE", heading: "分区表", content: "PARTITION BY RANGE", score: 10 }]);
    expect(text).toContain("openGauss");
    expect(text).toContain("CREATE TABLE");
    expect(text).toContain("PARTITION BY RANGE");
  });

  it("formats empty hits as empty string", () => {
    expect(formatOpengaussDocHits([])).toBe("");
  });
});
