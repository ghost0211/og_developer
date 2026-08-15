import { defineStore } from "pinia";
import { ref } from "vue";
import * as api from "@/lib/backend/api";
import type { PromptTemplate } from "@/types/promptTemplate";

/**
 * Built-in openGauss prompt templates. They are merged into the store on load
 * (read-only seeds, not persisted to the backend) so every user starts with
 * openGauss-specific conventions for DDL, PL/SQL, performance tuning and
 * Oracle migration. Users can delete them locally (session-only) and create
 * their own copies.
 */
export const BUILTIN_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: "builtin-opengauss-ddl",
    name: "openGauss 建表规范",
    content: [
      "当生成 openGauss 建表语句时遵守以下规范：",
      "- 使用 DISTRIBUTE BY HASH(主键或常用查询列) 指定分布键",
      "- 大表使用 RANGE/LIST 分区；按时间范围分区的表可用 INTERVAL 分区",
      "- 明确存储引擎：默认 ustore（并发更好），普通分析表可用 astore；列存表用 COLUMN 关键字",
      "- 列存表不支持 UPDATE/DELETE，有更新需求的表必须用行存",
      "- 字段类型优先 openGauss 原生类型（numeric、varchar(n)、timestamp with time zone）",
      "- 表名/字段名统一小写下划线命名，必要时用 COMMENT ON 补充中文注释",
    ].join("\n"),
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    builtin: true,
  },
  {
    id: "builtin-opengauss-plsql",
    name: "openGauss PL/SQL 开发规范",
    content: [
      "当生成或修改 openGauss PL/SQL 代码时遵守以下规范：",
      "- 目标为 A 兼容模式（Oracle 风格）：CREATE OR REPLACE PROCEDURE/FUNCTION/PACKAGE + BEGIN...END 块",
      "- 变量声明用 %TYPE/%ROWTYPE；显式游标用 CURSOR...FOR 或 OPEN/FETCH/CLOSE",
      "- 异常处理用 EXCEPTION WHEN ... THEN，兜底用 WHEN OTHERS THEN",
      "- Oracle 的 DBMS_* 包在 openGauss 中为 gms_*（gms_output/gms_sql/gms_utility/gms_stats）",
      "- OUT 参数必须指定长度（如 VARCHAR2(100)），避免隐式类型转换",
      "- 函数用 RETURN 返回；过程用 OUT 参数或 gms_output.put_line 输出",
    ].join("\n"),
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    builtin: true,
  },
  {
    id: "builtin-opengauss-perf",
    name: "openGauss SQL 性能优化",
    content: [
      "当优化 openGauss SQL 时遵守以下规范：",
      "- 优先利用 Schema 上下文中的索引信息；缺索引时建议 CREATE INDEX，不要直接改表结构",
      "- 避免 WHERE 中对索引列使用函数或隐式转换（如 to_char(ts) = '...' 应改为范围比较）",
      "- 分页用 LIMIT/OFFSET；深分页建议改为基于主键的游标分页",
      "- 大表关联确保连接列有索引，避免笛卡尔积；必要时提示调整分布键",
      "- 用 EXPLAIN ANALYZE 验证：关注 Seq Scan 全表扫描、Hash Join 内存占用",
      "- 写操作尽量批量（多行 INSERT / MERGE），避免逐行提交",
    ].join("\n"),
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    builtin: true,
  },
  {
    id: "builtin-oracle-migration",
    name: "Oracle 迁移 openGauss",
    content: [
      "当把 Oracle SQL/PL/SQL 迁移到 openGauss 时遵守以下规范：",
      "- ROWNUM → LIMIT；SYSDATE → current_timestamp（A 模式仍可用 sysdate）",
      "- NVL 在 A 模式兼容；跨模式建议用 COALESCE；DECODE 可用但 CASE WHEN 更通用",
      "- 字符串拼接 || 在 A 模式可用；B 模式用 CONCAT",
      "- DBMS_OUTPUT.PUT_LINE → gms_output.put_line；DBMS_SQL → gms_sql",
      "- 存储过程/游标/异常语法与 Oracle 基本一致，注意 OUT 参数需指定长度",
      "- DUAL 在 A 模式可用；序列 NEXTVAL 语法一致",
      "- 存储与分布不同：openGauss 用 DISTRIBUTE BY HASH + ustore/astore，无表空间概念",
    ].join("\n"),
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    builtin: true,
  },
];

export const usePromptTemplateStore = defineStore("promptTemplate", () => {
  const templates = ref<PromptTemplate[]>([]);
  const globalInstructions = ref("");
  const isLoaded = ref(false);
  const isLoading = ref(false);
  let loadPromise: Promise<boolean> | null = null;

  async function init(): Promise<boolean> {
    if (isLoaded.value) return true;
    if (loadPromise) return loadPromise;
    isLoading.value = true;
    loadPromise = (async () => {
      try {
        const [tpls, gi] = await Promise.all([api.loadPromptTemplates(), api.getAiGlobalCustomInstructions()]);
        templates.value = [...BUILTIN_PROMPT_TEMPLATES, ...tpls];
        globalInstructions.value = gi;
        isLoaded.value = true;
        return true;
      } catch {
        // Keep failed initialization retryable, but do not let callers send
        // AI requests with an incomplete global-instructions context.
        return false;
      } finally {
        isLoading.value = false;
        loadPromise = null;
      }
    })();
    return loadPromise;
  }

  /** Return whether prompt data is ready; failed initialization remains retryable. */
  async function ensureLoaded(): Promise<boolean> {
    return init();
  }

  async function save(id: string, name: string, content: string): Promise<PromptTemplate> {
    const saved = await api.savePromptTemplate(id, name, content);
    const idx = templates.value.findIndex((t) => t.id === id);
    if (idx >= 0) {
      templates.value[idx] = saved;
    } else {
      templates.value.push(saved);
    }
    // Maintain stable sort order: created_at, then id
    templates.value = [...templates.value].sort(sortTemplates);
    return saved;
  }

  async function remove(id: string): Promise<void> {
    const existing = templates.value.find((t) => t.id === id);
    // Built-in templates are session-local seeds; dropping them only hides them for this session.
    if (!existing?.builtin) {
      await api.deletePromptTemplate(id);
    }
    templates.value = templates.value.filter((t) => t.id !== id);
  }

  async function saveGlobalInstructions(content: string): Promise<void> {
    const trimmed = content.trim();
    await api.setAiGlobalCustomInstructions(trimmed);
    globalInstructions.value = trimmed;
  }

  return { templates, globalInstructions, isLoaded, isLoading, init, ensureLoaded, save, remove, saveGlobalInstructions };
});

function sortTemplates(a: PromptTemplate, b: PromptTemplate): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}
