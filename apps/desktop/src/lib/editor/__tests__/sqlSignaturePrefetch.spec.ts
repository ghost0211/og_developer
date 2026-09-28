import { describe, expect, it, vi } from "vitest";
import { createSqlSignaturePrefetcher, splitSignatureCallName } from "@/lib/editor/sqlSignaturePrefetch";
import type { SqlCompletionObject } from "@/lib/sql/sqlCompletion";

function fn(name: string, schema = "public"): SqlCompletionObject {
  return { name, schema, type: "function", signature: "a integer" };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("splitSignatureCallName", () => {
  it("裸函数名无 schema", () => {
    expect(splitSignatureCallName("count")).toEqual({ schema: undefined, name: "count" });
  });

  it("schema 限定名拆出 schema", () => {
    expect(splitSignatureCallName("public.gen_random_uuid")).toEqual({ schema: "public", name: "gen_random_uuid" });
  });

  it("引号限定符保留原始大小写", () => {
    expect(splitSignatureCallName('"App"."MyFn"')).toEqual({ schema: "App", name: "MyFn" });
  });

  it("空输入返回空名", () => {
    expect(splitSignatureCallName("")).toEqual({ name: "" });
  });
});

describe("createSqlSignaturePrefetcher", () => {
  it("拉取成功时回调合并对象", async () => {
    const fetch = vi.fn().mockResolvedValue([fn("gen_random_uuid")]);
    const onObjects = vi.fn();
    const prefetcher = createSqlSignaturePrefetcher({ fetch, onObjects });
    prefetcher.maybePrefetch("public.gen_random_uuid");
    await flush();
    expect(fetch).toHaveBeenCalledWith("public", "gen_random_uuid");
    expect(onObjects).toHaveBeenCalledTimes(1);
  });

  it("相同函数在途中不重复拉取", async () => {
    let resolveFetch!: (value: SqlCompletionObject[]) => void;
    const fetch = vi.fn().mockImplementation(() => new Promise<SqlCompletionObject[]>((resolve) => (resolveFetch = resolve)));
    const prefetcher = createSqlSignaturePrefetcher({ fetch, onObjects: vi.fn() });
    prefetcher.maybePrefetch("count_by_code");
    prefetcher.maybePrefetch("public.count_by_code"); // schema 不同 key 不同？—— 带限定与不带限定是两个 key
    prefetcher.maybePrefetch("count_by_code");
    expect(fetch).toHaveBeenCalledTimes(2); // 两个不同 key 各一次，重复的不发
    resolveFetch([]);
    await flush();
  });

  it("未命中结果在冷却期内不重查", async () => {
    let now = 1000;
    const fetch = vi.fn().mockResolvedValue([]);
    const prefetcher = createSqlSignaturePrefetcher({ fetch, onObjects: vi.fn(), now: () => now, missTtlMs: 60_000 });
    prefetcher.maybePrefetch("no_such_fn");
    await flush();
    prefetcher.maybePrefetch("no_such_fn");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 61_000;
    prefetcher.maybePrefetch("no_such_fn");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("拉取失败静默且走负缓存", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("boom"));
    const prefetcher = createSqlSignaturePrefetcher({ fetch, onObjects: vi.fn() });
    prefetcher.maybePrefetch("bad_fn");
    await flush();
    prefetcher.maybePrefetch("bad_fn");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("命中后使用更长的冷却期", async () => {
    let now = 0;
    const fetch = vi.fn().mockResolvedValue([fn("gen_random_uuid")]);
    const prefetcher = createSqlSignaturePrefetcher({ fetch, onObjects: vi.fn(), now: () => now, hitTtlMs: 600_000, missTtlMs: 60_000 });
    prefetcher.maybePrefetch("gen_random_uuid");
    await flush();
    now += 61_000; // 超过 miss TTL 但未超过 hit TTL
    prefetcher.maybePrefetch("gen_random_uuid");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 600_000; // 超过 hit TTL
    prefetcher.maybePrefetch("gen_random_uuid");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
