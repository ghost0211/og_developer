import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SqlCompletionObject } from "@/lib/sql/sqlCompletion";

/**
 * 签名提示的按需预取器。
 *
 * 编辑器里的函数参数提示（Signature Help）只读本地补全对象缓存；缓存冷的时候
 * （刚打开编辑器、还没触发过对应 schema 的补全）用户函数不弹提示。预取器在检测
 * 到光标进入函数调用、且缓存无匹配时，异步去库里拉取该函数的参数签名并回调合并。
 *
 * 带去重与负缓存：同一函数的查询在途中不重复发；查询结束（无论命中与否）后
 * 一段时间内不再重查，避免对拼写中/不存在的函数反复打库。
 */

export interface SqlSignaturePrefetcherOptions {
  /** 按（可选 schema，函数名）拉取签名对象；实现方负责数据库访问与错误处理外的抛出 */
  fetch: (schema: string | undefined, name: string) => Promise<SqlCompletionObject[]>;
  /** 拉取到非空结果时回调（由调用方合并进补全缓存并刷新提示） */
  onObjects: (objects: SqlCompletionObject[]) => void;
  now?: () => number;
  /** 命中结果后的冷却时间（默认 10 分钟；函数重定义不频繁） */
  hitTtlMs?: number;
  /** 未命中/失败后的冷却时间（默认 60 秒） */
  missTtlMs?: number;
}

export interface SqlSignaturePrefetcher {
  maybePrefetch(rawCallName: string): void;
  /**
   * 销毁预取器。
   * 阻止后续新预取，丢弃正在进行中请求的异步结果（不触发回调、不登记缓存）。
   * 幂等安全。
   */
  dispose(): void;
}

/** 把可能带限定的调用名拆成 { schema, name }；支持引号限定符。 */
export function splitSignatureCallName(rawName: string): { schema?: string; name: string } {
  const tokens = tokenizeSqlSemantic(rawName, "postgres").filter((token) => token.kind === "word" || token.kind === "quoted_identifier");
  if (tokens.length === 0) return { name: "" };
  const unquote = (token: (typeof tokens)[number]) => (token.kind === "quoted_identifier" ? token.text.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`") : token.text);
  const name = unquote(tokens[tokens.length - 1]);
  // 三段及以上（如 pkg.fn 被按 schema.fn 处理）——取倒数第二段作为查询 schema；
  // 查不到属于正常情况（包内函数不在 pg_proc 顶层），会走负缓存。
  const schema = tokens.length >= 2 ? unquote(tokens[tokens.length - 2]) : undefined;
  return { schema, name };
}

export function createSqlSignaturePrefetcher(options: SqlSignaturePrefetcherOptions): SqlSignaturePrefetcher {
  const now = options.now ?? (() => Date.now());
  const hitTtl = options.hitTtlMs ?? 10 * 60_000;
  const missTtl = options.missTtlMs ?? 60_000;
  let disposed = false;
  const inflight = new Set<string>();
  const settledAt = new Map<string, number>();
  const hitKeys = new Set<string>();

  return {
    maybePrefetch(rawCallName: string) {
      if (disposed) return;
      const { schema, name } = splitSignatureCallName(rawCallName);
      if (!name.trim()) return;
      const key = `${(schema ?? "").toLowerCase()}.${name.toLowerCase()}`;
      if (inflight.has(key)) return;
      const last = settledAt.get(key);
      if (last !== undefined && now() - last < missTtl) return;
      // 命中冷却单独判断：settledAt 只记时间，命中与否用更长的 TTL 通过 hitKeys 区分
      if (last !== undefined && hitKeys.has(key) && now() - last < hitTtl) return;
      inflight.add(key);
      try {
        void options
          .fetch(schema, name)
          .then((objects) => {
            if (disposed) return;
            if (objects.length > 0) {
              hitKeys.add(key);
              options.onObjects(objects);
            } else {
              hitKeys.delete(key);
            }
          })
          .catch(() => {
            if (disposed) return;
            hitKeys.delete(key);
          })
          .finally(() => {
            if (disposed) return;
            inflight.delete(key);
            settledAt.set(key, now());
          });
      } catch {
        if (!disposed) {
          inflight.delete(key);
          settledAt.set(key, now());
        }
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      inflight.clear();
      settledAt.clear();
      hitKeys.clear();
    },
  };
}
