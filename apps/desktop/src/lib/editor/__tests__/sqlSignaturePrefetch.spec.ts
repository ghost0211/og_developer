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

  describe("dispose", () => {
    it("dispose 前挂起的请求迟到成功时，不调用 onObjects 且不登记缓存", async () => {
      let resolveFetch!: (value: SqlCompletionObject[]) => void;
      const fetch = vi.fn().mockImplementation(() => new Promise<SqlCompletionObject[]>((resolve) => (resolveFetch = resolve)));
      const onObjects = vi.fn();
      const prefetcher = createSqlSignaturePrefetcher({ fetch, onObjects });

      prefetcher.maybePrefetch("slow_fn");
      expect(fetch).toHaveBeenCalledTimes(1);

      // 在请求还在途中时销毁预取器
      prefetcher.dispose();

      // 请求迟到成功返回
      resolveFetch([fn("slow_fn")]);
      await flush();

      // 不应调用回调
      expect(onObjects).not.toHaveBeenCalled();
    });

    it("dispose 前挂起的请求迟到失败时，被内部捕获且不抛出 unhandled rejection", async () => {
      let rejectFetch!: (reason: unknown) => void;
      const fetch = vi.fn().mockImplementation(() => new Promise<SqlCompletionObject[]>((_, reject) => (rejectFetch = reject)));
      const onObjects = vi.fn();
      const prefetcher = createSqlSignaturePrefetcher({ fetch, onObjects });

      prefetcher.maybePrefetch("failing_fn");
      expect(fetch).toHaveBeenCalledTimes(1);

      prefetcher.dispose();

      // 迟到失败
      rejectFetch(new Error("network error after dispose"));
      await flush();

      expect(onObjects).not.toHaveBeenCalled();
    });

    it("销毁后拒绝新的预取请求", async () => {
      const fetch = vi.fn().mockResolvedValue([fn("any_fn")]);
      const onObjects = vi.fn();
      const prefetcher = createSqlSignaturePrefetcher({ fetch, onObjects });

      prefetcher.dispose();

      prefetcher.maybePrefetch("any_fn");
      await flush();

      expect(fetch).not.toHaveBeenCalled();
      expect(onObjects).not.toHaveBeenCalled();
    });

    it("dispose 具备幂等性，多次调用无害", async () => {
      const fetch = vi.fn().mockResolvedValue([fn("any_fn")]);
      const prefetcher = createSqlSignaturePrefetcher({ fetch, onObjects: vi.fn() });

      prefetcher.dispose();
      prefetcher.dispose();
      prefetcher.dispose();

      prefetcher.maybePrefetch("any_fn");
      await flush();

      expect(fetch).not.toHaveBeenCalled();
    });

    it("旧 fetcher 销毁后，新创建的 fetcher 允许再次请求同一函数", async () => {
      let resolveFirst!: (value: SqlCompletionObject[]) => void;
      const fetch = vi.fn().mockImplementationOnce(() => new Promise<SqlCompletionObject[]>((resolve) => (resolveFirst = resolve)));
      const onObjects = vi.fn();

      const oldPrefetcher = createSqlSignaturePrefetcher({ fetch, onObjects });
      oldPrefetcher.maybePrefetch("reused_fn");
      expect(fetch).toHaveBeenCalledTimes(1);

      // 旧的销毁
      oldPrefetcher.dispose();
      resolveFirst([fn("reused_fn")]);
      await flush();
      expect(onObjects).not.toHaveBeenCalled();

      // 新 fetcher 重新接入并请求同一函数
      fetch.mockResolvedValueOnce([fn("reused_fn")]);
      const newPrefetcher = createSqlSignaturePrefetcher({ fetch, onObjects });
      newPrefetcher.maybePrefetch("reused_fn");
      await flush();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(onObjects).toHaveBeenCalledTimes(1);
      expect(onObjects).toHaveBeenCalledWith([fn("reused_fn")]);
    });
  });
});
